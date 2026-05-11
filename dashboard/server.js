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
        'exec', cfg.pod, '-n', cfg.namespace ?? 'lk-gsd',
        '-c', cfg.container ?? 'gsd', '--',
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
    '-p', String(port), '-W',
    '-t', `fontSize=${terminalPrefs.fontSize}`,
    '-t', `fontFamily=${terminalPrefs.fontFamily}`,
    shell
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

// ─── Terminal preferences ─────────────────────────────────────────────────────
// Stored in memory; persisted to terminal-prefs.json alongside instances.json

const PREFS_FILE = resolve(__dir, 'terminal-prefs.json')

function loadPrefs() {
  try {
    if (existsSync(PREFS_FILE)) return JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
  } catch {}
  return {}
}

function savePrefs() {
  writeFileSync(PREFS_FILE, JSON.stringify(terminalPrefs, null, 2) + '\n')
}

const terminalPrefs = loadPrefs()
// Defaults
if (!terminalPrefs.fontSize)   terminalPrefs.fontSize   = 14
if (!terminalPrefs.fontFamily) terminalPrefs.fontFamily = 'Menlo, monospace'

/**
 * GET /api/terminal-prefs
 * Returns current terminal preferences.
 */
app.get('/api/terminal-prefs', (req, res) => {
  res.json(terminalPrefs)
})

/**
 * POST /api/terminal-prefs
 * Body: { fontSize?, fontFamily? }
 * Updates prefs, restarts affected ttyd processes, saves to disk.
 */
app.post('/api/terminal-prefs', (req, res) => {
  const { fontSize, fontFamily } = req.body ?? {}
  let changed = false

  if (fontSize && Number.isInteger(fontSize) && fontSize >= 8 && fontSize <= 32) {
    terminalPrefs.fontSize = fontSize
    changed = true
  }
  if (fontFamily && typeof fontFamily === 'string') {
    terminalPrefs.fontFamily = fontFamily
    changed = true
  }

  if (!changed) return res.status(400).json({ error: 'no valid fields' })

  savePrefs()

  // Restart all running ttyd processes so new prefs take effect
  for (const [name, entry] of ttydProcs.entries()) {
    const cfg = instanceConfigs.find(i => i.name === name)
    if (!cfg || cfg.pod) continue  // pod ttyd not managed by us
    try { entry.proc.kill() } catch {}
    ttydProcs.delete(name)
    console.log(`[ttyd] restarted ${name} with new prefs`)
  }

  res.json({ ok: true, prefs: terminalPrefs })
})


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
  setTimeout(() => res.json({ sessions, defaultSession, port, type, prefs: terminalPrefs }), cfg.pod ? 400 : 100)
})

/**
 * POST /api/terminal/:name/session
 * Body: { sessionName }
 * Creates a new tmux session on the instance (pod or local).
 */
app.post('/api/terminal/:name/session', (req, res) => {
  const cfg = instanceConfigs.find(i => i.name === req.params.name)
  if (!cfg) return res.status(404).json({ error: 'instance not found' })

  const { sessionName } = req.body ?? {}
  if (!sessionName || typeof sessionName !== 'string' || !/^[\w\-]+$/.test(sessionName)) {
    return res.status(400).json({ error: 'sessionName must be alphanumeric/dash/underscore' })
  }

  try {
    if (cfg.pod) {
      const ns      = cfg.namespace ?? 'lk-gsd'
      const ctr     = cfg.container ?? 'gsd'
      const workDir = cfg.gsdPath ? cfg.gsdPath.replace('/.gsd', '') : '/home/gsd/workspace'
      execFileSync(KUBECTL, [
        'exec', cfg.pod, '-n', ns, '-c', ctr, '--',
        'tmux', 'new-session', '-d', '-s', sessionName, '-c', workDir
      ], { encoding: 'utf8', timeout: 8000 })
    } else {
      const workDir = cfg.localPath.replace('/.gsd', '')
      execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', workDir],
        { encoding: 'utf8', timeout: 5000 })
    }
    console.log(`[server] created tmux session '${sessionName}' on ${cfg.name}`)
    res.json({ ok: true, sessionName })
  } catch (err) {
    // "duplicate session" is OK — session already exists
    if (err.message?.includes('duplicate') || err.stderr?.includes('duplicate')) {
      return res.json({ ok: true, sessionName, existed: true })
    }
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /terminal-page/:name?session=<name>
 * Serves a full-page ttyd iframe — designed to be opened in a new browser tab.
 */
app.get('/terminal-page/:name', (req, res) => {
  const cfg = instanceConfigs.find(i => i.name === req.params.name)
  if (!cfg) return res.status(404).send('Instance not found')

  const sessionName = req.query.session ?? cfg.tmuxSession ?? 'gsd'
  const type        = cfg.pod ? 'pod' : 'local'

  let port
  try {
    port = ensureTtyd(cfg)
  } catch (err) {
    return res.status(500).send(`Failed to start terminal: ${err.message}`)
  }

  const ttydUrl = type === 'local'
    ? `http://localhost:${port}/`
    : `http://localhost:${port}/?arg=${encodeURIComponent(sessionName)}`

  const title    = `${cfg.name} — ${sessionName}`
  const instName = cfg.name
  const fontSize  = terminalPrefs.fontSize
  const fontFam   = terminalPrefs.fontFamily

  setTimeout(() => {
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>${title}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box }
    html, body { height:100%; background:#0d1117; overflow:hidden; display:flex; flex-direction:column }
    #bar {
      height:36px; display:flex; align-items:center; gap:10px;
      padding:0 14px; background:#161b22;
      border-bottom:1px solid #2e3349; flex-shrink:0;
    }
    #bar-dot { width:8px; height:8px; border-radius:50%; background:#22c55e; flex-shrink:0 }
    #bar-title { font-family:-apple-system,sans-serif; font-size:12px; color:#e2e8f0; font-weight:500 }
    #bar-session { font-family:'SF Mono','Fira Code',monospace; font-size:11px;
      color:#22c55e; background:#0a2a1e; border-radius:4px; padding:1px 7px }
    #bar-spacer { flex:1 }
    #settings-btn {
      background:none; border:1px solid #2e3349; border-radius:4px;
      color:#64748b; font-size:13px; padding:3px 8px; cursor:pointer;
      transition:border-color .15s, color .15s;
    }
    #settings-btn:hover { border-color:#6366f1; color:#e2e8f0 }
    #settings-panel {
      display:none; position:absolute; top:40px; right:12px;
      background:#1a1d27; border:1px solid #2e3349; border-radius:8px;
      padding:16px; width:260px; z-index:100;
      box-shadow:0 8px 24px rgba(0,0,0,.5);
    }
    #settings-panel.open { display:block }
    .sp-title { font-size:11px; font-weight:600; color:#64748b;
      letter-spacing:.06em; text-transform:uppercase; margin-bottom:12px }
    .sp-row { display:flex; align-items:center; gap:10px; margin-bottom:10px }
    .sp-label { font-size:12px; color:#e2e8f0; min-width:80px }
    .sp-input {
      flex:1; background:#22263a; border:1px solid #2e3349; border-radius:4px;
      color:#e2e8f0; font-size:12px; padding:4px 8px; outline:none;
      transition:border-color .15s;
    }
    .sp-input:focus { border-color:#6366f1 }
    .sp-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:4px }
    .sp-apply {
      background:#6366f1; border:none; border-radius:4px;
      color:#fff; font-size:12px; font-weight:500; padding:5px 12px; cursor:pointer;
    }
    .sp-apply:hover { opacity:.85 }
    .sp-cancel {
      background:none; border:1px solid #2e3349; border-radius:4px;
      color:#64748b; font-size:12px; padding:5px 12px; cursor:pointer;
    }
    iframe { flex:1; border:none; width:100% }
  </style>
</head>
<body>
  <div id="bar">
    <span id="bar-dot"></span>
    <span id="bar-title">${instName}</span>
    <span id="bar-session">${sessionName}</span>
    <span id="bar-spacer"></span>
    <button id="settings-btn" onclick="toggleSettings(event)" title="Terminal settings">⚙</button>
  </div>
  <div id="settings-panel">
    <div class="sp-title">Terminal settings</div>
    <div class="sp-row">
      <span class="sp-label">Font size</span>
      <input class="sp-input" id="sp-fontsize" type="number" min="8" max="32" value="${fontSize}"/>
    </div>
    <div class="sp-row">
      <span class="sp-label">Font family</span>
      <input class="sp-input" id="sp-fontfamily" type="text" value="${fontFam}"/>
    </div>
    <div class="sp-actions">
      <button class="sp-cancel" onclick="closeSettings()">Cancel</button>
      <button class="sp-apply" onclick="applySettings()">Apply &amp; restart</button>
    </div>
  </div>
  <iframe id="ttyd-frame" src="${ttydUrl}" allow="clipboard-read; clipboard-write"></iframe>
  <script>
    function toggleSettings(e) {
      e.stopPropagation()
      document.getElementById('settings-panel').classList.toggle('open')
    }
    function closeSettings() {
      document.getElementById('settings-panel').classList.remove('open')
    }
    document.addEventListener('click', closeSettings)
    document.getElementById('settings-panel').addEventListener('click', e => e.stopPropagation())

    async function applySettings() {
      const fontSize   = parseInt(document.getElementById('sp-fontsize').value)
      const fontFamily = document.getElementById('sp-fontfamily').value.trim()
      if (!fontSize || fontSize < 8 || fontSize > 32) {
        alert('Font size must be 8–32'); return
      }
      const res  = await fetch('/api/terminal-prefs', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ fontSize, fontFamily })
      })
      const data = await res.json()
      if (!res.ok) { alert(data.error); return }
      closeSettings()
      // Reload the iframe so ttyd restarts with new font
      const frame = document.getElementById('ttyd-frame')
      frame.src = frame.src
    }
  </script>
</body>
</html>`)
  }, cfg.pod ? 500 : 100)
})

// ─── Start ────────────────────────────────────────────────────────────────────

const httpServer = createServer(app)
httpServer.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`)
})
