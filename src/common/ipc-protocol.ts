/**
 * IPC 协议：主进程 ↔ host 子进程 之间的 fetch 语义消息（D20：Node IPC channel）。
 *
 * host 子进程通过 Node IPC（fork 通道）暴露 `toFetchHandler(ctx.apiProxy)` 的 fetch 语义：
 *  - 请求方向：{ type:'fetch', id, input, init }
 *  - 响应方向：fetch-headers（元数据）→ 流式 fetch-chunk（base64）→ fetch-done / fetch-error
 *  - 生命周期：ready（boot 完成）/ shutdown（请求退出）/ diagnostic（诊断日志，走协议外也可）
 */

/** 序列化后的 fetch 请求参数（跨 IPC，AbortSignal 不过线）。 */
export interface WireFetchInit {
  method?: string
  headers?: Record<string, string> | string[][]
  body?: string
}

/** 主进程 → host 子进程 */
export type HostRequest =
  | { type: 'fetch'; id: number; input: string; init?: WireFetchInit }
  | { type: 'shutdown' }

/** host 子进程 → 主进程 */
export type HostResponse =
  | { type: 'ready' }
  | { type: 'diagnostic'; message: string }
  | { type: 'fetch-headers'; id: number; status: number; statusText: string; headers: Record<string, string> }
  | { type: 'fetch-chunk'; id: number; chunk: string } // base64
  | { type: 'fetch-done'; id: number }
  | { type: 'fetch-error'; id: number; message: string }

/** 主进程持有 host 子进程的通道抽象（可替换为 stdio JSON-RPC，见 D20）。 */
export interface HostChannel {
  send(msg: HostRequest): boolean
  onMessage(cb: (msg: HostResponse) => void): void
  onExit(cb: (code: number | null, signal: string | null) => void): void
  dispose(): void
}

/** 下一个 fetch 请求 id（进程内唯一）。 */
let nextId = 1
export const mintFetchId = (): number => nextId++
