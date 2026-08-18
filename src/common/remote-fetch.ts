/**
 * 远程 fetch transport：把 fetch 语义经 HostChannel 转发到 host 子进程，
 * 流式重建 Response（unary 与 SSE 长连接统一适用）。
 *
 * 这是 AbstractApiClient 的 `doFetch` 在 DeepCodeBuddy 形态下的传输实现（D2/D20）。
 */
import type { HostChannel, HostResponse, WireFetchInit } from './ipc-protocol.ts'
import { mintFetchId } from './ipc-protocol.ts'

interface Pending {
  stream: ReadableStream<Uint8Array>
  controller: ReadableStreamDefaultController<Uint8Array>
  resolve: (r: Response) => void
  reject: (e: Error) => void
}

export class RemoteFetch {
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly channel: HostChannel) {
    this.channel.onMessage((msg) => this.onMessage(msg))
  }

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const id = mintFetchId()
    const url = input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input)
    return new Promise<Response>((resolve, reject) => {
      const entry: Pending = {
        stream: null as unknown as ReadableStream<Uint8Array>,
        controller: null as unknown as ReadableStreamDefaultController<Uint8Array>,
        resolve,
        reject,
      }
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => { entry.controller = controller },
      })
      entry.stream = stream
      this.pending.set(id, entry)
      this.channel.send({ type: 'fetch', id, input: url, init: serializeInit(init) })
    })
  }

  private onMessage(msg: HostResponse): void {
    if (msg.type !== 'fetch-headers' && msg.type !== 'fetch-chunk' && msg.type !== 'fetch-done' && msg.type !== 'fetch-error') return
    const p = this.pending.get(msg.id)
    if (p === undefined) return
    switch (msg.type) {
      case 'fetch-headers':
        p.resolve(new Response(p.stream, {
          status: msg.status,
          statusText: msg.statusText,
          headers: msg.headers,
        }))
        break
      case 'fetch-chunk':
        p.controller.enqueue(new Uint8Array(Buffer.from(msg.chunk, 'base64')))
        break
      case 'fetch-done':
        p.controller.close()
        this.pending.delete(msg.id)
        break
      case 'fetch-error':
        p.controller.error(new Error(msg.message))
        this.pending.delete(msg.id)
        p.reject(new Error(msg.message))
        break
    }
  }
}

function serializeInit(init: RequestInit | undefined): WireFetchInit | undefined {
  if (init === undefined) return undefined
  return {
    method: init.method,
    headers: init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : init.headers,
    body: init.body as string | undefined,
  }
}
