/**
 * server.js — Express backend for the GSD Control Plane.
 *
 * GET    /api/instances              — enriched state for all instances
 * POST   /api/instances              — register a new local instance
 * DELETE /api/instances/:name        — remove an instance
 * GET    /api/health                 — instance health summary
 * GET    /api/events                 — SSE stream of real-time GSD journal events
 * GET    /api/terminal/:name         — list tmux sessions + ttyd port
 * POST   /api/terminal/:name/session — create a named tmux session
 * GET    /api/terminal-prefs         — read terminal preferences
 * POST   /api/terminal-prefs        — update terminal preferences (restarts ttyd)
 * GET    /api/vibe-cards             — read persisted Vibe Cards
 * POST   /api/vibe-cards             — create a persisted Vibe Card
 * PATCH  /api/vibe-cards/:id         — update a persisted Vibe Card
 * DELETE /api/vibe-cards/:id         — delete a persisted Vibe Card
 * GET    /terminal-page/:name        — full-page terminal HTML (new tab)
 *
 * Real-time architecture:
 *   pod: gsd-journal-watcher.py tails journal → PUBLISH gsd:events:<name> to Redis
 *   server: Redis SUBSCRIBE gsd:events:* → invalidate cache + push SSE to browser
 *   browser: EventSource /api/events → immediate re-poll on unit-start/unit-end
 */

import express from 'express'
import cors from 'cors'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execFileSync, spawn } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createServer } from 'http'
import Redis from 'ioredis'
import { readInstance } from './reader.js'
import { deriveInstance } from './derive.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const KUBECTL         = '/opt/homebrew/bin/kubectl'
const TTYD            = '/opt/homebrew/bin/ttyd'
const PORT            = parseInt(process.env.PORT ?? '3001', 10)
const POLL_MS         = parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10)
const INSTANCES_FILE  = resolve(process.env.INSTANCES_FILE ?? resolve(__dir, 'instances.json'))
const PREFS_FILE      = resolve(__dir, 'terminal-prefs.json')
const VIBE_CARDS_FILE = resolve(__dir, 'vibe-cards.json')

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

// ─── Vibe Card persistence ────────────────────────────────────────────────────

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeCardTimestamps(card, nowIso) {
  return {
    ...card,
    createdAt: typeof card.createdAt === 'string' && card.createdAt ? card.createdAt : nowIso,
    updatedAt: typeof card.updatedAt === 'string' && card.updatedAt ? card.updatedAt : nowIso
  }
}

function validateCardShape(card, { partial = false } = {}) {
  if (!isPlainObject(card)) return 'card must be an object'

  const allowedKeys = new Set(['id', 'title', 'description', 'status', 'lane', 'priority', 'tags', 'metadata', 'createdAt', 'updatedAt'])
  for (const key of Object.keys(card)) {
    if (!allowedKeys.has(key)) return `unexpected field '${key}'`
  }

  const requiredKeys = ['id', 'title']
  if (!partial) {
    for (const key of requiredKeys) {
      if (!(key in card)) return `${key} is required`
    }
  }

  if ('id' in card && (typeof card.id !== 'string' || !card.id.trim())) return 'id must be a non-empty string'
  if ('title' in card && (typeof card.title !== 'string' || !card.title.trim())) return 'title must be a non-empty string'
  if ('description' in card && card.description !== null && typeof card.description !== 'string') return 'description must be a string or null'
  if ('status' in card && card.status !== null && typeof card.status !== 'string') return 'status must be a string or null'
  if ('lane' in card && card.lane !== null && typeof card.lane !== 'string') return 'lane must be a string or null'
  if ('priority' in card && card.priority !== null && typeof card.priority !== 'string') return 'priority must be a string or null'
  if ('createdAt' in card && (typeof card.createdAt !== 'string' || !card.createdAt)) return 'createdAt must be a non-empty string'
  if ('updatedAt' in card && (typeof card.updatedAt !== 'string' || !card.updatedAt)) return 'updatedAt must be a non-empty string'

  if ('tags' in card) {
    if (!Array.isArray(card.tags) || !card.tags.every(tag => typeof tag === 'string')) {
      return 'tags must be an array of strings'
    }
  }

  if ('metadata' in card && card.metadata !== null && !isPlainObject(card.metadata)) {
    return 'metadata must be an object or null'
  }

  return null
}

function validateVibeCardsPayload(payload) {
  if (!isPlainObject(payload)) return { error: 'vibe-cards.json must contain an object payload' }
  if (!Array.isArray(payload.cards)) return { error: 'vibe-cards.json must contain a cards array' }

  const nowIso = new Date().toISOString()
  const normalizedCards = []
  const ids = new Set()

  for (const [index, rawCard] of payload.cards.entries()) {
    const error = validateCardShape(rawCard)
    if (error) return { error: `cards[${index}]: ${error}` }

    const card = normalizeCardTimestamps(rawCard, nowIso)
    const cardId = card.id.trim()
    if (ids.has(cardId)) return { error: `cards[${index}]: duplicate id '${cardId}'` }
    ids.add(cardId)

    normalizedCards.push({
      id: cardId,
      title: card.title.trim(),
      description: card.description ?? null,
      status: card.status ?? null,
      lane: card.lane ?? null,
      priority: card.priority ?? null,
      tags: card.tags ?? [],
      metadata: card.metadata ?? {},
      createdAt: card.createdAt,
      updatedAt: card.updatedAt
    })
  }

  return { cards: normalizedCards }
}

function createDefaultVibeCardsFile() {
  const payload = { cards: [] }
  writeFileSync(VIBE_CARDS_FILE, JSON.stringify(payload, null, 2) + '\n')
  console.log(`[vibe-cards] initialized ${VIBE_CARDS_FILE} with 0 card(s)`)
  return payload
}

function loadVibeCards() {
  if (!existsSync(VIBE_CARDS_FILE)) return createDefaultVibeCardsFile()

  try {
    const parsed = JSON.parse(readFileSync(VIBE_CARDS_FILE, 'utf8'))
    const validated = validateVibeCardsPayload(parsed)
    if (validated.error) {
      console.error(`[vibe-cards] startup validation failed: ${validated.error}`)
      throw new Error(validated.error)
    }
    console.log(`[vibe-cards] loaded ${validated.cards.length} card(s) from ${VIBE_CARDS_FILE}`)
    return { cards: validated.cards }
  } catch (error) {
    console.error(`[vibe-cards] startup load failed: ${error.message}`)
    process.exit(1)
  }
}

function persistVibeCards(action, cardId) {
  try {
    writeFileSync(VIBE_CARDS_FILE, JSON.stringify(vibeCardStore, null, 2) + '\n')
    console.log(`[vibe-cards] persisted action=${action} id=${cardId} total=${vibeCardStore.cards.length}`)
  } catch (error) {
    console.error(`[vibe-cards] persist failed action=${action} id=${cardId}: ${error.message}`)
    throw error
  }
}

function serializeCard(card) {
  return {
    id: card.id,
    title: card.title,
    description: card.description,
    status: card.status,
    lane: card.lane,
    priority: card.priority,
    tags: card.tags,
    metadata: card.metadata,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt
  }
}

function buildCardFromCreate(body) {
  const validationError = validateCardShape(body)
  if (validationError) return { error: validationError }

  const nowIso = new Date().toISOString()
  const normalized = normalizeCardTimestamps({
    ...body,
    id: body.id.trim(),
    title: body.title.trim(),
    description: body.description ?? null,
    status: body.status ?? null,
    lane: body.lane ?? null,
    priority: body.priority ?? null,
    tags: body.tags ?? [],
    metadata: body.metadata ?? {},
    createdAt: body.createdAt ?? nowIso,
    updatedAt: body.updatedAt ?? nowIso
  }, nowIso)

  return { card: serializeCard(normalized) }
}

function applyCardPatch(existingCard, patch) {
  if (!isPlainObject(patch)) return { error: 'patch body must be an object' }
  if ('id' in patch) return { error: 'id cannot be updated' }

  const validationError = validateCardShape(patch, { partial: true })
  if (validationError) return { error: validationError }

  const nextCard = serializeCard({
    ...existingCard,
    ...patch,
    title: typeof patch.title === 'string' ? patch.title.trim() : existingCard.title,
    description: Object.prototype.hasOwnProperty.call(patch, 'description') ? patch.description : existingCard.description,
    status: Object.prototype.hasOwnProperty.call(patch, 'status') ? patch.status : existingCard.status,
    lane: Object.prototype.hasOwnProperty.call(patch, 'lane') ? patch.lane : existingCard.lane,
    priority: Object.prototype.hasOwnProperty.call(patch, 'priority') ? patch.priority : existingCard.priority,
    tags: Object.prototype.hasOwnProperty.call(patch, 'tags') ? patch.tags : existingCard.tags,
    metadata: Object.prototype.hasOwnProperty.call(patch, 'metadata') ? patch.metadata : existingCard.metadata,
    updatedAt: new Date().toISOString()
  })

  return { card: nextCard }
}

const vibeCardStore = loadVibeCards()

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

// ─── Redis pubsub + SSE ───────────────────────────────────────────────────────
// Port-forward openclaw/redis → localhost:6380, then subscribe to gsd:events:*

const REDIS_LOCAL_PORT   = parseInt(process.env.REDIS_LOCAL_PORT ?? '6380', 10)
const REDIS_SERVICE      = 'redis'
const REDIS_NAMESPACE    = 'openclaw'
const WATCHER_SCRIPT     = resolve(__dir, 'gsd-journal-watcher.py')
const REDIS_CLUSTER_IP   = '34.118.237.138'  // openclaw/redis ClusterIP
const REDIS_CLUSTER_PORT = 6379

// SSE clients — Set of { res, instFilter }
const sseClients = new Set()

function broadcastSSE(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const client of sseClients) {
    try { client.write(data) } catch { sseClients.delete(client) }
  }
}

// Start port-forward to Redis
let redisPf = null
function ensureRedisPf() {
  if (redisPf && redisPf.exitCode === null) return
  console.log(`[redis] port-forwarding ${REDIS_NAMESPACE}/${REDIS_SERVICE} → localhost:${REDIS_LOCAL_PORT}`)
  redisPf = spawn(KUBECTL, [
    'port-forward', `svc/${REDIS_SERVICE}`, '-n', REDIS_NAMESPACE,
    `${REDIS_LOCAL_PORT}:${REDIS_CLUSTER_PORT}`
  ], { stdio: 'pipe' })
  redisPf.on('exit', code => {
    console.log(`[redis] port-forward exited code=${code}, restarting in 3s`)
    redisPf = null
    setTimeout(startRedisSubscriber, 3000)
  })
}

// Redis subscriber
let redisSub = null
function startRedisSubscriber() {
  ensureRedisPf()
  // Give port-forward a moment to bind
  setTimeout(() => {
    if (redisSub) { try { redisSub.disconnect() } catch {} }
    redisSub = new Redis({ host: 'localhost', port: REDIS_LOCAL_PORT, lazyConnect: true,
      retryStrategy: () => 3000, maxRetriesPerRequest: null })

    redisSub.on('connect', () => console.log(`[redis] subscriber connected on :${REDIS_LOCAL_PORT}`))
    redisSub.on('error',   e  => console.warn(`[redis] subscriber error: ${e.message}`))

    redisSub.subscribe('gsd:events:*', (err, count) => {
      if (err) console.warn('[redis] subscribe error:', err.message)
      else console.log(`[redis] subscribed to gsd:events:* (${count} channel(s))`)
    })

    // ioredis doesn't support glob subscribe — use psubscribe
    redisSub.disconnect()
    redisSub = new Redis({ host: 'localhost', port: REDIS_LOCAL_PORT, lazyConnect: true,
      retryStrategy: () => 3000, maxRetriesPerRequest: null })
    redisSub.on('connect', () => console.log(`[redis] subscriber ready`))
    redisSub.on('error',   e  => { /* suppress reconnect noise */ })
    redisSub.psubscribe('gsd:events:*', err => {
      if (err) console.warn('[redis] psubscribe error:', err.message)
    })
    redisSub.on('pmessage', (pattern, channel, message) => {
      // channel format: gsd:events:<instanceName>
      const instName = channel.split(':')[2]
      let event
      try { event = JSON.parse(message) } catch { return }

      console.log(`[redis] ${instName} ${event.eventType} ${event.unitId ?? ''} ${event.status ?? ''}`)

      // Invalidate cache and re-poll immediately
      const cfg = instanceConfigs.find(i => i.name === instName)
      if (cfg) pollInstance(cfg).then(() => {
        broadcastSSE({ source: instName, ...event })
      })
      else broadcastSSE({ source: instName, ...event })
    })
  }, 1500)
}

// Start Redis subscriber (best-effort — dashboard works without it)
startRedisSubscriber()

// Start journal watcher on each pod instance
async function startJournalWatcher(cfg) {
  if (!cfg.pod) return
  const ns      = cfg.namespace ?? 'lk-gsd'
  const ctr     = cfg.container ?? 'gsd'
  const gsdPath = cfg.gsdPath ?? '/home/gsd/workspace/salesanalyzer/.gsd'
  const channel = `gsd:events:${cfg.name}`

  try {
    // Copy watcher script to pod (skip if already there with same size)
    const localSize = readFileSync(WATCHER_SCRIPT).length
    let remoteSize  = 0
    try {
      const out = execFileSync(KUBECTL, [
        'exec', cfg.pod, '-n', ns, '-c', ctr, '--',
        'stat', '-c', '%s', '/tmp/gsd-journal-watcher.py'
      ], { encoding: 'utf8', timeout: 5000 })
      remoteSize = parseInt(out.trim()) || 0
    } catch {}

    if (remoteSize !== localSize) {
      execFileSync(KUBECTL, [
        'cp', WATCHER_SCRIPT,
        `${cfg.pod}:/tmp/gsd-journal-watcher.py`,
        '-n', ns, '-c', ctr
      ], { encoding: 'utf8', timeout: 15000 })
      console.log(`[watcher] copied script to ${cfg.name}`)
    }

    // Launch watcher in a tmux window using a non-blocking spawn
    // We do this in two steps to avoid the compound command getting SIGTERM
    // Kill existing watcher (pkill exits 143 on success — catch it)
    try {
      execFileSync(KUBECTL, ['exec', cfg.pod, '-n', ns, '-c', ctr, '--',
        'pkill', '-f', 'gsd-journal-watcher'], { encoding: 'utf8', timeout: 5000 })
    } catch { /* 143 = killed a process, that's fine */ }

    await new Promise(r => setTimeout(r, 400))

    // Launch in a new tmux window — command runs directly, survives kubectl exit
    const launchCmd = `python3 /tmp/gsd-journal-watcher.py '${gsdPath}' '${REDIS_CLUSTER_IP}' '${REDIS_CLUSTER_PORT}' '${channel}'`
    execFileSync(KUBECTL, [
      'exec', cfg.pod, '-n', ns, '-c', ctr, '--',
      'tmux', 'new-window', '-t', 'gsd:', '-n', 'gsd-watcher', launchCmd
    ], { encoding: 'utf8', timeout: 5000 })

    console.log(`[watcher] launching on ${cfg.name} → ${channel}`)
  } catch (e) {
    console.warn(`[watcher] setup failed on ${cfg.name}: ${e.message.slice(0, 80)}`)
  }
}

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

// Start journal watchers for pod instances (non-blocking, after server is ready)
setTimeout(() => {
  for (const cfg of instanceConfigs.filter(i => i.pod)) {
    startJournalWatcher(cfg)
  }
}, 3000)

setInterval(pollAll, POLL_MS)
// Broadcast a poll-tick SSE on every cycle so browser can refresh without Redis
setInterval(() => broadcastSSE({ type: 'poll-tick', ts: new Date().toISOString() }), POLL_MS)
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

/**
 * GET /api/events
 * Server-Sent Events stream. Browser subscribes once; server pushes on each
 * Redis pubsub message (real-time) or on every poll cycle (fallback heartbeat).
 */
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.flushHeaders()

  // Send a heartbeat comment every 15s to keep connection alive
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n') } catch {} }, 15000)

  sseClients.add(res)
  console.log(`[sse] client connected (${sseClients.size} total)`)

  req.on('close', () => {
    clearInterval(hb)
    sseClients.delete(res)
    console.log(`[sse] client disconnected (${sseClients.size} remaining)`)
  })
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

app.get('/api/vibe-cards', (req, res) => {
  res.json({ cards: vibeCardStore.cards.map(serializeCard) })
})

app.post('/api/vibe-cards', (req, res) => {
  const result = buildCardFromCreate(req.body ?? {})
  if (result.error) return res.status(400).json({ error: result.error })

  if (vibeCardStore.cards.some(card => card.id === result.card.id)) {
    return res.status(409).json({ error: `card '${result.card.id}' already exists` })
  }

  vibeCardStore.cards.push(result.card)

  try {
    persistVibeCards('create', result.card.id)
    console.log(`[vibe-cards] action=create id=${result.card.id}`)
    res.status(201).json({ card: serializeCard(result.card) })
  } catch {
    vibeCardStore.cards = vibeCardStore.cards.filter(card => card.id !== result.card.id)
    res.status(500).json({ error: 'failed to persist vibe card' })
  }
})

app.patch('/api/vibe-cards/:id', (req, res) => {
  const index = vibeCardStore.cards.findIndex(card => card.id === req.params.id)
  if (index === -1) return res.status(404).json({ error: 'card not found' })

  const result = applyCardPatch(vibeCardStore.cards[index], req.body ?? {})
  if (result.error) return res.status(400).json({ error: result.error })

  const previousCard = vibeCardStore.cards[index]
  vibeCardStore.cards[index] = result.card

  try {
    persistVibeCards('update', result.card.id)
    console.log(`[vibe-cards] action=update id=${result.card.id}`)
    res.json({ card: serializeCard(result.card) })
  } catch {
    vibeCardStore.cards[index] = previousCard
    res.status(500).json({ error: 'failed to persist vibe card' })
  }
})

app.delete('/api/vibe-cards/:id', (req, res) => {
  const index = vibeCardStore.cards.findIndex(card => card.id === req.params.id)
  if (index === -1) return res.status(404).json({ error: 'card not found' })

  const [removedCard] = vibeCardStore.cards.splice(index, 1)

  try {
    persistVibeCards('delete', removedCard.id)
    console.log(`[vibe-cards] action=delete id=${removedCard.id}`)
    res.json({ ok: true, id: removedCard.id })
  } catch {
    vibeCardStore.cards.splice(index, 0, removedCard)
    res.status(500).json({ error: 'failed to persist vibe card' })
  }
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
    <button class="bar-btn" id="copy-btn" onclick="copyTerminalSelection()" title="Copy selection (Cmd+C)">⌘C Copy</button>
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
          :'http://localhost:'+data.port+'/?arg='+encodeURIComponent(SESSION+':0')
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

    async function copyTerminalSelection(){
      const iframe=document.getElementById('ttyd-frame')
      try{ iframe.focus() }catch{}

      let selected=''
      try{
        selected=iframe.contentWindow?.term?.getSelection?.() ?? ''
      }catch{}

      if(!selected){
        alert('Select text inside the terminal first, then click Copy.')
        return
      }

      try{
        await navigator.clipboard.writeText(selected)
      }catch(e){
        console.warn('[copy] clipboard write failed:',e.message)
        alert('Clipboard write failed. Grant clipboard permission for this page and try again.')
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
