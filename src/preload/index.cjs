/**
 * Preload 脚本：通过 contextBridge 向渲染进程暴露 `window.__dshBridge`。
 *
 *  - fetch(req): 一次性 unary 请求（host.describe / session.list / respond 等）
 *  - openStream(path): 下行流（events.mux / events.host 的 SSE 长连接），返回事件订阅句柄
 *
 * 渲染进程 bridge.js 用它替换 window.fetch / window.WebSocket，使 apps/web 的
 * WebApiClient（doFetch → globalThis.fetch、下行流 → WebSocket）全部走 IPC。
 */
const { contextBridge, ipcRenderer } = require('electron')

let streamCounter = 1

contextBridge.exposeInMainWorld('__dshBridge', {
  fetch: (req) => ipcRenderer.invoke('dsh:fetch', req),
  openStream: (path, streamId) => {
    const id = streamId !== undefined ? streamId : streamCounter++
    const listeners = new Set()
    const onIpc = (_event, payload) => {
      if (payload.streamId !== id) return
      for (const cb of listeners) {
        try { cb(payload) } catch (err) { console.error('[bridge] stream listener threw:', err) }
      }
    }
    ipcRenderer.on('dsh:stream', onIpc)
    ipcRenderer.send('dsh:stream:open', { path, streamId: id })
    return {
      onEvent(cb) {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      close() {
        ipcRenderer.removeListener('dsh:stream', onIpc)
        ipcRenderer.send('dsh:stream:close', { streamId: id })
      },
    }
  },
})
