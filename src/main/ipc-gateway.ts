/**
 * 主进程 IPC 网关（D10/D20）：桥接渲染进程（ipcRenderer）↔ host 子进程（Node IPC）。
 *
 * 渲染进程侧（bridge.js → preload）只与主进程通信，主进程经 HostChannel 转发；
 * 全程不监听网络端口。下行流（events.mux / events.host）以事件流形式跨两级转发。
 */
import { ipcMain, type WebContents } from 'electron'
import { RemoteFetch } from '../common/remote-fetch.ts'
import type { HostChannel } from '../common/ipc-protocol.ts'

export interface RendererFetchRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface RendererFetchResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string // 文本（JSON 信封）
}

let streamCounter = 1
const activeStreams = new Map<number, { abort: () => void }>()

export function registerIpcGateway(channel: HostChannel): void {
  const remote = new RemoteFetch(channel)

  // ── 一次性 unary fetch（host.describe / session.list / respond 等）────────
  ipcMain.handle('dsh:fetch', async (_event, req: RendererFetchRequest): Promise<RendererFetchResponse> => {
    const response = await remote.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    })
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    }
  })

  // ── 下行流（SSE 长连接：events.mux / events.host）────────────────────────
  ipcMain.on('dsh:stream:open', (event, payload: { path: string; streamId?: number }) => {
    const streamId = payload.streamId ?? streamCounter++
    const sender: WebContents = event.sender
    const controller = new AbortController()

    void (async () => {
      try {
        // bridge 传 pathname（如 /api/events.mux）；补全为绝对 URL（host 端 new Request 需要）
        const url = payload.path.startsWith('http') ? payload.path : `http://dsh.internal${payload.path}`
        const response = await remote.fetch(url, { signal: controller.signal })
        if (!response.ok || response.body === null) {
          sender.send('dsh:stream', { streamId, kind: 'error', message: `stream transport failure: HTTP ${response.status}` })
          return
        }
        sender.send('dsh:stream', { streamId, kind: 'open' })
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sender.send('dsh:stream', { streamId, kind: 'data', data: Buffer.from(value).toString('base64') })
        }
        sender.send('dsh:stream', { streamId, kind: 'end' })
      } catch (error) {
        sender.send('dsh:stream', { streamId, kind: 'error', message: String(error) })
      } finally {
        activeStreams.delete(streamId)
      }
    })()

    activeStreams.set(streamId, { abort: () => controller.abort() })
  })

  ipcMain.on('dsh:stream:close', (_event, payload: { streamId: number }) => {
    activeStreams.get(payload.streamId)?.abort()
    activeStreams.delete(payload.streamId)
  })

  // 渲染进程销毁时清理其流
  ipcMain.on('dsh:stream:dispose-all', (event) => {
    const sender: WebContents = event.sender
    for (const [streamId, { abort }] of activeStreams) {
      if (sender.isDestroyed() || sender.isDestroyed()) { abort() }
    }
    if (sender.isDestroyed()) activeStreams.clear()
  })
}

export function closeIpcGateway(): void {
  for (const { abort } of activeStreams.values()) abort()
  activeStreams.clear()
  ipcMain.removeHandler('dsh:fetch')
}
