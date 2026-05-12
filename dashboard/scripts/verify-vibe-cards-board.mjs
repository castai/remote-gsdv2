#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SERVER_ENTRY = resolve(ROOT, 'server.js')
const FIXTURE_FILE = resolve(ROOT, 'vibe-cards.json')
const modeArg = process.argv.find(arg => arg.startsWith('--mode='))
const mode = modeArg ? modeArg.split('=')[1] : 'render'
const requestedBaseUrl = process.env.VIBE_CARDS_BOARD_URL ?? null
const HOST = process.env.VIBE_CARDS_API_HOST ?? '127.0.0.1'
const PORT = parseInt(process.env.VIBE_CARDS_API_PORT ?? '3112', 10)
const BASE_URL = requestedBaseUrl ?? `http://${HOST}:${PORT}`
const shouldManageServer = !requestedBaseUrl

const seededCards = [
  {
    id: 'render-backlog-card',
    title: 'Backlog Vibe',
    description: 'Should appear in Discussing',
    lane: 'backlog',
    status: 'open',
    priority: 'medium',
    tags: ['board', 'render'],
    metadata: { source: 'board-verify' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'render-review-card',
    title: 'Review Vibe',
    description: 'Should appear in Validating',
    lane: 'review',
    status: 'open',
    priority: 'high',
    tags: ['board', 'review'],
    metadata: { source: 'board-verify' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
]

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

async function waitForServer() {
  const start = Date.now()
  let lastError = null

  while (Date.now() - start < 20000) {
    try {
      const response = await request('/api/vibe-cards')
      if (response.res.status === 200) return response
      lastError = new Error(`Unexpected status ${response.res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }

  throw new Error(`Timed out waiting for ${BASE_URL}/api/vibe-cards: ${lastError?.message ?? 'unknown error'}`)
}

function seedFixture() {
  writeFileSync(FIXTURE_FILE, JSON.stringify({ cards: seededCards }, null, 2) + '\n')
}

async function startManagedServer({ reseed = false, logDir = null } = {}) {
  if (reseed) seedFixture()

  const activeLogDir = logDir ?? mkdtempSync(resolve(tmpdir(), 'verify-vibe-cards-board-'))
  const stdoutPath = resolve(activeLogDir, 'server.stdout.log')
  const stderrPath = resolve(activeLogDir, 'server.stderr.log')
  if (!existsSync(stdoutPath)) writeFileSync(stdoutPath, '')
  if (!existsSync(stderrPath)) writeFileSync(stderrPath, '')

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
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

function createBrowserDiagnostics(page) {
  const consoleErrors = []
  const failedRequests = []

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
    if (msg.type() === 'debug' && msg.text().includes('[board] refresh deferred during drag')) {
      consoleErrors.push(`DEBUG:${msg.text()}`)
    }
  })
  page.on('requestfailed', request => {
    const url = request.url()
    const failureText = request.failure()?.errorText ?? 'request failed'
    const isExpectedAbort = failureText === 'net::ERR_ABORTED' && (
      url.includes('/api/events') || url.includes('/api/terminal/')
    )
    if (!isExpectedAbort) {
      failedRequests.push(`${request.method()} ${url} ${failureText}`)
    }
  })
  page.on('response', async response => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.request().method()} ${response.url()} ${response.status()}`)
    }
  })

  return { consoleErrors, failedRequests }
}

function assertNoUnexpectedDiagnostics({ consoleErrors, failedRequests }) {
  const unexpectedConsoleErrors = consoleErrors.filter(entry => !entry.startsWith('DEBUG:'))
  assert.equal(unexpectedConsoleErrors.length, 0, `Board should not emit console errors: ${unexpectedConsoleErrors.join('\n')}`)
  assert.equal(failedRequests.length, 0, `Board should not emit failed network requests: ${failedRequests.join('\n')}`)
}

async function openBoard(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForResponse(response => response.url().endsWith('/api/vibe-cards') && response.request().method() === 'GET' && response.status() === 200)
  await page.waitForSelector('[data-vibe-card="true"]')
}

async function assertTextVisible(locator, text) {
  await locator.locator(`text=${text}`).waitFor({ state: 'visible' })
}

async function assertTextHidden(locator, text) {
  await assert.rejects(
    locator.locator(`text=${text}`).waitFor({ state: 'visible', timeout: 500 }),
    /Timeout/,
    `${text} should not remain visible in original column`
  )
}

async function verifyRender() {
  const created = await request('/api/vibe-cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'render-done-card',
      title: 'Done Vibe',
      description: 'Should appear in Done',
      lane: 'done',
      status: 'closed',
      priority: 'low',
      tags: ['board', 'done'],
      metadata: { source: 'board-verify' }
    })
  })
  assert.equal(created.res.status, 201, 'Verifier should be able to seed a third card through the API')

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const diagnostics = createBrowserDiagnostics(page)

  try {
    await openBoard(page)

    const backlogColumn = page.locator('#col-Discussing')
    const executingColumn = page.locator('#col-Executing')
    const validatingColumn = page.locator('#col-Validating')
    const doneColumn = page.locator('#col-Done')

    await assertTextVisible(backlogColumn, 'Backlog Vibe')
    await assertTextVisible(validatingColumn, 'Review Vibe')
    await assertTextVisible(doneColumn, 'Done Vibe')

    const vibeCard = page.locator('[data-vibe-card-id="render-backlog-card"]').first()
    const milestoneCard = page.locator('.card').first()

    await assert.ok(await milestoneCard.count(), 'Existing milestone cards should still render')

    const vibeClass = await vibeCard.getAttribute('class')
    const milestoneClass = await milestoneCard.getAttribute('class')
    assert.match(vibeClass ?? '', /vibe-card/, 'Vibe cards should use dedicated styling class')
    assert.doesNotMatch(milestoneClass ?? '', /vibe-card/, 'Milestone cards should not be converted to vibe cards')

    const backlogLaneLabel = await vibeCard.locator('[data-vibe-lane-chip="true"]').textContent()
    assert.equal(backlogLaneLabel?.trim(), 'Backlog', 'Lane chip should reflect backlog lane')

    await milestoneCard.click()
    await page.locator('#panel-overlay.visible').waitFor({ state: 'visible' })
    const panelTitle = await page.locator('#panel-title').textContent()
    assert.ok(panelTitle?.includes('—'), 'Milestone card click should open a detail panel with a milestone title')
    await page.click('.panel-close')

    assertNoUnexpectedDiagnostics(diagnostics)
  } finally {
    await page.close()
    await browser.close()
  }
}

async function verifyDrag() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const diagnostics = createBrowserDiagnostics(page)
  const patchRequests = []

  page.on('request', request => {
    if (request.method() === 'PATCH' && request.url().includes('/api/vibe-cards/render-backlog-card')) {
      patchRequests.push(request)
    }
  })

  try {
    await openBoard(page)

    const backlogColumn = page.locator('#col-Discussing')
    const executingColumn = page.locator('#col-Executing')
    const panelOverlay = page.locator('#panel-overlay')
    const milestoneCard = page.locator('.card').first()

    await assertTextVisible(backlogColumn, 'Backlog Vibe')
    await assertTextHidden(executingColumn, 'Backlog Vibe')

    const dragCard = page.locator('[data-vibe-card-id="render-backlog-card"]').first()
    await dragCard.hover()
    await page.dispatchEvent('[data-vibe-card-id="render-backlog-card"]', 'dragstart', {
      dataTransfer: await page.evaluateHandle(() => new DataTransfer())
    })
    await page.waitForTimeout(50)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForResponse(response => response.url().endsWith('/api/vibe-cards') && response.request().method() === 'GET' && response.status() === 200)
    await page.waitForSelector('[data-vibe-card-id="render-backlog-card"]')

    const laneDuringDrag = await page.locator('[data-vibe-card-id="render-backlog-card"] [data-vibe-lane-chip="true"]').textContent()
    assert.equal(laneDuringDrag?.trim(), 'Backlog', 'Refresh during drag should not move the card before drop')

    await page.dragAndDrop('[data-vibe-card-id="render-backlog-card"]', '#col-Executing')
    const patchResponse = await page.waitForResponse(response => response.url().includes('/api/vibe-cards/render-backlog-card') && response.request().method() === 'PATCH' && response.status() === 200)
    const patchBody = patchRequests.at(-1)?.postDataJSON()
    assert.deepEqual(patchBody, { lane: 'in-progress' }, 'Drag should PATCH the target lane contract')
    const patchJson = await patchResponse.json()
    assert.equal(patchJson.card?.lane, 'in-progress', 'PATCH response should reflect the new lane')

    await page.waitForTimeout(250)
    await page.waitForSelector('[data-vibe-card-id="render-backlog-card"][data-vibe-lane="in-progress"]')
    await assertTextVisible(executingColumn, 'Backlog Vibe')
    await assertTextHidden(backlogColumn, 'Backlog Vibe')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForResponse(response => response.url().endsWith('/api/vibe-cards') && response.request().method() === 'GET' && response.status() === 200)
    await page.waitForSelector('[data-vibe-card-id="render-backlog-card"]')

    await assertTextVisible(executingColumn, 'Backlog Vibe')
    await assertTextHidden(backlogColumn, 'Backlog Vibe')
    const afterReloadLaneLabel = await page.locator('[data-vibe-card-id="render-backlog-card"] [data-vibe-lane-chip="true"]').textContent()
    assert.equal(afterReloadLaneLabel?.trim(), 'In Progress', 'Lane chip should update after drag + reload')

    const persisted = await request('/api/vibe-cards')
    assert.equal(persisted.res.status, 200, 'GET /api/vibe-cards should still succeed after drag')
    const movedCard = persisted.json.cards.find(card => card.id === 'render-backlog-card')
    assert.equal(movedCard?.lane, 'in-progress', 'Dragged lane should persist via API state')

    await assert.ok(await milestoneCard.count(), 'Milestone cards should still render after drag wiring')
    await milestoneCard.click()
    await panelOverlay.waitFor({ state: 'visible' })
    const panelTitle = await page.locator('#panel-title').textContent()
    assert.ok(panelTitle?.includes('—'), 'Milestone card click should open a detail panel with a milestone title')
    await page.click('.panel-close')

    const stdout = shouldManageServer && serverHandle ? readFileSync(serverHandle.stdoutPath, 'utf8') : ''
    if (shouldManageServer) {
      assert.match(stdout, /\[vibe-cards\] action=update id=render-backlog-card/, 'Server logs should show lane persistence update')
    }

    assertNoUnexpectedDiagnostics(diagnostics)
  } finally {
    await page.close()
    await browser.close()
  }
}

if (!['render', 'drag'].includes(mode)) {
  throw new Error(`Unsupported mode '${mode}'`)
}

let serverHandle = null
const originalFixture = existsSync(FIXTURE_FILE) ? readFileSync(FIXTURE_FILE, 'utf8') : null

try {
  serverHandle = shouldManageServer ? await startManagedServer({ reseed: true }) : null
  if (mode === 'render') {
    await verifyRender()
  } else {
    await verifyDrag()
  }
  console.log(`verify-vibe-cards-board: ${mode} ok (${BASE_URL})`)
} finally {
  if (serverHandle) {
    await serverHandle.stop()
  }
  if (originalFixture === null) {
    rmSync(FIXTURE_FILE, { force: true })
  } else {
    writeFileSync(FIXTURE_FILE, originalFixture)
  }
}
