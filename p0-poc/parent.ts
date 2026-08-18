/**
 * P0 PoC — 主进程侧（PoC A + B）。
 *
 * PoC A：fork host-child.ts，全程无网络端口 —— 父进程通过 Node IPC 调用子进程内
 *        boot() 出的 apiProxy handler。
 * PoC B：用 AbstractApiClient 家族两种接入路径验证协议层在 IPC 上工作：
 *        1) 复用 InProcessApiClient(远程 transport)
 *        2) 自定义 IpcApiClient extends AbstractApiClient（doFetch → IPC）
 *        调通 host.describe / session.list。
 */
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AbstractApiClient, InProcessApiClient } from '@deepseek-ai/dsh-host-apiproxy'

const here = dirname(fileURLToPath(import.meta.url))

interface Pending {
  stream: ReadableStream<Uint8Array>
  controller: ReadableStreamDefaultController<Uint8Array>
  resolve: (r: Response) => void
  reject: (e: Error) => void
}

/**
 * 远程 fetch transport：把 fetch 语义经 Node IPC 转发到 host 子进程，
 * 流式重建 Response（unary 与 SSE 长连接均适用）。
 */
class RemoteFetch {
  private counter = 0
  private pending = new Map<number, Pending>()

  constructor(private child: ChildProcess) {
    this.child.on('message', (msg: unknown) => {
      const m = msg as { type?: string; id?: number } | null
      if (m === null || typeof m !== 'object' || m.id === undefined) return
      const p = this.pending.get(m.id)
      if (p === undefined) return
      switch (m.type) {
        case 'fetch-headers': {
          const h = m as { status: number; statusText: string; headers: Record<string, string> }
          const response = new Response(p.stream, {
            status: h.status,
            statusText: h.statusText,
            headers: h.headers,
          })
          p.resolve(response)
          break
        }
        case 'fetch-chunk': {
          const c = m as { chunk: string }
          p.controller.enqueue(new Uint8Array(Buffer.from(c.chunk, 'base64')))
          break
        }
        case 'fetch-done': {
          p.controller.close()
          this.pending.delete(m.id)
          break
        }
        case 'fetch-error': {
          const e = m as { message: string }
          p.controller.error(new Error(e.message))
          this.pending.delete(m.id)
          p.reject(new Error(e.message))
          break
        }
      }
    })
  }

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const id = ++this.counter
    const url = input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input)
    return new Promise<Response>((resolve, reject) => {
      const entry: Pending = {
        stream: null as unknown as ReadableStream<Uint8Array>,
        controller: null as unknown as ReadableStreamDefaultController<Uint8Array>,
        resolve,
        reject,
      }
      // start 回调是同步执行的，此时 entry.controller 已被赋值；
      // 先建流再 send，规避 ReadableStream 构造期的 TDZ。
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          entry.controller = controller
        },
      })
      entry.stream = stream
      this.pending.set(id, entry)
      this.child.send({
        type: 'fetch',
        id,
        input: url,
        init: {
          method: init?.method,
          headers: init?.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : init?.headers,
          body: init?.body,
        },
      })
    })
  }
}

// ── 接入路径 1：复用官方 InProcessApiClient，transport 换成远程 IPC ──────────
function makeRemoteClient(child: ChildProcess): { client: InProcessApiClient; remote: RemoteFetch } {
  const remote = new RemoteFetch(child)
  return { client: new InProcessApiClient({ fetch: (i, init) => remote.fetch(i, init) }), remote }
}

// ── 接入路径 2：自定义 AbstractApiClient 子类（D2 所述形态）──────────────────
class IpcApiClient extends AbstractApiClient {
  constructor(private readonly remote: RemoteFetch) { super() }
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.remote.fetch(input, init)
  }
}

async function main(): Promise<void> {
  const child = fork(join(here, 'host-child.ts'), [], {
    execArgv: ['--import', 'tsx/esm'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })

  child.on('exit', (code) => {
    console.log(`[parent] host child exited with code ${code}`)
  })
  child.on('error', (error) => {
    console.error('[parent] host child error:', error)
  })

  // 等子进程 boot 完成（启动行出现）
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (process.send === undefined && false) return
    }, 0)
    // 简单等待：子进程 stdout 是 inherit 的，直接延时等待 boot 完成
    clearInterval(timer)
    setTimeout(resolve, 4000)
  })

  // ── PoC B 路径 1：InProcessApiClient + 远程 transport ──────────────────────
  const { client } = makeRemoteClient(child)
  console.log('── PoC B.1: InProcessApiClient over IPC ──')
  const describe = await client.host.describe({} as never)
  console.log('host.describe ok:', JSON.stringify(describe.result).slice(0, 400))

  const sessions = await client.sessions.list({} as never)
  console.log('session.list ok:', JSON.stringify(sessions.result).slice(0, 400))

  // ── PoC B 路径 2：自定义 IpcApiClient extends AbstractApiClient ───────────
  console.log('── PoC B.2: custom IpcApiClient extends AbstractApiClient ──')
  const ipcClient = new IpcApiClient(new RemoteFetch(child))
  const describe2 = await ipcClient.host.describe({} as never)
  console.log('host.describe (custom carrier) ok:', JSON.stringify(describe2.result).slice(0, 400))

  // ── 收尾：优雅关闭子进程 ───────────────────────────────────────────────────
  child.send({ type: 'shutdown' })
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill(); resolve() }, 5000)
    child.once('exit', () => { clearTimeout(t); resolve() })
  })
  console.log('── P0 PoC A+B done ──')
}

main().catch((error) => {
  console.error('P0 PoC failed:', error)
  process.exit(1)
})
