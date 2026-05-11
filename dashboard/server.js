/**
 * server.js — Express backend for the GSD Control Plane POC.
 *
 * GET  /api/instances           — enriched state for all configured instances
 * GET  /api/health              — instance health summary
 * GET  /api/terminal/:name      — list tmux sessions + local port for ttyd
 * POST /api/terminal/:name/pf   — ensure port-forward is running, return port
 *
 * Terminal architecture:
 *   Pod instances  → ttyd runs on pod:7681 (started once via kubectl exec)
 *                    kubectl port-forward exposes it as localhost:<port>
 *                    browser iframes http://localhost:<port>/?arg=<session>
 *   Local instances → ttyd started locally against local tmux session
 */

import express from 'express'
import cors from 'cors'
import { readFileSync, existsSync } from 'fs'
import { execFileSync, spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'http'
import { readInstance } from './reader.js'
import { deriveInstance } from './derive.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const KUBECTL        = '/opt/homebrew/bin/kubectl'
const PORT           = parseInt(process.env.PORT ?? '3001', 10)
const POLL_MS        = parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10)
const INSTANCES_FILE = resolve(process.env.INSTANCES_FILE ?? resolve(__dir, 'instances.json'))

// ─── Load instance configs ────────────────────────────────────────────────────

function loadInstances() {
  if (!existsSync(INSTANCES_FILE)) {
    console.error(`[server] instances.json not found at ${INSTANCES_FILE}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(INSTANCES_FILE, 'utf8'))
}

const instanceConfigs = loadInstances()
console.log(`[server] Loaded ${instanceConfigs.length} instance(s):`, instanceConfigs.map(i => i.name))

// ─── tmux session discovery ───────────────────────────────────────────────────

// Returns [{ name, windows, attached }]
function listTmuxSessions(cfg) {
  try {
    let out
    const fmt = '#{session_name}|#{session_windows}|#{?session_attached,1,0}'
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

// ─── Port-forward management ─────────────────────────────────────────────────
// One port-forward process per pod instance. Reused across requests.

const portForwards = new Map() // instanceName → { proc, port }
let nextPort = 7700

function ensurePortForward(cfg) {
  const existing = portForwards.get(cfg.name)
  if (existing && existing.proc.exitCode === null) {
    return existing.port
  }

  const port = nextPort++
  console.log(`[pf] starting port-forward for ${cfg.name} → localhost:${port}:7681`)

  const proc = spawn(KUBECTL, [
    'port-forward', `pod/${cfg.pod}`, '-n', cfg.namespace ?? 'lk-gsd',
    `${port}:7681`
  ], { stdio: 'pipe' })

  proc.on('exit', (code) => {
    console.log(`[pf] ${cfg.name} port-forward exited code=${code}`)
    portForwards.delete(cfg.name)
  })

  portForwards.set(cfg.name, { proc, port })
  return port
}

// Clean up port-forwards on exit
process.on('exit', () => {
  for (const { proc } of portForwards.values()) {
    try { proc.kill() } catch {}
  }
})

// ─── State cache ─────────────────────────────────────────────────────────────

const cache = new Map()

async function pollInstance(config) {
  const start = Date.now()
  try {
    const raw      = await readInstance(config)
    const enriched = deriveInstance(raw)
    const pollMs   = Date.now() - start
    cache.set(config.name, { state: enriched, updatedAt: new Date().toISOString(), pollMs, error: enriched.error ?? null })
    console.log(`[server] ${config.name} poll=${enriched.error ? 'error' : 'ok'} ms=${pollMs}`)
  } catch (err) {
    const pollMs = Date.now() - start
    const prev   = cache.get(config.name)
    cache.set(config.name, { state: prev?.state ?? null, updatedAt: prev?.updatedAt ?? null, pollMs, error: err.message, stale: true })
    console.error(`[server] ${config.name} poll=error ms=${pollMs}`, err.message)
  }
}

async function pollAll() { await Promise.all(instanceConfigs.map(pollInstance)) }

await pollAll()
setInterval(pollAll, POLL_MS)
console.log(`[server] Polling every ${POLL_MS}ms`)

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(resolve(__dir, 'public')))

app.get('/api/instances', (req, res) => {
  const instances = instanceConfigs.map(cfg => {
    const entry = cache.get(cfg.name)
    return {
      name:            cfg.name,
      vscodeTunnelUrl: cfg.vscodeTunnelUrl ?? null,
      tmuxSession:     cfg.tmuxSession ?? null,
      updatedAt:       entry?.updatedAt ?? null,
      pollMs:          entry?.pollMs ?? null,
      stale:           entry?.stale ?? !entry,
      error:           entry?.error ?? null,
      ...(entry?.state ?? {})
    }
  })
  res.json({ instances, serverTime: new Date().toISOString() })
})

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
 * Returns tmux sessions and the ttyd port (starts port-forward if needed).
 * { sessions: [{name, windows, attached}], port, defaultSession }
 */
app.get('/api/terminal/:name', (req, res) => {
  const cfg = instanceConfigs.find(i => i.name === req.params.name)
  if (!cfg) return res.status(404).json({ error: 'instance not found' })

  const sessions       = listTmuxSessions(cfg)
  const defaultSession = cfg.tmuxSession ?? sessions[0]?.name ?? 'gsd'

  if (cfg.pod) {
    // Ensure port-forward is running and return the local port
    let port
    try {
      port = ensurePortForward(cfg)
    } catch (err) {
      return res.status(500).json({ error: `port-forward failed: ${err.message}` })
    }
    res.json({ sessions, defaultSession, port, type: 'pod' })
  } else {
    // Local — ttyd not yet supported for local; fall back gracefully
    res.json({ sessions, defaultSession, port: null, type: 'local' })
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

const httpServer = createServer(app)
httpServer.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`)
})
