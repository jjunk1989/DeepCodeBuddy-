/**
 * 诊断：调用 dynamicCordisRunner RPC，看 400 的具体 body（issues 详情）。
 */
import { fork } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RemoteFetch } from './dist/common/remote-fetch.js'

const here = dirname(fileURLToPath(import.meta.url))

const child = fork(join(here, 'dist', 'host', 'index.js'), [], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  env: { ...process.env, DSH_HOME: join(here, '.runtime', 'diag-home') },
})

const remote = new RemoteFetch({
  send: (m) => child.send(m),
  onMessage: (cb) => child.on('message', cb),
  onExit: () => {},
  dispose: () => {},
})

const call = (method, payload = {}) => remote.fetch(`http://dsh.internal/api/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: `diag-${Date.now()}`, method, payload }),
}).then(async (r) => ({ status: r.status, text: await r.text() }))

child.on('message', async (msg) => {
  if (msg?.type !== 'ready') return
  console.log('[diag] host ready')

  for (const [method, payload] of [
    ['dynamicCordisRunner/inventory', {}],
    ['dynamicCordisRunner/inventory', { args: [] }],
    ['dynamicCordisRunner/syncInspectManifest', { args: [[]] }],
  ]) {
    try {
      const r = await call(method, payload)
      console.log(`[diag] ${method} payload=${JSON.stringify(payload)} → ${r.status}`)
      console.log(r.text.slice(0, 600))
    } catch (e) {
      console.log(`[diag] ${method} threw: ${String(e)}`)
    }
  }
  child.send({ type: 'shutdown' })
})

setTimeout(() => { console.error('[diag] timeout'); child.kill() }, 60000)
