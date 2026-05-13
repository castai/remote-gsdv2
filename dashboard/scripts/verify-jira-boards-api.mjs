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
const JIRA_CONFIG_FILE = resolve(ROOT, 'jira-config.json')
const FIXTURE_FILE = resolve(ROOT, 'jira-boards.json')

const PORT = parseInt(process.env.JIRA_BOARDS_API_PORT ?? '3112', 10)
const HOST = process.env.JIRA_BOARDS_API_HOST ?? '127.0.0.1'
const BASE_URL = `http://${HOST}:${PORT}`

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function readPersistedBoards() {
  const parsed = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'))
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'jira-boards.json must be an object payload')
  assert.ok(Array.isArray(parsed.boards), 'jira-boards.json must contain a boards array')
  return parsed.boards
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

function seedConfig() {
  writeFileSync(JIRA_CONFIG_FILE, JSON.stringify({
    site_url: 'https://test.atlassian.net',
    email: 'test@example.com',
    api_token: 'stub'
  }, null, 2) + '\n')
}

function seedBoards() {
  writeFileSync(FIXTURE_FILE, JSON.stringify({ boards: [] }, null, 2) + '\n')
}

async function waitForServer() {
  const start = Date.now()
  let lastError = null
  while (Date.now() - start < 20000) {
    try {
      const response = await request('/api/jira/boards')
      if (response.res.status === 200 || response.res.status === 503) {
        return response
      }
      lastError = new Error(`Unexpected status ${response.res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${BASE_URL}/api/jira/boards: ${lastError?.message ?? 'unknown error'}`)
}

async function startManagedServer({ logDir = null } = {}) {
  const activeLogDir = logDir ?? mkdtempSync(resolve(tmpdir(), 'verify-jira-boards-'))
  const stdoutPath = resolve(activeLogDir, 'server.stdout.log')
  const stderrPath = resolve(activeLogDir, 'server.stderr.log')
  if (!existsSync(stdoutPath)) writeFileSync(stdoutPath, '')
  if (!existsSync(stderrPath)) writeFileSync(stderrPath, '')

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      JIRA_BOARDS_FILE: FIXTURE_FILE,
      REDIS_LOCAL_PORT: String(parseInt(process.env.REDIS_LOCAL_PORT ?? '6380', 10) + 102)
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
      return startManagedServer({ logDir: activeLogDir })
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

function assertResponseHasNoToken(json) {
  const str = JSON.stringify(json)
  assert.ok(!str.includes('stub'), 'Response body must not contain api_token')
  assert.ok(!str.includes('api_token'), 'Response body must not contain api_token field name')
}

let managedServer = null
const originalConfig = existsSync(JIRA_CONFIG_FILE) ? readFileSync(JIRA_CONFIG_FILE, 'utf8') : null
const originalBoards = existsSync(FIXTURE_FILE) ? readFileSync(FIXTURE_FILE, 'utf8') : null

async function verify() {
  seedConfig()
  seedBoards()

  managedServer = await startManagedServer()

  // 1. GET /api/jira/boards returns empty array
  const initial = await request('/api/jira/boards')
  assert.equal(initial.res.status, 200, 'GET /api/jira/boards should succeed')
  assert.deepEqual(initial.json?.boards, [], 'Initial boards list should be empty')
  assertResponseHasNoToken(initial.json)

  // 2. POST with valid board returns 201
  const created = await request('/api/jira/boards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'SA', name: 'Sales Analyzer', boardId: 1778 })
  })
  assert.equal(created.res.status, 201, 'POST valid board should return 201')
  assert.equal(created.json?.board?.key, 'SA', 'Created board key should match')
  assert.equal(created.json?.board?.name, 'Sales Analyzer', 'Created board name should match')
  assert.equal(created.json?.board?.boardId, 1778, 'Created board boardId should match')
  assertResponseHasNoToken(created.json)

  // 3. Duplicate POST returns 409
  const duplicate = await request('/api/jira/boards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'SA', name: 'Sales Analyzer', boardId: 1778 })
  })
  assert.equal(duplicate.res.status, 409, 'Duplicate POST should return 409')
  assertResponseHasNoToken(duplicate.json)

  // 4. POST with missing key returns 400
  const missingKey = await request('/api/jira/boards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'No Key' })
  })
  assert.equal(missingKey.res.status, 400, 'POST missing key should return 400')
  assertResponseHasNoToken(missingKey.json)

  // 5. GET returns the newly linked board
  const afterCreate = await request('/api/jira/boards')
  assert.equal(afterCreate.res.status, 200)
  assert.equal(afterCreate.json?.boards?.length, 1, 'Should have 1 board after create')
  assert.equal(afterCreate.json.boards[0].key, 'SA')
  assert.equal(afterCreate.json.boards[0].name, 'Sales Analyzer')
  assert.equal(afterCreate.json.boards[0].boardId, 1778)
  assertResponseHasNoToken(afterCreate.json)

  // 6. DELETE non-existent key returns 404
  const missingDelete = await request('/api/jira/boards/NOPE', { method: 'DELETE' })
  assert.equal(missingDelete.res.status, 404, 'DELETE non-existent key should return 404')
  assertResponseHasNoToken(missingDelete.json)

  // 7. DELETE existing board returns ok
  const deleted = await request('/api/jira/boards/SA', { method: 'DELETE' })
  assert.equal(deleted.res.status, 200, 'DELETE existing board should return 200')
  assert.equal(deleted.json?.ok, true, 'DELETE should return ok=true')
  assertResponseHasNoToken(deleted.json)

  // 8. Verify board is removed
  const afterDelete = await request('/api/jira/boards')
  assert.equal(afterDelete.res.status, 200)
  assert.deepEqual(afterDelete.json?.boards, [], 'Boards should be empty after delete')

  // Persist verification: re-create, restart server, verify still there
  const beforeRestart = await request('/api/jira/boards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'SA', name: 'Sales Analyzer', boardId: 1778 })
  })
  assert.equal(beforeRestart.res.status, 201, 'Pre-restart create should succeed')

  // Verify on disk
  let persisted = readPersistedBoards()
  assert.equal(persisted.length, 1, 'Board should persist to disk before restart')
  assert.equal(persisted[0].key, 'SA')

  // Restart server
  const restartedServer = await managedServer.restart()
  managedServer = restartedServer

  // After restart, board should still be there
  const afterRestart = await request('/api/jira/boards')
  assert.equal(afterRestart.res.status, 200, 'GET after restart should succeed')
  assert.equal(afterRestart.json?.boards?.length, 1, 'Board should persist after restart')
  assert.equal(afterRestart.json.boards[0].key, 'SA')
  assertResponseHasNoToken(afterRestart.json)

  // Verify logs
  const stdout = readFileSync(managedServer.stdoutPath, 'utf8')
  assertLogsContain(stdout, /\[jira-boards\] persisted action=link key=SA/, 'Log should contain persisted action=link key=SA')
  assertLogsContain(stdout, /\[jira-boards\] loaded \d+ board\(s\)/, 'Log should contain loaded N board(s)')
  assertLogsContain(stdout, /\[jira-boards\] persisted action=unlink key=SA/, 'Log should contain persisted action=unlink key=SA')

  // 12. api_token is absent from all response bodies
  // Already checked via assertResponseHasNoToken on every response
}

try {
  await verify()
  console.log(`verify-jira-boards-api: ok (${BASE_URL})`)
} finally {
  if (managedServer) {
    await managedServer.stop()
  }
  if (originalConfig === null) {
    rmSync(JIRA_CONFIG_FILE, { force: true })
  } else {
    writeFileSync(JIRA_CONFIG_FILE, originalConfig)
  }
  if (originalBoards === null) {
    rmSync(FIXTURE_FILE, { force: true })
  } else {
    writeFileSync(FIXTURE_FILE, originalBoards)
  }
}
