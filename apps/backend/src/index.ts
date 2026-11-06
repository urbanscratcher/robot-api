import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const port = Number(process.env.PORT ?? 3000)

// 피에조 충격 알림에 필요한 토큰. 비어 있으면 누구나 /api/hurt 를 부를 수 있다.
const HURT_TOKEN = process.env.HURT_TOKEN ?? ''
// 피에조가 한 번 맞을 때 여러 번 튀는 것을 하나로 묶는 시간(ms)
const HURT_COOLDOWN_MS = 300
const PIEZO_MIN_LEVEL = 300
const PIEZO_STRONG_LEVEL = 800

type PiezoStage = 1 | 2

function piezoStage(level: number): PiezoStage | null {
  if (level < PIEZO_MIN_LEVEL) return null
  return level < PIEZO_STRONG_LEVEL ? 1 : 2
}

// 얼굴 페이지들(SSE 연결). /api/hurt 가 오면 모두에게 'hurt' 이벤트를 보낸다.
const listeners = new Set<ServerResponse>()
let lastHurtAt = 0

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function readBody(request: IncomingMessage, limit = 4096) {
  return new Promise<string>((resolve) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      if (body.length < limit) body += chunk.toString('utf8')
    })
    request.on('end', () => resolve(body.slice(0, limit)))
    request.on('error', () => resolve(''))
  })
}

function broadcast(event: string, data: unknown) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const listener of listeners) listener.write(message)
}

setInterval(() => {
  for (const listener of listeners) listener.write(': ping\n\n')
}, 15000).unref()

// 로봇(ESP32) 주행 켜기/끄기. 관리자 패널이 POST로 바꾸고, ESP32는 GET으로 1초마다 확인한다.
// 서버가 다시 시작되면 켜짐으로 돌아간다(ESP32 자체 동작과 같음).
const robot = { driving: true, updatedAt: new Date().toISOString(), lastSeenAt: null as string | null }

function robotStatus() {
  const seenMsAgo = robot.lastSeenAt ? Date.now() - Date.parse(robot.lastSeenAt) : null
  return { ...robot, online: seenMsAgo !== null && seenMsAgo < 5000 }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
    json(response, 200, { status: 'ok', service: 'robot-face-backend', listeners: listeners.size })
    return
  }

  // 얼굴 페이지가 연결해 두는 실시간 알림 통로 (Server-Sent Events)
  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write('retry: 2000\n\n')
    listeners.add(response)
    request.on('close', () => listeners.delete(response))
    return
  }

  // 로봇 주행 상태.  GET /api/robot  (ESP32는 ?device=esp32 를 붙여서 접속 기록을 남긴다)
  if (request.method === 'GET' && url.pathname === '/api/robot') {
    if (url.searchParams.get('device') === 'esp32') robot.lastSeenAt = new Date().toISOString()
    json(response, 200, robotStatus())
    return
  }

  // 관리자 패널에서 주행 켜기/끄기.  POST /api/robot  {"driving": false}
  if (request.method === 'POST' && url.pathname === '/api/robot') {
    let driving: unknown
    try {
      driving = (JSON.parse(await readBody(request)) as { driving?: unknown }).driving
    } catch {
      driving = undefined
    }
    if (typeof driving !== 'boolean') {
      json(response, 400, { error: 'boolean driving required' })
      return
    }
    robot.driving = driving
    robot.updatedAt = new Date().toISOString()
    broadcast('robot', robotStatus())
    console.log(`[robot] driving=${driving}`)
    json(response, 200, robotStatus())
    return
  }

  // ESP32 피에조 충격 → 얼굴이 아파한다.  POST /api/hurt  (본문은 선택: {"level": 812})
  if (request.method === 'POST' && url.pathname === '/api/hurt') {
    const body = await readBody(request)
    if (HURT_TOKEN) {
      const given = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token') ?? ''
      if (given !== HURT_TOKEN) {
        json(response, 401, { error: 'token required' })
        return
      }
    }
    let level: number | undefined
    try {
      const parsed = body ? JSON.parse(body) as { level?: unknown } : {}
      if (typeof parsed.level === 'number') level = parsed.level
    } catch {
      // 본문이 JSON이 아니어도 충격으로 처리한다.
    }
    if (level === undefined || !Number.isFinite(level)) {
      json(response, 400, { error: 'numeric level required' })
      return
    }
    const stage = piezoStage(level)
    if (!stage) {
      json(response, 200, { ok: true, skipped: 'below_threshold', level })
      return
    }
    const strength = stage === 1 ? 'weak' : 'strong'
    const now = Date.now()
    if (now - lastHurtAt < HURT_COOLDOWN_MS) {
      json(response, 200, { ok: true, skipped: 'cooldown', listeners: listeners.size })
      return
    }
    lastHurtAt = now
    broadcast('hurt', { level, stage, strength, at: new Date(now).toISOString() })
    console.log(`[hurt] level=${level} stage=${stage} strength=${strength} listeners=${listeners.size}`)
    json(response, 200, { ok: true, level, stage, strength, listeners: listeners.size })
    return
  }

  json(response, 404, { error: 'Not found' })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Backend listening on http://0.0.0.0:${port}`)
})

const shutdown = () => {
  for (const listener of listeners) listener.end()
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
