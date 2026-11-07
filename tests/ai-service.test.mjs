import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function ready(url, child) {
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw Error(`Service exited (${child.exitCode})`)
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw Error('Service did not become ready')
}

test('Docker runtime files boot without secrets and work behind real robot backend', async t => {
  const root = resolve('apps/ai-worker')
  const runtime = await mkdtemp(join(tmpdir(), 'robot-ai-runtime-'))
  const children = []
  let logs = ''
  t.after(async () => {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', resolve); child.kill('SIGTERM')
    })))
    await rm(runtime, { recursive: true, force: true })
  })
  // Test exactly the files shipped to the runtime stage, catching missing TS imports.
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
  const runtimeStage = dockerfile.split('AS runtime')[1].split('FROM nginx:')[0]
  for (const match of runtimeStage.matchAll(/^COPY --from=build \/app\/apps\/ai-worker\/(\S+) (\S+)$/gm)) {
    const target = join(runtime, match[2])
    await mkdir(dirname(target), { recursive: true })
    await cp(join(root, match[1]), target, { recursive: true })
  }
  const aiPort = await freePort(), backendPort = await freePort()
  const env = {
    ...process.env, API_PORT: String(aiPort), API_HOST: '0.0.0.0', PORT: String(backendPort),
    AI_WORKER_URL: `http://127.0.0.1:${aiPort}`,
    OBSERVATION_TOKEN: 'test-server-only-token', ANTHROPIC_API_KEY: '',
    ADMIN_ACCESS_TOKEN: 'test-administrator-code-24-characters',
    ALLOWED_ORIGINS: 'https://monitor.example', ADMIN_ORIGINS: 'https://monitor.example',
    AI_ALLOWED_ORIGINS: 'https://monitor.example',
    META_APP_ID: '123', META_APP_SECRET: 'synthetic-meta-secret', INSTAGRAM_CONFIG_ID: '456',
    INSTAGRAM_API_VERSION: 'v26.0', INSTAGRAM_REDIRECT_URI: 'https://monitor.example/api/instagram/callback',
    ROBOT_STATE_FILE: join(runtime, 'data/robot.json'),
  }
  const start = (file, cwd) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', file], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => { logs += data }); child.stderr.on('data', data => { logs += data })
    children.push(child); return child
  }
  const ai = start('server/index.ts', runtime)
  const backend = start(resolve('apps/backend/dist/index.js'), runtime)
  try {
    await ready(`http://127.0.0.1:${aiPort}/health`, ai)
    const base = `http://127.0.0.1:${backendPort}`
    await ready(`${base}/api/health`, backend)
    assert.equal((await fetch(`${base}/api/robot`)).status, 200)
    const settings = await (await fetch(`${base}/api/ai-settings`)).json()
    assert.equal(settings.configured, false)
    assert.equal((await fetch(`${base}/api/received-photos`)).status, 403)
    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST', headers: { Origin: 'https://monitor.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: env.ADMIN_ACCESS_TOKEN }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    assert.equal((await fetch(`${base}/api/publishing/status`, { headers: { Cookie: cookie } })).status, 200)
    const oauth = await fetch(`${base}/api/instagram/connect`, {
      method: 'POST', headers: { Cookie: cookie, Origin: 'https://monitor.example', 'Content-Type': 'application/json' }, body: '{}',
    })
    assert.equal(oauth.status, 200)
    const redirect = new URL((await oauth.json()).url)
    assert.equal(redirect.searchParams.get('redirect_uri'), env.INSTAGRAM_REDIRECT_URI)
    const authDir = join(runtime, 'data/instagram')
    const pending = (await readdir(authDir)).find(name => name.endsWith('.pending.json'))
    const flow = JSON.parse(await readFile(join(authDir, pending), 'utf8'))
    assert.equal(flow.returnTo, 'https://monitor.example/admin/#monitor-admin')
    const forbidden = await fetch(`${base}/api/admin/login`, {
      method: 'POST', headers: { Origin: 'https://wrong.example', 'Content-Type': 'application/json' }, body: '{}',
    })
    assert.equal(forbidden.status, 403)
  } catch (error) {
    t.diagnostic(logs)
    throw error
  }
})
