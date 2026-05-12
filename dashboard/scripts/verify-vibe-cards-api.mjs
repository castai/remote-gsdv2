#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const ROOT = resolve(process.cwd(), 'dashboard')
const FILE = resolve(ROOT, 'vibe-cards.json')
const BASE_URL = process.env.VIBE_CARDS_API_URL ?? 'http://localhost:3001'
const phaseArg = process.argv.find(arg => arg.startsWith('--phase='))
const phase = phaseArg ? phaseArg.split('=')[1] : 'crud'

async function request(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, init)
  const text = await res.text()
  let json = null
  if (text) {
    try { json = JSON.parse(text) }
    catch (error) {
      throw new Error(`Expected JSON from ${path}, got: ${text.slice(0, 200)}`)
    }
  }
  return { res, json }
}

function readPersistedCards() {
  const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'vibe-cards.json should be an object payload')
  assert.ok(Array.isArray(parsed.cards), 'vibe-cards.json should contain a cards array')
  return parsed.cards
}

async function verifyCrud() {
  const cardId = `verify-${Date.now()}`

  const initial = await request('/api/vibe-cards')
  assert.equal(initial.res.status, 200, 'GET /api/vibe-cards should succeed')
  assert.ok(Array.isArray(initial.json?.cards), 'GET should return a cards array')

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

  const deleted = await request(`/api/vibe-cards/${cardId}`, { method: 'DELETE' })
  assert.equal(deleted.res.status, 200, 'Delete should return 200')
  assert.equal(deleted.json?.id, cardId, 'Delete should report removed id')

  const missingDelete = await request(`/api/vibe-cards/${cardId}`, { method: 'DELETE' })
  assert.equal(missingDelete.res.status, 404, 'Deleting again should return 404')

  const finalList = await request('/api/vibe-cards')
  assert.equal(finalList.res.status, 200)
  assert.ok(!finalList.json.cards.some(card => card.id === cardId), 'Deleted card should be removed from API list')

  persistedCards = readPersistedCards()
  assert.ok(!persistedCards.some(card => card.id === cardId), 'Deleted card should be removed from vibe-cards.json')

  console.log(`verify-vibe-cards-api: ${phase} ok`)
}

if (phase !== 'crud') {
  throw new Error(`Unsupported phase '${phase}'`)
}

await verifyCrud()
