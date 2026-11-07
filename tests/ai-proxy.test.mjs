import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { proxyAiRequest } from '../apps/backend/dist/ai-proxy.js'

const listen = async server => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

test('AI gateway preserves intake, SSE, authorization and failure responses', async t => {
  const original = { ...process.env }
  const worker = createServer(async (req, res) => {
    if (req.url === '/api/mobile/publications/event-1/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: publication\ndata: {"status":"published"}\n\n')
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.writeHead(req.url === '/api/observations/busy' ? 409 : 200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=example; HttpOnly; Secure; SameSite=Strict',
    })
    res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString(), url: req.url }))
  })
  process.env.AI_WORKER_URL = await listen(worker)
  process.env.OBSERVATION_TOKEN = 'server-only-observation-token'
  process.env.AI_ALLOWED_ORIGINS = 'https://robot.example'
  const gateway = createServer((req, res) => {
    if (!proxyAiRequest(req, res)) { res.writeHead(404); res.end() }
  })
  const base = await listen(gateway)
  t.after(() => {
    worker.closeAllConnections(); worker.close()
    gateway.closeAllConnections(); gateway.close()
    for (const name of ['AI_WORKER_URL', 'OBSERVATION_TOKEN', 'AI_ALLOWED_ORIGINS']) {
      if (original[name] === undefined) delete process.env[name]
      else process.env[name] = original[name]
    }
  })
  await t.test('intake body and query survive; browser token is replaced only on server', async () => {
    const body = JSON.stringify({ image: 'x'.repeat(100000), eventId: 'event-1' })
    const response = await fetch(`${base}/api/observations?example=1`, {
      method: 'POST', headers: { Origin: 'https://robot.example', Authorization: 'Bearer client-value' }, body,
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.body, body)
    assert.equal(data.url, '/api/observations?example=1')
    assert.equal(data.headers.authorization, 'Bearer server-only-observation-token')
    assert.equal(data.headers.origin, undefined)
    assert.equal(data.headers['x-overheard-public'], '1')
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'))
  })
  await t.test('untrusted browser origins cannot use server credentials', async () => {
    const response = await fetch(`${base}/api/observations`, { method: 'POST', headers: { Origin: 'https://other.example' }, body: '{}' })
    assert.equal(response.status, 403)
  })
  await t.test('management routes preserve Origin and cookie, never acquire intake credentials', async () => {
    const response = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { Origin: 'https://monitor.example', Cookie: 'session=existing', 'X-Overheard-Public': '0' }, body: '{}' })
    const data = await response.json()
    assert.equal(data.headers.origin, 'https://monitor.example')
    assert.equal(data.headers.cookie, 'session=existing')
    assert.equal(data.headers.authorization, undefined)
    assert.equal(data.headers['x-overheard-public'], '1')
    assert.equal((await fetch(`${base}/api/observations/busy`)).status, 409)
  })
  await t.test('SSE reaches the browser before upstream closes', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/mobile/publications/event-1/events`, { signal: controller.signal })
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    const { value } = await response.body.getReader().read()
    assert.match(new TextDecoder().decode(value), /published/)
    controller.abort()
  })
  await t.test('missing configuration fails explicitly; unrelated routes stay with backend', async () => {
    assert.equal((await fetch(`${base}/api/robot`)).status, 404)
    delete process.env.OBSERVATION_TOKEN
    assert.equal((await fetch(`${base}/api/transcripts`, { method: 'POST', body: '{}' })).status, 503)
    delete process.env.AI_WORKER_URL
    assert.equal((await fetch(`${base}/api/status`)).status, 503)
    process.env.AI_WORKER_URL = 'http://127.0.0.1:1'
    assert.equal((await fetch(`${base}/api/status`)).status, 502)
  })
})
