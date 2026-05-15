import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'http'
import express from 'express'
import { readFileSync, unlinkSync, existsSync } from 'fs'
import { resolve } from 'path'

// Minimal mock of the file-drop endpoint logic for unit testing
function buildFileDropHandler({ instanceConfigs, KUBECTL, writeFileSync, execFileSync }) {
  return (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'empty file body' })
      }
      const originalName = (req.query.filename || 'dropped-file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
      const rand = Math.random().toString(36).slice(2, 7)
      const filename = `${stamp}-${rand}-${originalName}`
      const localPath = `/tmp/${filename}`
      writeFileSync(localPath, req.body)

      const instanceName = req.query.instance
      const cfg = instanceName ? instanceConfigs.find(i => i.name === instanceName) : null

      if (cfg?.pod) {
        const ns = cfg.namespace ?? 'lk-gsd'
        const ctr = cfg.container ?? 'gsd'
        const podPath = `/tmp/${filename}`
        try {
          execFileSync(KUBECTL, ['cp', localPath, `${ns}/${cfg.pod}:${podPath}`, '-c', ctr],
            { encoding: 'utf8', timeout: 15000 })
          return res.json({ path: podPath, bytes: req.body.length, instance: cfg.name, pod: true })
        } catch (err) {
          // Fall through
        }
      }

      res.json({ path: localPath, bytes: req.body.length, instance: cfg?.name ?? null, pod: false })
    } catch (err) {
      res.status(500).json({ error: err.message || 'failed to save file' })
    }
  }
}

describe('file-drop endpoint', () => {
  it('rejects empty body', () => {
    let statusCode, jsonBody
    const handler = buildFileDropHandler({
      instanceConfigs: [],
      KUBECTL: '',
      writeFileSync: () => {},
      execFileSync: () => {}
    })
    handler(
      { body: Buffer.alloc(0), query: {} },
      { status: (c) => { statusCode = c; return { json: (j) => { jsonBody = j } } }, json: (j) => { jsonBody = j } }
    )
    expect(statusCode).toBe(400)
    expect(jsonBody.error).toContain('empty')
  })

  it('sanitizes filename', () => {
    let jsonBody
    const handler = buildFileDropHandler({
      instanceConfigs: [],
      KUBECTL: '',
      writeFileSync: () => {},
      execFileSync: () => {}
    })
    handler(
      { body: Buffer.from('hello'), query: { filename: 'hello world<>.txt' } },
      { status: () => ({ json: (j) => { jsonBody = j } }), json: (j) => { jsonBody = j } }
    )
    expect(jsonBody.path).toContain('hello_world__.txt')
    expect(jsonBody.bytes).toBe(5)
    expect(jsonBody.pod).toBe(false)
  })

  it('truncates long filename', () => {
    let jsonBody
    const handler = buildFileDropHandler({
      instanceConfigs: [],
      KUBECTL: '',
      writeFileSync: () => {},
      execFileSync: () => {}
    })
    const longName = 'a'.repeat(300) + '.txt'
    handler(
      { body: Buffer.from('x'), query: { filename: longName } },
      { status: () => ({ json: (j) => { jsonBody = j } }), json: (j) => { jsonBody = j } }
    )
    // The timestamp-rand- prefix adds ~28 chars, so the base name should be truncated
    const baseName = jsonBody.path.split('-').pop()
    expect(baseName.length).toBeLessThanOrEqual(200)
  })
})
