/**
 * server.js — Express backend for the GSD Control Plane.
 *
 * GET    /api/instances              — enriched state for all instances
 * POST   /api/instances              — register a new local instance
 * DELETE /api/instances/:name        — remove an instance
 * GET    /api/health                 — instance health summary
 * GET    /api/terminal/:name         — list tmux sessions + ttyd port
 * POST   /api/terminal/:name/session — create a named tmux session
 * GET    /api/terminal-prefs         — read terminal preferences
 * POST   /api/terminal-prefs        — update terminal preferences (restarts ttyd)
 * GET    /terminal-page/:name        — full-page terminal HTML (new tab)
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
const PREFS_FILE     = resolve(__dir, 'terminal-prefs.json')

// ─── Terminal preferences ─────────────────────────────────────────────────────

function loadPrefs() {
  try { if (existsSync(PREFS_FILE)) return JSON.parse(readFileSync(PREFS_FILE, 'utf8')) } catch {}
  return {}
}
function savePrefs() { writeFileSync(PREFS_FILE, JSON.stringify(terminalPrefs, null, 2) + '\n') }

const terminalPrefs = loadPrefs()
if (!terminalPrefs.fontSize)   terminalPrefs.fontSize   = 14
if (!terminalPrefs.fontFamily) terminalPrefs.fontFamily = 'Menlo, monospace'
if (!terminalPrefs.cols)       terminalPrefs.cols       = 0   // 0 = auto-fit

// Build the ttyd command string for pod restarts (shell-quoted for bash -c)
function buildTtydCmd() {
  const parts = [
    'ttyd', '-p', '7681', '-W', '-a',
    '-t', `fontSize=${terminalPrefs.fontSize}`,
    '-t', `fontFamily=${terminalPrefs.fontFamily}`,
    '-t', 'allowProposedApi=true',
    '/tmp/tmux-attach.sh'
  ]
  return parts.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
}

// ─── Instance config management ───────────────────────────────────────────────

function loadInstances() {
  if (!existsSync(INSTANCES_FILE)) { console.error(`[server] instances.json not found`); process.exit(1) }
  return JSON.parse(readFileSync(INSTANCES_FILE, 'utf8'))
}
function saveInstances() { writeFileSync(INSTANCES_FILE, JSON.stringify(instanceConfigs, null, 2) + '\n') }

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
      out = execFileSync('tmux', ['list-sessions', '-F', fmt], { encoding: 'utf8', timeout: 5000 })
    }
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [name, windows, attached] = line.split('|')
      return { name, windows: parseInt(windows), attached: attached === '1' }
    })
  } catch { return [] }
}

// ─── ttyd / port-forward management ──────────────────────────────────────────

const ttydProcs = new Map()  // instanceName → { proc, port }
let nextPort = 7700

function ensureTtyd(cfg) {
  const existing = ttydProcs.get(cfg.name)
  if (existing && existing.proc.exitCode === null) return existing.port

  const port = nextPort++

  if (cfg.pod) {
    console.log(`[pf] ${cfg.name} → localhost:${port}:7681`)
    const proc = spawn(KUBECTL, [
      'port-forward', `pod/${cfg.pod}`, '-n', cfg.namespace ?? 'lk-gsd', `${port}:7681`
    ], { stdio: 'pipe' })
    proc.on('exit', code => { console.log(`[pf] ${cfg.name} exited code=${code}`); ttydProcs.delete(cfg.name) })
    ttydProcs.set(cfg.name, { proc, port })
    return port
  }

  // Local: ttyd with a shell in the project dir
  const workDir = cfg.localPath.replace('/.gsd', '')
  console.log(`[ttyd] local ${cfg.name} → localhost:${port}`)
  const shell = process.env.SHELL || '/bin/zsh'
  const proc  = spawn(TTYD, [
    '-p', String(port), '-W',
    '-t', `fontSize=${terminalPrefs.fontSize}`,
    '-t', `fontFamily=${terminalPrefs.fontFamily}`,
    '-t', 'allowProposedApi=true',
    shell
  ], { stdio: 'pipe', cwd: workDir })
  proc.stderr?.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[ttyd:${cfg.name}] ${d}`) })
  proc.on('exit', code => { console.log(`[ttyd] ${cfg.name} exited code=${code}`); ttydProcs.delete(cfg.name) })
  ttydProcs.set(cfg.name, { proc, port })
  return port
}

process.on('exit', () => { for (const { proc } of ttydProcs.values()) try { proc.kill() } catch {} })

// ─── State cache + polling ────────────────────────────────────────────────────

const cache = new Map()

async function pollInstance(config) {
  const start = Date.now()
  try {
    const raw      = await readInstance(config)
    const enriched = deriveInstance(raw)
    const pollMs   = Date.now() - start
    cache.set(config.name, { state: enriched, updatedAt: new Date().toISOString(), pollMs, error: enriched.error ?? null })
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
console.log(`[server] Polling ${instanceConfigs.length} instance(s) every ${POLL_MS}ms`)

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(resolve(__dir, 'public')))

app.get('/api/instances', (req, res) => {
  const instances = instanceConfigs.map(cfg => {
    const entry = cache.get(cfg.name)
    return {
      name: cfg.name, vscodeTunnelUrl: cfg.vscodeTunnelUrl ?? null,
      tmuxSession: cfg.tmuxSession ?? null, localPath: cfg.localPath ?? null, pod: cfg.pod ?? null,
      updatedAt: entry?.updatedAt ?? null, pollMs: entry?.pollMs ?? null,
      stale: entry?.stale ?? !entry, error: entry?.error ?? null,
      ...(entry?.state ?? {})
    }
  })
  res.json({ instances, serverTime: new Date().toISOString() })
})

app.post('/api/instances', async (req, res) => {
  const { name, localPath } = req.body ?? {}
  if (!name || !/^[\w\-]+$/.test(name))
    return res.status(400).json({ error: 'name must be alphanumeric/dash/underscore' })
  if (!localPath)
    return res.status(400).json({ error: 'localPath is required' })

  const absPath = resolve(localPath)
  const gsdPath = absPath.endsWith('/.gsd') ? absPath : `${absPath}/.gsd`
  if (!existsSync(gsdPath))
    return res.status(400).json({ error: `No .gsd directory found at ${gsdPath}` })
  if (instanceConfigs.some(i => i.name === name))
    return res.status(409).json({ error: `Instance '${name}' already exists` })

  const cfg = { name, localPath: gsdPath }
  instanceConfigs.push(cfg)
  saveInstances()
  await pollInstance(cfg)
  console.log(`[server] registered '${name}' at ${gsdPath}`)
  res.status(201).json({ ok: true, name, localPath: gsdPath })
})

app.delete('/api/instances/:name', (req, res) => {
  const idx = instanceConfigs.findIndex(i => i.name === req.params.name)
  if (idx === -1) return res.status(404).json({ error: 'instance not found' })
  instanceConfigs.splice(idx, 1)
  saveInstances()
  cache.delete(req.params.name)
  const pf = ttydProcs.get(req.params.name)
  if (pf) { try { pf.proc.kill() } catch {} ttydProcs.delete(req.params.name) }
  console.log(`[server] removed instance '${req.params.name}'`)
  res.json({ ok: true })
})

app.get('/api/health', (req, res) => {
  const instances = instanceConfigs.map(cfg => {
    const entry = cache.get(cfg.name)
    const ms    = entry?.state?.milestones ?? []
    return {
      name: cfg.name, ok: !entry?.error && !entry?.stale, stale: entry?.stale ?? false,
      error: entry?.error ?? null, updatedAt: entry?.updatedAt ?? null, pollMs: entry?.pollMs ?? null,
      milestones: ms.length, attention: ms.filter(m => m.attention && m.attention !== 'Healthy').length
    }
  })
  res.json({ ok: instances.every(i => i.ok), instances })
})

app.get('/api/terminal-prefs', (req, res) => res.json(terminalPrefs))

app.post('/api/terminal-prefs', (req, res) => {
  const { fontSize, fontFamily, cols } = req.body ?? {}
  let changed = false
  if (Number.isInteger(fontSize) && fontSize >= 8 && fontSize <= 32) { terminalPrefs.fontSize = fontSize; changed = true }
  if (typeof fontFamily === 'string' && fontFamily.trim()) { terminalPrefs.fontFamily = fontFamily.trim(); changed = true }
  if (Number.isInteger(cols) && cols >= 0 && cols <= 500) { terminalPrefs.cols = cols; changed = true }
  if (!changed) return res.status(400).json({ error: 'no valid fields' })
  savePrefs()

  // Restart local ttyd processes
  for (const [name, entry] of ttydProcs.entries()) {
    const cfg = instanceConfigs.find(i => i.name === name)
    if (!cfg || cfg.pod) continue
    try { entry.proc.kill() } catch {}
    ttydProcs.delete(name)
  }

  // Restart pod ttyd processes with new prefs
  for (const cfg of instanceConfigs.filter(i => i.pod)) {
    try {
      const ns  = cfg.namespace ?? 'lk-gsd'
      const ctr = cfg.container ?? 'gsd'
      const cmd = `pkill ttyd 2>/dev/null; sleep 0.3; nohup ${buildTtydCmd()} > /tmp/ttyd.log 2>&1 &`
      execFileSync(KUBECTL, ['exec', cfg.pod, '-n', ns, '-c', ctr, '--', 'bash', '-c', cmd],
        { encoding: 'utf8', timeout: 8000 })
      const pf = ttydProcs.get(cfg.name)
      if (pf) { try { pf.proc.kill() } catch {} ttydProcs.delete(cfg.name) }
      console.log(`[ttyd] restarted pod ttyd for ${cfg.name}`)
    } catch (e) { console.warn(`[ttyd] pod restart failed for ${cfg.name}: ${e.message}`) }
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
  try { port = ensureTtyd(cfg) }
  catch (err) { return res.status(500).json({ error: `ttyd start failed: ${err.message}` }) }
  setTimeout(() => res.json({ sessions, defaultSession, port, type, prefs: terminalPrefs }),
    cfg.pod ? 400 : 100)
})

app.post('/api/terminal/:name/session', (req, res) => {
  const cfg = instanceConfigs.find(i => i.name === req.params.name)
  if (!cfg) return res.status(404).json({ error: 'instance not found' })
  const { sessionName } = req.body ?? {}
  if (!sessionName || !/^[\w\-]+$/.test(sessionName))
    return res.status(400).json({ error: 'sessionName must be alphanumeric/dash/underscore' })
  try {
    if (cfg.pod) {
      const ns  = cfg.namespace ?? 'lk-gsd', ctr = cfg.container ?? 'gsd'
      const dir = cfg.gsdPath ? cfg.gsdPath.replace('/.gsd', '') : '/home/gsd/workspace'
      execFileSync(KUBECTL, ['exec', cfg.pod, '-n', ns, '-c', ctr, '--',
        'tmux', 'new-session', '-d', '-s', sessionName, '-c', dir], { encoding: 'utf8', timeout: 8000 })
    } else {
      execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', cfg.localPath.replace('/.gsd', '')],
        { encoding: 'utf8', timeout: 5000 })
    }
    res.json({ ok: true, sessionName })
  } catch (err) {
    if (err.message?.includes('duplicate') || String(err.stderr ?? '').includes('duplicate'))
      return res.json({ ok: true, sessionName, existed: true })
    res.status(500).json({ error: err.message })
  }
})

// ─── Full-page terminal tab ───────────────────────────────────────────────────

app.get('/terminal-page/:name', (req, res) => {
  const cfg = instanceConfigs.find(i => i.name === req.params.name)
  if (!cfg) return res.status(404).send('Instance not found')

  const sessionName = req.query.session ?? cfg.tmuxSession ?? 'gsd'
  const type        = cfg.pod ? 'pod' : 'local'
  const title       = `${cfg.name} — ${sessionName}`

  // Start ttyd/port-forward now; the page will call /api/terminal/:name to get the live port
  try { ensureTtyd(cfg) } catch (err) { return res.status(500).send(`Failed to start terminal: ${err.message}`) }

  const instJson    = JSON.stringify(cfg.name)
  const sessionJson = JSON.stringify(sessionName)
  const isLocalJson = JSON.stringify(type === 'local')

  setTimeout(() => {
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>${title}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;background:#0d1117;overflow:hidden;display:flex;flex-direction:column}
    #bar{height:36px;display:flex;align-items:center;gap:10px;padding:0 14px;
      background:#161b22;border-bottom:1px solid #2e3349;flex-shrink:0;position:relative}
    #bar-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0}
    #bar-title{font-family:-apple-system,sans-serif;font-size:12px;color:#e2e8f0;font-weight:500}
    #bar-session{font-family:'SF Mono','Fira Code',monospace;font-size:11px;
      color:#22c55e;background:#0a2a1e;border-radius:4px;padding:1px 7px}
    #bar-spacer{flex:1}
    .bar-btn{background:none;border:1px solid #2e3349;border-radius:4px;
      color:#64748b;font-size:11px;padding:3px 8px;cursor:pointer;transition:border-color .15s,color .15s;white-space:nowrap}
    .bar-btn:hover{border-color:#6366f1;color:#e2e8f0}
    #settings-btn{font-size:13px}
    #settings-panel{display:none;position:absolute;top:40px;right:12px;
      background:#1a1d27;border:1px solid #2e3349;border-radius:8px;
      padding:16px;width:260px;z-index:100;box-shadow:0 8px 24px rgba(0,0,0,.5)}
    #settings-panel.open{display:block}
    .sp-title{font-size:11px;font-weight:600;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:12px}
    .sp-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
    .sp-label{font-size:12px;color:#e2e8f0;min-width:80px}
    .sp-input{flex:1;background:#22263a;border:1px solid #2e3349;border-radius:4px;
      color:#e2e8f0;font-size:12px;padding:4px 8px;outline:none;transition:border-color .15s}
    .sp-input:focus{border-color:#6366f1}
    .sp-hint{font-size:10px;color:#64748b;margin-top:-6px;margin-bottom:8px}
    .sp-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
    .sp-apply{background:#6366f1;border:none;border-radius:4px;color:#fff;font-size:12px;font-weight:500;padding:5px 12px;cursor:pointer}
    .sp-apply:hover{opacity:.85}
    .sp-cancel{background:none;border:1px solid #2e3349;border-radius:4px;color:#64748b;font-size:12px;padding:5px 12px;cursor:pointer}
    #frame-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden}
    iframe{flex:1;border:none;width:100%;height:100%;display:block}
  </style>
</head>
<body>
  <div id="bar">
    <span id="bar-dot"></span>
    <span id="bar-title">${cfg.name}</span>
    <span id="bar-session">${sessionName}</span>
    <span id="bar-spacer"></span>
    <button class="bar-btn" id="paste-btn" onclick="pasteFromClipboard()" title="Paste (Cmd+V)">⌘V Paste</button>
    <button class="bar-btn" id="settings-btn" onclick="toggleSettings(event)">⚙</button>
    <div id="settings-panel">
      <div class="sp-title">Terminal settings</div>
      <div class="sp-row"><span class="sp-label">Font size</span>
        <input class="sp-input" id="sp-fontsize" type="number" min="8" max="32"/></div>
      <div class="sp-row"><span class="sp-label">Font family</span>
        <input class="sp-input" id="sp-fontfamily" type="text"/></div>
      <div class="sp-row"><span class="sp-label">Cols width</span>
        <input class="sp-input" id="sp-cols" type="number" min="0" max="500"/></div>
      <div class="sp-hint">0 = fill window. Non-zero constrains terminal width.</div>
      <div class="sp-actions">
        <button class="sp-cancel" onclick="closeSettings()">Cancel</button>
        <button class="sp-apply" onclick="applySettings()">Apply &amp; restart</button>
      </div>
    </div>
  </div>
  <div id="frame-wrap">
    <iframe id="ttyd-frame" src="about:blank" allow="clipboard-read; clipboard-write"></iframe>
  </div>
  <script>
    const INST=${instJson}, SESSION=${sessionJson}, IS_LOCAL=${isLocalJson}

    // Direct WebSocket to ttyd for paste — bypasses iframe cross-origin clipboard restriction
    let ttydWs = null
    let ttydPort = null

    async function loadTerminal(){
      try{
        const res=await fetch('/api/terminal/'+encodeURIComponent(INST))
        const data=await res.json()
        if(data.error||!data.port){console.error('terminal error:',data.error);return}
        const prefs=data.prefs??{}, fs=prefs.fontSize??14, cols=prefs.cols??0
        document.getElementById('sp-fontsize').value=fs
        document.getElementById('sp-fontfamily').value=prefs.fontFamily??''
        document.getElementById('sp-cols').value=cols
        const wrap=document.getElementById('frame-wrap')
        if(cols>0){wrap.style.maxWidth=Math.round(cols*fs*0.61)+'px';wrap.style.margin='0 auto'}
        else{wrap.style.maxWidth='';wrap.style.margin=''}
        ttydPort=data.port
        const url=IS_LOCAL
          ?'http://localhost:'+data.port+'/'
          :'http://localhost:'+data.port+'/?arg='+encodeURIComponent(SESSION)
        document.getElementById('ttyd-frame').src=url
        // Connect our own WS for paste injection
        connectPasteWs(data.port)
      }catch(e){console.error('loadTerminal:',e)}
    }
    loadTerminal()

    // ── Paste WebSocket ───────────────────────────────────────────────────────
    // ttyd WS protocol: send binary frame where first byte is type
    //   type 0 = auth  { "AuthToken": "" }
    //   type 1 = input (keystrokes / paste data)

    function connectPasteWs(port){
      if(ttydWs){try{ttydWs.close()}catch{}}
      const ws=new WebSocket('ws://localhost:'+port+'/ws')
      ws.binaryType='arraybuffer'
      ws.onopen=()=>{
        // Auth handshake
        const auth=JSON.stringify({AuthToken:''})
        const msg=new Uint8Array(auth.length+1)
        msg[0]=0  // type=auth
        for(let i=0;i<auth.length;i++) msg[i+1]=auth.charCodeAt(i)
        ws.send(msg)
      }
      ws.onerror=e=>console.warn('[paste-ws] error',e)
      ws.onclose=()=>{ ttydWs=null }
      ttydWs=ws
    }

    function sendPaste(text){
      if(!ttydWs||ttydWs.readyState!==WebSocket.OPEN){
        if(ttydPort) connectPasteWs(ttydPort)
        setTimeout(()=>sendPaste(text),300)
        return
      }
      // Wrap in bracketed paste sequences so tmux/shell handles multi-line correctly
      const wrapped='\x1b[200~'+text+'\x1b[201~'
      const encoded=new TextEncoder().encode(wrapped)
      const msg=new Uint8Array(encoded.length+1)
      msg[0]=1  // type=input
      msg.set(encoded,1)
      ttydWs.send(msg)
    }

    async function pasteFromClipboard(){
      try{
        const text=await navigator.clipboard.readText()
        if(text) sendPaste(text)
      }catch(e){
        console.warn('[paste] clipboard read failed:',e.message)
        // Fallback: focus iframe and let user Cmd+V natively
        document.getElementById('ttyd-frame').focus()
        alert('Clipboard access denied. Click inside the terminal and use Cmd+V.')
      }
    }

    // Intercept Cmd+V in the outer page and route to paste function
    document.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&e.key==='v'){
        e.preventDefault()
        pasteFromClipboard()
      }
      if((e.metaKey||e.ctrlKey)&&e.key===','){
        e.preventDefault()
        toggleSettings(e)
      }
    })

    function toggleSettings(e){e.stopPropagation();document.getElementById('settings-panel').classList.toggle('open')}
    function closeSettings(){document.getElementById('settings-panel').classList.remove('open')}
    document.addEventListener('click',closeSettings)
    document.getElementById('settings-panel').addEventListener('click',e=>e.stopPropagation())

    async function applySettings(){
      const fontSize=parseInt(document.getElementById('sp-fontsize').value)
      const fontFamily=document.getElementById('sp-fontfamily').value.trim()
      const cols=parseInt(document.getElementById('sp-cols').value)||0
      if(!fontSize||fontSize<8||fontSize>32){alert('Font size must be 8–32');return}
      const res=await fetch('/api/terminal-prefs',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({fontSize,fontFamily,cols})
      })
      if(!res.ok){const d=await res.json();alert(d.error);return}
      closeSettings()
      setTimeout(loadTerminal,1200)
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
