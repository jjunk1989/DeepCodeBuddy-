/**
 * 无 GUI 集成测试：fork 编译后的 host 子进程，经 RemoteFetch 调 host.describe / session.list。
 * 验证 deepcodebuddy 环境（junction 依赖 dsh）下 host boot + IPC 全链路可用。
 */
import { fork } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RemoteFetch } from './dist/common/remote-fetch.js'

const here = dirname(fileURLToPath(import.meta.url))

const child = fork(join(here, 'dist', 'host', 'index.js'), [], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  env: { ...process.env, DSH_HOME: join(here, '.runtime', 'test-home') },
})

const remote = new RemoteFetch({
  send: (m) => child.send(m),
  onMessage: (cb) => child.on('message', cb),
  onExit: () => {},
  dispose: () => {},
})

child.on('exit', (code) => console.log(`[test] host exited ${code}`))

const call = (method, payload) => remote.fetch(`http://dsh.internal/api/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `test-${Date.now()}`, method, payload }),
}).then(async (r) => ({ status: r.status, text: await r.text() }))

child.on('message', async (msg) => {
  if (msg?.type !== 'ready') return
  console.log('[test] host ready — calling APIs...')
  try {
    const describe = await call('host.describe', {})
    console.log('[test] host.describe:', describe.status, describe.text.slice(0, 300))
    const sessions = await call('session.list', {})
    console.log('[test] session.list:', sessions.status, sessions.text.slice(0, 200))
  } catch (error) {
    console.error('[test] call failed:', error)
  } finally {
    child.send({ type: 'shutdown' })
  }
})

setTimeout(() => { console.error('[test] timeout'); child.kill() }, 60000)
