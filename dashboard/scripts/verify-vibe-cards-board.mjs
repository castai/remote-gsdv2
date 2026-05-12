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
  const browserTracePath = resolve(activeLogDir, 'browser-events.log')
  if (!existsSync(stdoutPath)) writeFileSync(stdoutPath, '')
  if (!existsSync(stderrPath)) writeFileSync(stderrPath, '')
  if (!existsSync(browserTracePath)) writeFileSync(browserTracePath, '')

  try {
    await waitForServer()
    return {
      child: null,
      stdoutPath,
      stderrPath,
      browserTracePath,
      logDir: activeLogDir,
      async stop() {}
    }
  } catch {}

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
    browserTracePath,
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
  const traceLines = []

  page.on('console', msg => {
    const line = `[console:${msg.type()}] ${msg.text()}`
    traceLines.push(line)
    if (msg.type() === 'error') consoleErrors.push(msg.text())
    if (msg.type() === 'debug' && msg.text().includes('[board] refresh deferred during drag')) {
      consoleErrors.push(`DEBUG:${msg.text()}`)
    }
  })
  page.on('request', request => {
    traceLines.push(`[request] ${request.method()} ${request.url()} ${request.postData() ?? ''}`.trim())
  })
  page.on('requestfailed', request => {
    const url = request.url()
    const failureText = request.failure()?.errorText ?? 'request failed'
    const line = `[requestfailed] ${request.method()} ${url} ${failureText}`
    traceLines.push(line)
    const isExpectedAbort = failureText === 'net::ERR_ABORTED' && (
      url.includes('/api/events') || url.includes('/api/terminal/')
    )
    if (!isExpectedAbort) {
      failedRequests.push(`${request.method()} ${url} ${failureText}`)
    }
  })
  page.on('response', async response => {
    const line = `[response] ${response.request().method()} ${response.url()} ${response.status()}`
    traceLines.push(line)
    if (response.status() >= 400) {
      failedRequests.push(`${response.request().method()} ${response.url()} ${response.status()}`)
    }
  })

  return { consoleErrors, failedRequests, traceLines }
}

function assertNoUnexpectedDiagnostics({ consoleErrors, failedRequests }) {
  const unexpectedConsoleErrors = consoleErrors.filter(entry => !entry.startsWith('DEBUG:'))
  assert.equal(unexpectedConsoleErrors.length, 0, `Board should not emit console errors: ${unexpectedConsoleErrors.join('\n')}`)
  assert.equal(failedRequests.length, 0, `Board should not emit failed network requests: ${failedRequests.join('\n')}`)
}

function flushBrowserTrace(diagnostics) {
  if (shouldManageServer && serverHandle?.browserTracePath) {
    writeFileSync(serverHandle.browserTracePath, diagnostics.traceLines.join('\n') + '\n')
  }
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
    await page.locator('#panel-overlay .panel-close').click()

    assertNoUnexpectedDiagnostics(diagnostics)
  } finally {
    flushBrowserTrace(diagnostics)
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
    await page.locator('#panel-overlay .panel-close').click()

    const stdout = shouldManageServer && serverHandle ? readFileSync(serverHandle.stdoutPath, 'utf8') : ''
    if (shouldManageServer && serverHandle?.child) {
      const patchSeen = patchRequests.some(request => request.postDataJSON()?.lane === 'in-progress')
      assert.equal(patchSeen, true, 'Drag flow should emit a PATCH request for the new lane')
      const stdout = readFileSync(serverHandle.stdoutPath, 'utf8')
      assert.match(stdout, /\[vibe-cards\] action=update id=render-backlog-card/, 'Server logs should show lane persistence update')
    }

    assertNoUnexpectedDiagnostics(diagnostics)
  } finally {
    flushBrowserTrace(diagnostics)
    await page.close()
    await browser.close()
  }
}

async function verifyModal() {
  const seedCheck = await request('/api/vibe-cards')
  const existingSeed = seedCheck.json.cards.find(card => card.id === 'modal-bootstrap-card')
  if (!existingSeed) {
    const bootstrap = await request('/api/vibe-cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'modal-bootstrap-card',
        title: 'Modal Bootstrap Card',
        description: 'Ensures the board renders a Vibe card before modal checks',
        lane: 'backlog',
        status: 'open',
        priority: 'medium',
        tags: ['modal', 'bootstrap'],
        metadata: { source: 'board-verify' }
      })
    })
    assert.equal(bootstrap.res.status, 201, 'Modal verifier should be able to seed a bootstrap Vibe card through the API')
  }

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const diagnostics = createBrowserDiagnostics(page)
  const apiRequests = []

  page.on('request', request => {
    if (request.url().includes('/api/vibe-cards') && ['POST', 'PATCH', 'DELETE'].includes(request.method())) {
      apiRequests.push({ method: request.method(), url: request.url(), body: request.postDataJSON?.() ?? null })
    }
  })

  try {
    await openBoard(page)

    await page.click('button.vibe-add-btn')
    await page.locator('#vibe-modal-overlay.visible').waitFor({ state: 'visible' })
    await page.waitForSelector('#vibe-instance option', { state: 'attached' })

    await page.fill('#vibe-title', 'Modal Flow Card')
    await page.fill('#vibe-description', 'Created through modal verifier')
    await page.selectOption('#vibe-lane', 'review')
    await page.selectOption('#vibe-priority', 'high')
    await page.selectOption('#vibe-status', 'blocked')
    await page.selectOption('#vibe-color', 'green')

    const instanceOptions = await page.locator('#vibe-instance option').evaluateAll(options =>
      options.map(option => ({ value: option.value, text: option.textContent || '' }))
    )
    const preferredInstance = instanceOptions.find(option => option.value && option.value.toLowerCase() !== 'local')
      ?? instanceOptions.find(option => option.value)

    if (preferredInstance) {
      await page.selectOption('#vibe-instance', preferredInstance.value)
      await page.waitForFunction(() => {
        const hint = document.querySelector('#vibe-session-hint')?.textContent || ''
        return !hint.includes('Choose an instance to load sessions.') && !hint.includes('Loading sessions…')
      })
      const sessionHint = await page.locator('#vibe-session-hint').textContent()
      const sessionDisabled = await page.locator('#vibe-session').isDisabled()
      if (sessionHint?.includes('Session load failed')) {
        assert.equal(sessionDisabled, true, 'Failed session loads should disable the session selector')
      } else if (sessionHint?.includes('No tmux sessions found')) {
        assert.equal(sessionDisabled, true, 'Empty session lists should disable the session selector')
      } else {
        assert.equal(sessionDisabled, false, 'Successful session loads should enable the session selector')
      }
    }

    await page.fill('#vibe-jira', 'https://jira.example.com/browse/VIBE-123')
    await page.fill('#vibe-labels', 'modal, verify')
    await page.waitForFunction(() => {
      const title = document.querySelector('#vibe-title')?.value?.trim() || ''
      const submit = document.querySelector('#vibe-submit')
      const derivedId = document.querySelector('#vibe-id')?.value || ''
      return title === 'Modal Flow Card' && derivedId === 'modal-flow-card' && !!submit && !submit.disabled
    })

    const createRequestPromise = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/vibe-cards'))
    const createResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/vibe-cards') && response.status() === 201)
    await page.click('#vibe-submit')
    const createRequest = await createRequestPromise
    const createResponse = await createResponsePromise
    const createBody = createRequest.postDataJSON()
    const createJson = await createResponse.json()

    assert.equal(createBody.title, 'Modal Flow Card', 'Create payload should include the modal title')
    assert.equal(createBody.description, 'Created through modal verifier', 'Create payload should include the modal description')
    assert.equal(createBody.lane, 'review', 'Create payload should use the chosen lane')
    assert.equal(createBody.priority, 'high', 'Create payload should include the chosen priority')
    assert.equal(createBody.status, 'blocked', 'Create payload should include the chosen status')
    assert.deepEqual(createBody.tags, ['modal', 'verify'], 'Create payload should normalize comma-separated labels into tags')
    assert.equal(createBody.metadata?.color, 'green', 'Create payload should include metadata.color')
    assert.equal(createBody.metadata?.jiraUrl, 'https://jira.example.com/browse/VIBE-123', 'Create payload should include metadata.jiraUrl')
    assert.equal(createJson.card?.id, 'modal-flow-card', 'Created card id should derive from the title slug')

    await page.locator('#vibe-modal-overlay.visible').waitFor({ state: 'hidden' })
    await page.waitForSelector('[data-vibe-card-id="modal-flow-card"]')
    await assertTextVisible(page.locator('#col-Validating'), 'Modal Flow Card')

    await page.click('[data-vibe-card-id="modal-flow-card"]')
    await page.locator('#vibe-modal-overlay.visible').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#vibe-id').inputValue(), 'modal-flow-card', 'Edit modal should preserve the persisted card id')

    await page.fill('#vibe-description', 'Updated through modal verifier')
    await page.fill('#vibe-labels', 'modal, edited')
    await page.selectOption('#vibe-status', 'done')
    await page.waitForFunction(() => {
      const submit = document.querySelector('#vibe-submit')
      const status = document.querySelector('#vibe-status')?.value || ''
      const description = document.querySelector('#vibe-description')?.value || ''
      return !!submit && !submit.disabled && status === 'done' && description === 'Updated through modal verifier'
    })

    const patchRequestPromise = page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes('/api/vibe-cards/modal-flow-card'))
    const patchResponsePromise = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/api/vibe-cards/modal-flow-card') && response.status() === 200, { timeout: 10000 })
    await page.click('#vibe-submit')
    const patchRequest = await patchRequestPromise
    const patchResponse = await patchResponsePromise
    const patchBody = patchRequest.postDataJSON()
    const patchJson = await patchResponse.json()

    assert.equal(patchBody.description, 'Updated through modal verifier', 'Edit payload should include the updated description')
    assert.deepEqual(patchBody.tags, ['modal', 'edited'], 'Edit payload should rewrite tags from labels input')
    assert.equal(patchBody.status, 'done', 'Edit payload should include the updated status')
    assert.equal(patchJson.card?.status, 'done', 'PATCH response should include the updated status')

    await page.locator('#vibe-modal-overlay.visible').waitFor({ state: 'hidden' })
    await page.waitForSelector('[data-vibe-card-id="modal-flow-card"]')

    const persistedAfterPatch = await request('/api/vibe-cards')
    const editedCard = persistedAfterPatch.json.cards.find(card => card.id === 'modal-flow-card')
    assert.equal(editedCard?.description, 'Updated through modal verifier', 'Updated description should persist via API state')
    assert.deepEqual(editedCard?.tags, ['modal', 'edited'], 'Updated tags should persist via API state')

    await page.click('[data-vibe-card-id="modal-flow-card"]')
    await page.locator('#vibe-modal-overlay.visible').waitFor({ state: 'visible' })
    const deleteResponsePromise = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/api/vibe-cards/modal-flow-card') && response.status() === 200)
    await page.click('#vibe-delete')
    await deleteResponsePromise
    await page.locator('#vibe-modal-overlay.visible').waitFor({ state: 'hidden' })
    await assert.rejects(
      page.waitForSelector('[data-vibe-card-id="modal-flow-card"]', { state: 'attached', timeout: 800 }),
      /Timeout/,
      'Deleted card should be removed from the board'
    )

    const persistedAfterDelete = await request('/api/vibe-cards')
    assert.equal(persistedAfterDelete.json.cards.some(card => card.id === 'modal-flow-card'), false, 'Deleted card should be removed from persisted API state')

    const methods = apiRequests.map(request => request.method)
    assert.ok(methods.includes('POST'), 'Modal flow should issue a create request')
    assert.ok(methods.includes('PATCH'), 'Modal flow should issue an update request')
    assert.ok(methods.includes('DELETE'), 'Modal flow should issue a delete request')

    if (shouldManageServer && serverHandle?.child) {
      const stdout = readFileSync(serverHandle.stdoutPath, 'utf8')
      assert.match(stdout, /\[vibe-cards\] action=create id=modal-flow-card/, 'Server logs should show create action')
      assert.match(stdout, /\[vibe-cards\] action=update id=modal-flow-card/, 'Server logs should show update action')
      assert.match(stdout, /\[vibe-cards\] action=delete id=modal-flow-card/, 'Server logs should show delete action')
    }

    assertNoUnexpectedDiagnostics(diagnostics)
  } finally {
    flushBrowserTrace(diagnostics)
    await page.close()
    await browser.close()
  }
}

if (!['render', 'drag', 'modal'].includes(mode)) {
  throw new Error(`Unsupported mode '${mode}'`)
}

let serverHandle = null
const originalFixture = existsSync(FIXTURE_FILE) ? readFileSync(FIXTURE_FILE, 'utf8') : null

try {
  serverHandle = shouldManageServer ? await startManagedServer({ reseed: true }) : null
  if (mode === 'render') {
    await verifyRender()
  } else if (mode === 'drag') {
    await verifyDrag()
  } else {
    await verifyModal()
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
