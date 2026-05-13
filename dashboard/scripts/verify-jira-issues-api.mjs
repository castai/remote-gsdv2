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

const PORT = parseInt(process.env.JIRA_ISSUES_API_PORT ?? '3113', 10)
const HOST = process.env.JIRA_ISSUES_API_HOST ?? '127.0.0.1'
const BASE_URL = `http://${HOST}:${PORT}`

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
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
  writeFileSync(FIXTURE_FILE, JSON.stringify({
    boards: [{ key: 'SA', name: 'Sales Analyzer', boardId: 1778 }]
  }, null, 2) + '\n')
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
  const activeLogDir = logDir ?? mkdtempSync(resolve(tmpdir(), 'verify-jira-issues-'))
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
      REDIS_LOCAL_PORT: String(parseInt(process.env.REDIS_LOCAL_PORT ?? '6380', 10) + 103)
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

  // Test 1: GET /api/jira/boards/SA/issues — no real credentials → non-200 from Atlassian
  const issues = await request('/api/jira/boards/SA/issues')
  assert.ok(issues.res.status >= 400, `GET /api/jira/boards/SA/issues should return non-200 without real credentials, got ${issues.res.status}`)
  assert.ok(issues.json?.error, 'Error field should be present')
  assert.deepEqual(issues.json?.issues, [], 'Issues array should be empty on fetch failure')
  assertResponseHasNoToken(issues.json)

  // Read logs from the first server before we restart for disabled test
  const firstStderr = readFileSync(managedServer.stderrPath, 'utf8')

  // Test 2: GET /api/jira/boards/NOPE/issues → 404
  const nope = await request('/api/jira/boards/NOPE/issues')
  assert.equal(nope.res.status, 404, 'GET non-existent board should return 404')
  assert.equal(nope.json?.error, 'board not linked', 'Error should indicate board not linked')
  assertResponseHasNoToken(nope.json)

  // Test 3: GET /api/jira/boards regression guard
  const boards = await request('/api/jira/boards')
  assert.equal(boards.res.status, 200, 'GET /api/jira/boards should succeed')
  assert.equal(boards.json?.boards?.length, 1, 'Should have 1 board')
  assert.equal(boards.json.boards[0].key, 'SA')
  assertResponseHasNoToken(boards.json)

  // Verify structured log line for fetch failure (from Test 1)
  assert.match(firstStderr, /\[jira-issues\] fetch failed key=SA /, 'Log should contain fetch failed line')

  // Test 4: JIRA disabled mode — server without jira-config.json → 503
  await managedServer.stop()

  // Clean up config, keep boards, restart
  rmSync(JIRA_CONFIG_FILE, { force: true })
  const disabledServer = await startManagedServer({ logDir: managedServer.logDir })
  managedServer = disabledServer

  const disabledIssues = await request('/api/jira/boards/SA/issues')
  assert.equal(disabledIssues.res.status, 503, 'GET with JIRA disabled should return 503')
  assert.equal(disabledIssues.json?.error, 'JIRA not configured', 'Error should indicate JIRA not configured')
  assertResponseHasNoToken(disabledIssues.json)
}

try {
  await verify()
  console.log(`verify-jira-issues-api: ok (${BASE_URL})`)
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
