/**
 * server.js — Express backend for the GSD Control Plane.
 *
 * GET    /api/instances         — enriched state for all instances
 * POST   /api/instances         — register a new local instance
 * DELETE /api/instances/:name   — remove an instance
 * GET    /api/health            — instance health summary
 * GET    /api/terminal/:name    — list tmux sessions + ttyd port
 *
 * Terminal architecture:
 *   Pod instances   → ttyd on pod:7681, kubectl port-forward → localhost:<port>
 *   Local instances → ttyd spawned locally → localhost:<port>
 *                     tmux session created in project dir if none exists
 */

import express from 'express'
import cors from 'cors'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execFileSync, spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'http'
import { readInstance } from './reader.js'
import { deriveInstance } from './derive.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const KUBECTL        = '/opt/homebrew/bin/kubectl'
const TTYD           = '/opt/homebrew/bin/ttyd'
const PORT           = parseInt(process.env.PORT ?? '3001', 10)
const POLL_MS        = parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10)
const INSTANCES_FILE = resolve(process.env.INSTANCES_FILE ?? resolve(__dir, 'instances.json'))

// ─── Instance config management ──────────────────────────────────────────────

function loadInstances() {
  if (!existsSync(INSTANCES_FILE)) {
    console.error(`[server] instances.json not found at ${INSTANCES_FILE}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(INSTANCES_FILE, 'utf8'))
}

function saveInstances() {
  writeFileSync(INSTANCES_FILE, JSON.stringify(instanceConfigs, null, 2) + '\n')
}

// Live mutable array — POST/DELETE modify this and persist to disk
const instanceConfigs = loadInstances()
console.log(`[server] Loaded ${instanceConfigs.length} instance(s):`, instanceConfigs.map(i => i.name))

// ─── tmux session discovery ───────────────────────────────────────────────────

function listTmuxSessions(cfg) {
  try {
    const fmt = '#{session_name}|#{session_windows}|#{?session_attached,1,0}'
    let out
    if (cfg.pod) {
      out = execFileSync(KUBECTL, [
        'exec', cfg.pod, '-n', cfg.namespace ?? 'lk-gsd', '--',
        'tmux', 'list-sessions', '-F', fmt
      ], { encoding: 'utf8', timeout: 5000 })
    } else {
      out = execFileSync('tmux', ['list-sessions', '-F', fmt],
        { encoding: 'utf8', timeout: 5000 })
    }
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [name, windows, attached] = line.split('|')
      return { name, windows: parseInt(windows), attached: attached === '1' }
    })
  } catch {
    return []
  }
}

// ─── ttyd / port-forward management ──────────────────────────────────────────
// One process per instance (pod: kubectl port-forward; local: ttyd directly).

const ttydProcs = new Map() // instanceName → { proc, port }
let nextPort = 7700

// Wrapper script path — written once, reused by all local ttyd instances
const ATTACH_SCRIPT = '/tmp/gsd-tmux-attach.sh'

function ensureAttachScript() {
  if (!existsSync(ATTACH_SCRIPT)) {
    writeFileSync(ATTACH_SCRIPT, '#!/bin/bash\nexec tmux attach -t "$@"\n', { mode: 0o755 })
    console.log(`[ttyd] wrote attach script to ${ATTACH_SCRIPT}`)
  }
}

function ensureTtyd(cfg) {
  const existing = ttydProcs.get(cfg.name)
  if (existing && existing.proc.exitCode === null) return existing.port

  const port = nextPort++

  if (cfg.pod) {
    // Pod: kubectl port-forward to ttyd already running on pod:7681
    console.log(`[pf] ${cfg.name} → localhost:${port}:7681`)
    const proc = spawn(KUBECTL, [
      'port-forward', `pod/${cfg.pod}`, '-n', cfg.namespace ?? 'lk-gsd',
      `${port}:7681`
    ], { stdio: 'pipe' })
    proc.on('exit', code => {
      console.log(`[pf] ${cfg.name} exited code=${code}`)
      ttydProcs.delete(cfg.name)
    })
    ttydProcs.set(cfg.name, { proc, port })
    return port
  }

  // Local: start ttyd with a shell in the project dir — no tmux needed
  const workDir = cfg.localPath.replace('/.gsd', '')
  console.log(`[ttyd] local ${cfg.name} → localhost:${port}`)
  const shell = process.env.SHELL || '/bin/zsh'
  const proc  = spawn(TTYD, [
    '-p', String(port), '-W', shell
  ], { stdio: 'pipe', cwd: workDir })

  proc.stderr?.on('data', d => {
    if (process.env.DEBUG) process.stderr.write(`[ttyd:${cfg.name}] ${d}`)
  })
  proc.on('exit', code => {
    console.log(`[ttyd] ${cfg.name} exited code=${code}`)
    ttydProcs.delete(cfg.name)
  })

  ttydProcs.set(cfg.name, { proc, port })
  return port
}

// Clean up on exit
process.on('exit', () => {
  for (const { proc } of ttydProcs.values()) try { proc.kill() } catch {}
})

// ─── State cache + polling ────────────────────────────────────────────────────

const cache = new Map()

async function pollInstance(config) {
  const start = Date.now()
  try {
    const raw      = await readInstance(config)
    const enriched = deriveInstance(raw)
    const pollMs   = Date.now() - start
    cache.set(config.name, { state: enriched, updatedAt: new Date().toISOString(), pollMs, error: enriched.error ?? null })
    if (process.env.DEBUG) console.log(`[server] ${config.name} poll=ok ms=${pollMs}`)
  } catch (err) {
    const pollMs = Date.now() - start
    const prev   = cache.get(config.name)
    cache.set(config.name, { state: prev?.state ?? null, updatedAt: prev?.updatedAt ?? null, pollMs, error: err.message, stale: true })
    console.error(`[server] ${config.name} poll=error ms=${pollMs}`, err.message)
  }
}

async function pollAll() { await Promise.all(instanceConfigs.map(pollInstance)) }

await pollAll()
const pollTimer = setInterval(pollAll, POLL_MS)
console.log(`[server] Polling ${instanceConfigs.length} instance(s) every ${POLL_MS}ms`)

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(resolve(__dir, 'public')))

// GET /api/instances
app.get('/api/instances', (req, res) => {
  const instances = instanceConfigs.map(cfg => {
    const entry = cache.get(cfg.name)
    return {
      name:            cfg.name,
      vscodeTunnelUrl: cfg.vscodeTunnelUrl ?? null,
      tmuxSession:     cfg.tmuxSession ?? null,
      localPath:       cfg.localPath ?? null,
      pod:             cfg.pod ?? null,
      updatedAt:       entry?.updatedAt ?? null,
      pollMs:          entry?.pollMs ?? null,
      stale:           entry?.stale ?? !entry,
      error:           entry?.error ?? null,
      ...(entry?.state ?? {})
    }
  })
  res.json({ instances, serverTime: new Date().toISOString() })
})

/**
 * POST /api/instances
 * Body: { name, localPath }
 * Validates that <localPath>/.gsd exists, adds to instances.json, starts polling.
 */
app.post('/api/instances', async (req, res) => {
  const { name, localPath } = req.body ?? {}

  if (!name || typeof name !== 'string' || !/^[\w\-]+$/.test(name)) {
    return res.status(400).json({ error: 'name must be non-empty alphanumeric/dash/underscore' })
  }
  if (!localPath || typeof localPath !== 'string') {
    return res.status(400).json({ error: 'localPath is required' })
  }

  const absPath = resolve(localPath)  // normalise ~ etc. won't expand but resolve cleans ..
  const gsdPath = absPath.endsWith('/.gsd') ? absPath : `${absPath}/.gsd`
  const workDir = gsdPath.replace('/.gsd', '')

  if (!existsSync(gsdPath)) {
    return res.status(400).json({ error: `No .gsd directory found at ${gsdPath} — is this a GSD project?` })
  }

  if (instanceConfigs.some(i => i.name === name)) {
    return res.status(409).json({ error: `Instance '${name}' already exists` })
  }

  const cfg = { name, localPath: gsdPath }
  instanceConfigs.push(cfg)
  saveInstances()

  // Start polling immediately
  await pollInstance(cfg)

  console.log(`[server] registered local instance '${name}' at ${gsdPath}`)
  res.status(201).json({ ok: true, name, localPath: gsdPath })
})

/**
 * DELETE /api/instances/:name
 * Removes from instances.json and stops any associated ttyd/port-forward.
 */
app.delete('/api/instances/:name', (req, res) => {
  const idx = instanceConfigs.findIndex(i => i.name === req.params.name)
  if (idx === -1) return res.status(404).json({ error: 'instance not found' })

  instanceConfigs.splice(idx, 1)
  saveInstances()
  cache.delete(req.params.name)

  // Kill any running ttyd/port-forward for this instance
  const pf = ttydProcs.get(req.params.name)
  if (pf) { try { pf.proc.kill() } catch {} ttydProcs.delete(req.params.name) }

  console.log(`[server] removed instance '${req.params.name}'`)
  res.json({ ok: true })
})

// GET /api/health
app.get('/api/health', (req, res) => {
  const instances = instanceConfigs.map(cfg => {
    const entry = cache.get(cfg.name)
    const ms    = entry?.state?.milestones ?? []
    return {
      name: cfg.name, ok: !entry?.error && !entry?.stale,
      stale: entry?.stale ?? false, error: entry?.error ?? null,
      updatedAt: entry?.updatedAt ?? null, pollMs: entry?.pollMs ?? null,
      milestones: ms.length,
      attention:  ms.filter(m => m.attention && m.attention !== 'Healthy').length
    }
  })
  res.json({ ok: instances.every(i => i.ok), instances })
})

/**
 * GET /api/terminal/:name
 * Returns { sessions, defaultSession, port, type }
 * Starts ttyd/port-forward on demand.
 */
app.get('/api/terminal/:name', (req, res) => {
  const cfg = instanceConfigs.find(i => i.name === req.params.name)
  if (!cfg) return res.status(404).json({ error: 'instance not found' })

  const sessions       = listTmuxSessions(cfg)
  const defaultSession = cfg.tmuxSession ?? sessions[0]?.name ?? 'gsd'
  const type           = cfg.pod ? 'pod' : 'local'

  let port
  try {
    port = ensureTtyd(cfg)
  } catch (err) {
    return res.status(500).json({ error: `ttyd start failed: ${err.message}` })
  }

  // Give port-forward a moment to bind before browser connects
  setTimeout(() => res.json({ sessions, defaultSession, port, type }), cfg.pod ? 400 : 100)
})

// ─── Start ────────────────────────────────────────────────────────────────────

const httpServer = createServer(app)
httpServer.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`)
})
