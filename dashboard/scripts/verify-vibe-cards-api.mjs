#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SERVER_ENTRY = resolve(ROOT, 'server.js')
const FIXTURE_FILE = resolve(ROOT, 'vibe-cards.json')
const phaseArg = process.argv.find(arg => arg.startsWith('--phase='))
const phase = phaseArg ? phaseArg.split('=')[1] : 'crud'
const requestedBaseUrl = process.env.VIBE_CARDS_API_URL ?? null
const HOST = process.env.VIBE_CARDS_API_HOST ?? '127.0.0.1'
const PORT = parseInt(process.env.VIBE_CARDS_API_PORT ?? '3111', 10)
const BASE_URL = requestedBaseUrl ?? `http://${HOST}:${PORT}`
const shouldManageServer = !requestedBaseUrl
const seededCards = [
  {
    id: 'seed-card-1',
    title: 'Seed Card',
    description: 'Baseline card for verification',
    lane: 'backlog',
    status: 'open',
    priority: 'medium',
    tags: ['seed'],
    metadata: { source: 'verify-script' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
]

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function readPersistedPayload() {
  const parsed = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'))
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'vibe-cards.json should be an object payload')
  assert.ok(Array.isArray(parsed.cards), 'vibe-cards.json should contain a cards array')
  return parsed
}

function readPersistedCards() {
  return readPersistedPayload().cards
}

async function request(path, init, attempt = 0) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, init)
    const text = await res.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`Expected JSON from ${path}, got: ${text.slice(0, 200)}`)
      }
    }
    return { res, json }
  } catch (error) {
    const code = error?.cause?.code
    if (attempt < 4 && (code === 'ECONNRESET' || code === 'ECONNREFUSED')) {
      await sleep(150)
      return request(path, init, attempt + 1)
    }
    throw error
  }
}

function seedFixture() {
  writeFileSync(FIXTURE_FILE, JSON.stringify({ cards: seededCards }, null, 2) + '\n')
}

async function waitForServer() {
  const start = Date.now()
  let lastError = null

  while (Date.now() - start < 20000) {
    try {
      const response = await request('/api/vibe-cards')
      if (response.res.status === 200) {
        return response
      }
      lastError = new Error(`Unexpected status ${response.res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }

  throw new Error(`Timed out waiting for ${BASE_URL}/api/vibe-cards: ${lastError?.message ?? 'unknown error'}`)
}

async function startManagedServer({ reseed = false, logDir = null } = {}) {
  if (reseed) {
    seedFixture()
  }

  const activeLogDir = logDir ?? mkdtempSync(resolve(tmpdir(), 'verify-vibe-cards-'))
  const stdoutPath = resolve(activeLogDir, 'server.stdout.log')
  const stderrPath = resolve(activeLogDir, 'server.stderr.log')
  if (!existsSync(stdoutPath)) writeFileSync(stdoutPath, '')
  if (!existsSync(stderrPath)) writeFileSync(stderrPath, '')

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      REDIS_LOCAL_PORT: String(parseInt(process.env.REDIS_LOCAL_PORT ?? '6380', 10) + 101)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.on('data', chunk => {
    writeFileSync(stdoutPath, chunk, { flag: 'a' })
  })
  child.stderr.on('data', chunk => {
    writeFileSync(stderrPath, chunk, { flag: 'a' })
  })

  try {
    await waitForServer()
  } catch (error) {
    try { child.kill('SIGTERM') } catch {}
    throw new Error(`${error.message}\nstdout:\n${readFileSync(stdoutPath, 'utf8')}\nstderr:\n${readFileSync(stderrPath, 'utf8')}`)
  }

  return {
    child,
    stdoutPath,
    stderrPath,
    logDir: activeLogDir,
    async restart() {
      if (child.exitCode === null) {
        try { child.kill('SIGTERM') } catch {}
        await Promise.race([
          new Promise(resolvePromise => child.once('exit', resolvePromise)),
          sleep(5000)
        ])
        if (child.exitCode === null) {
          try { child.kill('SIGKILL') } catch {}
        }
      }
      return startManagedServer({ reseed: false, logDir: activeLogDir })
    },
    async stop() {
      if (child.exitCode !== null) return
      try { child.kill('SIGTERM') } catch {}
      await Promise.race([
        new Promise(resolvePromise => child.once('exit', resolvePromise)),
        sleep(5000)
      ])
      if (child.exitCode === null) {
        try { child.kill('SIGKILL') } catch {}
      }
    }
  }
}

function assertLogsContain(logText, needle, description) {
  assert.match(logText, needle, description)
}

async function verifyCrud(serverHandle) {
  const initial = await request('/api/vibe-cards')
  assert.equal(initial.res.status, 200, 'GET /api/vibe-cards should succeed')
  assert.ok(initial.json?.cards?.length >= 1, 'Seeded server should start with at least one card')
  assert.ok(initial.json.cards.some(card => card.id === seededCards[0].id), 'Seed card should be loaded from vibe-cards.json')

  const cardId = `verify-${Date.now()}`

  const badCreate = await request('/api/vibe-cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'missing-id' })
  })
  assert.equal(badCreate.res.status, 400, 'Invalid create should return 400')

  const created = await request('/api/vibe-cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: cardId,
      title: 'Verification Card',
      description: 'Created by verify script',
      lane: 'backlog',
      status: 'open',
      priority: 'medium',
      tags: ['verification'],
      metadata: { source: 'verify-script' }
    })
  })
  assert.equal(created.res.status, 201, 'Create should return 201')
  assert.equal(created.json?.card?.id, cardId, 'Created card id should match')

  const afterCreate = await request('/api/vibe-cards')
  assert.equal(afterCreate.res.status, 200)
  assert.ok(afterCreate.json.cards.some(card => card.id === cardId), 'Created card should be listed')

  let persistedCards = readPersistedCards()
  assert.ok(persistedCards.some(card => card.id === cardId), 'Created card should persist to vibe-cards.json')

  const updated = await request(`/api/vibe-cards/${cardId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Verification Card Updated',
      lane: 'in-progress',
      tags: ['verification', 'updated']
    })
  })
  assert.equal(updated.res.status, 200, 'Patch should return 200')
  assert.equal(updated.json?.card?.title, 'Verification Card Updated', 'Patch should update title')
  assert.equal(updated.json?.card?.lane, 'in-progress', 'Patch should update lane')

  const badPatch = await request(`/api/vibe-cards/${cardId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: 'not-an-array' })
  })
  assert.equal(badPatch.res.status, 400, 'Invalid patch should return 400')

  persistedCards = readPersistedCards()
  const persistedUpdated = persistedCards.find(card => card.id === cardId)
  assert.equal(persistedUpdated?.title, 'Verification Card Updated', 'Updated card should persist title change')
  assert.equal(persistedUpdated?.lane, 'in-progress', 'Updated card should persist lane change')

  const restartedServer = shouldManageServer ? await serverHandle.restart() : serverHandle
  const afterRestart = await request('/api/vibe-cards')
  assert.equal(afterRestart.res.status, 200, 'GET after restart should succeed')
  assert.ok(afterRestart.json.cards.some(card => card.id === cardId), 'Created card should survive server restart')
  assert.equal(afterRestart.json.cards.find(card => card.id === cardId)?.title, 'Verification Card Updated', 'Updated card should survive restart')

  const deleted = await request(`/api/vibe-cards/${cardId}`, { method: 'DELETE' })
  assert.equal(deleted.res.status, 200, 'Delete should return 200')
  assert.equal(deleted.json?.id, cardId, 'Delete should report removed id')

  const missingDelete = await request(`/api/vibe-cards/${cardId}`, { method: 'DELETE' })
  assert.equal(missingDelete.res.status, 404, 'Deleting again should return 404')

  const finalList = await request('/api/vibe-cards')
  assert.equal(finalList.res.status, 200)
  assert.ok(!finalList.json.cards.some(card => card.id === cardId), 'Deleted card should be removed from API list')
  assert.ok(finalList.json.cards.some(card => card.id === 'seed-card-1'), 'Seed card should remain after cleanup')

  persistedCards = readPersistedCards()
  assert.ok(!persistedCards.some(card => card.id === cardId), 'Deleted card should be removed from vibe-cards.json')
  assert.ok(persistedCards.some(card => card.id === 'seed-card-1'), 'Fixture seed should remain on disk after cleanup')

  if (shouldManageServer) {
    const stdout = readFileSync(restartedServer.stdoutPath, 'utf8')
    const stderr = existsSync(restartedServer.stderrPath) ? readFileSync(restartedServer.stderrPath, 'utf8') : ''
    assertLogsContain(stdout, /\[vibe-cards\] loaded \d+ card\(s\) from /, 'Startup load log should be emitted')
    assertLogsContain(stdout, new RegExp(`\\[vibe-cards\\] action=create id=${cardId}`), 'Create action log should include the card id')
    assertLogsContain(stdout, new RegExp(`\\[vibe-cards\\] action=update id=${cardId}`), 'Update action log should include the card id')
    assertLogsContain(stdout, new RegExp(`\\[vibe-cards\\] action=delete id=${cardId}`), 'Delete action log should include the card id')
    assert.ok(!/\[vibe-cards\].*failed/i.test(stderr), 'Server stderr should not contain Vibe Card failures during verification')
  }

  return restartedServer
}

if (phase !== 'crud') {
  throw new Error(`Unsupported phase '${phase}'`)
}

let managedServer = null
const originalFixture = existsSync(FIXTURE_FILE) ? readFileSync(FIXTURE_FILE, 'utf8') : null

try {
  managedServer = shouldManageServer ? await startManagedServer({ reseed: true }) : null
  managedServer = await verifyCrud(managedServer)
  console.log(`verify-vibe-cards-api: ${phase} ok (${BASE_URL})`)
} finally {
  if (managedServer) {
    await managedServer.stop()
  }
  if (originalFixture === null) {
    rmSync(FIXTURE_FILE, { force: true })
  } else {
    writeFileSync(FIXTURE_FILE, originalFixture)
  }
}
