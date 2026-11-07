import { proxyAiRequest } from './ai-proxy.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const port = Number(process.env.PORT ?? 3000)

// 피에조 충격 알림에 필요한 토큰. 비어 있으면 누구나 /api/hurt 를 부를 수 있다.
const HURT_TOKEN = process.env.HURT_TOKEN ?? ''
// 피에조가 한 번 맞을 때 여러 번 튀는 것을 하나로 묶는 시간(ms)
const HURT_COOLDOWN_MS = 300
const PIEZO_SURPRISE_MAX_LEVEL = 300
const PIEZO_STRONG_LEVEL = 800

type PiezoStage = 1 | 2

function piezoStage(level: number): PiezoStage | null {
  if (level <= PIEZO_SURPRISE_MAX_LEVEL) return null
  return level < PIEZO_STRONG_LEVEL ? 1 : 2
}

// 얼굴 페이지들(SSE 연결). /api/hurt의 센서 값에 맞는 표정 이벤트를 모두에게 보낸다.
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

// 로봇(ESP32) 주행 켜기/끄기.
// - driving: 관리자 패널(또는 로봇의 p·BOOT 버튼)이 정한 "켜야 하나 꺼야 하나". 파일에 저장해서
//   서버를 다시 시작하거나 다시 배포해도 유지된다 (Docker에서는 robot-data 볼륨).
// - reported: ESP32가 1초마다 확인하면서 알려 주는 "지금 실제로 하고 있는 것".
// - online: 최근 5초 안에 ESP32가 확인하러 왔는지. synced: 실제가 설정과 같은지.
const ROBOT_STATE_FILE = process.env.ROBOT_STATE_FILE ?? 'data/robot-state.json'
type RobotReport = 'driving' | 'paused'
const robot = {
  driving: true,
  updatedAt: new Date().toISOString(),
  changedBy: 'default' as string,
  lastSeenAt: null as string | null,
  reported: null as RobotReport | null,
}
try {
  const saved = JSON.parse(readFileSync(ROBOT_STATE_FILE, 'utf8')) as { driving?: unknown; updatedAt?: unknown; changedBy?: unknown }
  if (typeof saved.driving === 'boolean') robot.driving = saved.driving
  if (typeof saved.updatedAt === 'string') robot.updatedAt = saved.updatedAt
  if (typeof saved.changedBy === 'string') robot.changedBy = saved.changedBy
} catch {
  // 저장된 상태가 없으면 켜짐으로 시작한다.
}

function saveRobotState() {
  try {
    mkdirSync(dirname(ROBOT_STATE_FILE), { recursive: true })
    writeFileSync(ROBOT_STATE_FILE, JSON.stringify({ driving: robot.driving, updatedAt: robot.updatedAt, changedBy: robot.changedBy }))
  } catch (error) {
    console.warn('[robot] 상태 저장 실패', error)
  }
}

// 촬영 중 잠깐 멈춤 (hold). 주행 스위치(driving)와 따로 둔다.
// - 얼굴 페이지가 사진을 찍으면 hold 를 걸고, 인스타 게시가 끝나면(또는 게시 관리자에게 넘어가면) 푼다.
// - 신호가 끝내 안 와도 로봇이 계속 서 있지 않도록 ROBOT_HOLD_MAX_MS 가 지나면 저절로 풀린다.
// - 파일에 저장하지 않는다: 서버가 다시 시작되면 풀린 상태로 시작한다.
const ROBOT_HOLD_MAX_MS = Number(process.env.ROBOT_HOLD_MAX_MS ?? 10 * 60 * 1000)
const hold = {
  active: false,
  reason: null as string | null,
  since: null as string | null,
  until: null as string | null,
}

function clearHold() {
  hold.active = false
  hold.reason = null
  hold.since = null
  hold.until = null
}

function robotStatus() {
  if (hold.active && hold.until && Date.now() >= Date.parse(hold.until)) clearHold()
  const seenMsAgo = robot.lastSeenAt ? Date.now() - Date.parse(robot.lastSeenAt) : null
  const online = seenMsAgo !== null && seenMsAgo < 5000
  // 로봇이 실제로 해야 하는 것: 스위치가 켜져 있고 촬영 중 멈춤이 아니면 달린다.
  const shouldDrive = robot.driving && !hold.active
  const synced = online && robot.reported === (shouldDrive ? 'driving' : 'paused')
  return {
    ...robot,
    online,
    synced,
    seenMsAgo,
    hold: hold.active,
    holdReason: hold.reason,
    holdSince: hold.since,
    holdUntil: hold.until,
    shouldDrive,
  }
}

// 로봇 연결이 끊기거나 다시 붙으면 패널에 바로 알린다.
// 촬영 중 멈춤이 시간이 다 돼서 풀려도 알린다.
let lastOnline = false
let lastHold = false
setInterval(() => {
  const status = robotStatus()
  if (status.online !== lastOnline || status.hold !== lastHold) {
    if (lastHold && !status.hold) console.log('[robot] hold 해제 (시간 초과 또는 해제됨)')
    lastOnline = status.online
    lastHold = status.hold
    broadcast('robot', status)
  }
}, 1000).unref()

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

  // 로봇 주행 상태.  GET /api/robot
  // ESP32는 ?device=esp32&state=driving|paused 를 붙여서 확인한다 (접속 시각과 실제 상태를 남긴다).
  if (request.method === 'GET' && url.pathname === '/api/robot') {
    if (url.searchParams.get('device') === 'esp32') {
      robot.lastSeenAt = new Date().toISOString()
      const state = url.searchParams.get('state')
      if ((state === 'driving' || state === 'paused') && state !== robot.reported) {
        robot.reported = state
        broadcast('robot', robotStatus())
      }
    }
    json(response, 200, robotStatus())
    return
  }

  // 주행 켜기/끄기.  POST /api/robot  {"driving": false, "source": "panel" | "esp32"}
  // 관리자 패널 버튼, 또는 로봇의 p·BOOT 버튼(ESP32가 보냄)이 부른다.
  if (request.method === 'POST' && url.pathname === '/api/robot') {
    let body: { driving?: unknown; source?: unknown } = {}
    try {
      body = JSON.parse(await readBody(request)) as typeof body
    } catch {
      body = {}
    }
    if (typeof body.driving !== 'boolean') {
      json(response, 400, { error: 'boolean driving required' })
      return
    }
    robot.driving = body.driving
    robot.updatedAt = new Date().toISOString()
    robot.changedBy = body.source === 'esp32' ? 'esp32' : 'panel'
    if (body.source === 'esp32') {
      robot.lastSeenAt = robot.updatedAt
      robot.reported = body.driving ? 'driving' : 'paused'
    }
    saveRobotState()
    broadcast('robot', robotStatus())
    console.log(`[robot] driving=${robot.driving} by=${robot.changedBy}`)
    json(response, 200, robotStatus())
    return
  }

  // 촬영 중 잠깐 멈춤.  POST /api/robot/hold  {"hold": true, "reason": "capture", "maxMs": 600000}
  //                                           {"hold": false}
  // 얼굴 페이지(촬영 → 인스타 게시 완료)나 다른 서비스가 부른다. 주행 스위치(driving)는 건드리지 않는다.
  if (request.method === 'POST' && url.pathname === '/api/robot/hold') {
    let body: { hold?: unknown; reason?: unknown; maxMs?: unknown } = {}
    try {
      body = JSON.parse(await readBody(request)) as typeof body
    } catch {
      body = {}
    }
    if (typeof body.hold !== 'boolean') {
      json(response, 400, { error: 'boolean hold required' })
      return
    }
    if (body.hold) {
      const requested = typeof body.maxMs === 'number' && Number.isFinite(body.maxMs) ? body.maxMs : ROBOT_HOLD_MAX_MS
      const maxMs = Math.max(1000, Math.min(requested, ROBOT_HOLD_MAX_MS))
      const now = Date.now()
      hold.active = true
      hold.reason = typeof body.reason === 'string' ? body.reason.slice(0, 40) : 'capture'
      hold.since = hold.since ?? new Date(now).toISOString()
      hold.until = new Date(now + maxMs).toISOString()
    } else {
      clearHold()
    }
    lastHold = hold.active
    broadcast('robot', robotStatus())
    console.log(`[robot] hold=${hold.active}${hold.active ? ` reason=${hold.reason} until=${hold.until}` : ''}`)
    json(response, 200, robotStatus())
    return
  }

  // ESP32 피에조 값 → 놀라거나 아파한다.  POST /api/hurt  ({"level": 812})
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
    const now = Date.now()
    if (now - lastHurtAt < HURT_COOLDOWN_MS) {
      json(response, 200, { ok: true, skipped: 'cooldown', listeners: listeners.size })
      return
    }
    lastHurtAt = now
    const stage = piezoStage(level)
    if (!stage) {
      broadcast('surprised', { level, at: new Date(now).toISOString() })
      console.log(`[surprised] level=${level} listeners=${listeners.size}`)
      json(response, 200, { ok: true, level, reaction: 'surprised', listeners: listeners.size })
      return
    }
    const strength = stage === 1 ? 'weak' : 'strong'
    broadcast('hurt', { level, stage, strength, at: new Date(now).toISOString() })
    console.log(`[hurt] level=${level} stage=${stage} strength=${strength} listeners=${listeners.size}`)
    json(response, 200, { ok: true, level, stage, strength, listeners: listeners.size })
    return
  }

  if (proxyAiRequest(request, response)) return

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
