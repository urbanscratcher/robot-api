import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'

// 로봇 API는 기존 서버가 처리하고 AI 관련 경로만 내부 서비스로 전달한다.
const routes = /^\/api\/(?:observations|transcripts|mobile\/publications|piezo|publishing|creations|received-photos|received-transcripts|instagram|publish-images|admin|ai-settings|status|generate|transcribe|card-preview|news)(?:\/|$)/
const tokenRoutes = /^\/api\/(?:observations|transcripts|piezo)$/
const mobileRoutes = /^\/api\/mobile\/publications(?:\/|$)/
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']

export function proxyAiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const incoming = new URL(req.url ?? '/', 'http://localhost')
  if (!routes.test(incoming.pathname)) return false
  const fail = (status: number, error: string) => {
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ error }))
  }
  const base = process.env.AI_WORKER_URL
  if (!base) { fail(503, 'AI_WORKER_URL is not configured'); return true }
  const intake = req.method === 'POST' && tokenRoutes.test(incoming.pathname)
  const needsToken = intake || mobileRoutes.test(incoming.pathname)
  // 전송 토큰은 서버에만 둔다. 이 게이트웨이 자체는 기존처럼 tailnet 내부에서만 노출한다.
  if (intake && req.headers.origin) {
    const allowed = (process.env.AI_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim())
    if (!allowed.includes(req.headers.origin)) { fail(403, 'Origin is not allowed'); return true }
  }
  if (needsToken && !process.env.OBSERVATION_TOKEN) {
    fail(503, 'OBSERVATION_TOKEN is not configured'); return true
  }
  try {
    const target = new URL(incoming.pathname + incoming.search, base)
    const headers = { ...req.headers }
    for (const name of hopHeaders) delete headers[name]
    for (const name of (req.headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())) delete headers[name]
    delete headers['cf-connecting-ip']
    delete headers['x-forwarded-host']
    headers.host = `127.0.0.1:${target.port || (target.protocol === 'https:' ? '443' : '80')}`
    headers['x-overheard-public'] = '1'
    if (needsToken) headers.authorization = `Bearer ${process.env.OBSERVATION_TOKEN}`
    if (intake) delete headers.origin
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = send(target, { method: req.method, headers }, upstreamResponse => {
      const responseHeaders = { ...upstreamResponse.headers }
      for (const name of hopHeaders) delete responseHeaders[name]
      res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
      upstreamResponse.on('error', () => res.destroy())
      upstreamResponse.pipe(res)
    })
    // SSE 접속은 유지하되 응답이 멈춘 연결은 정리한다. 게시 요청은 자동 재시도하지 않는다.
    upstream.setTimeout(60 * 60 * 1000, () => upstream.destroy())
    upstream.on('error', () => fail(502, 'AI worker is unavailable'))
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  } catch {
    fail(502, 'AI worker is unavailable')
  }
  return true
}
