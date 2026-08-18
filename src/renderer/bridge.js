/**
 * 渲染进程桥（注入到 apps/web dist 的 index.html，在 entry 之前同步执行）。
 *
 * 无侵入替换全局 fetch / WebSocket：
 *  - window.fetch：`/api/*` 路径 → __dshBridge.fetch（IPC 到主进程 → host 子进程）
 *  - window.WebSocket：/api/events.* → __dshBridge.openStream（SSE 下行流，模拟 WebSocket 接口）
 *
 * apps/web 的 WebApiClient（doFetch → globalThis.fetch、mux/host → 原生 WebSocket）
 * 因此无需改动 dsh 代码即可全部走 IPC（D10 无网络面）。
 */
(function () {
  'use strict'
  const bridge = window.__dshBridge
  if (!bridge) return

  // ── 1. fetch 代理：/api/* 走 IPC ────────────────────────────────────────────
  const nativeFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    let url
    try {
      url = new URL(typeof input === 'string' ? input : input.url, window.location.href)
    } catch {
      return nativeFetch(input, init)
    }
    if (url.pathname.startsWith('/api/')) {
      return bridge.fetch({
        url: url.toString(),
        method: init && init.method,
        headers: init && init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : init && init.headers,
        body: init && init.body,
      }).then((result) => new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      }))
    }
    return nativeFetch(input, init)
  }

  // ── 2. WebSocket 代理：/api/events.* 下行流走 IPC ───────────────────────────
  class BridgeWebSocket extends EventTarget {
    constructor(url, protocols) {
      super()
      this.url = url
      this.protocol = ''
      this.bufferedAmount = 0
      this.readyState = 0 // CONNECTING
      this.extensions = ''
      this.binaryType = 'blob'
      this._stream = null
      try {
        const path = new URL(url).pathname
        this._stream = bridge.openStream(path)
        this._stream.onEvent((payload) => this._onEvent(payload))
      } catch (err) {
        console.error('[bridge] WebSocket bridge init failed:', err)
        this.readyState = 3 // CLOSED
      }
    }

    _onEvent(payload) {
      switch (payload.kind) {
        case 'open':
          this.readyState = 1 // OPEN
          this.dispatchEvent(new Event('open'))
          break
        case 'data':
          // host 下行流是 SSE 文本（`data: {...}\n\n` + `: connected` 注释帧）；
          // base64 → 文本 → 按 SSE 帧解析，只把 `data:` 内容作为 message 触发
          // （与 WebApiClient 期望的裸 JSON 帧对齐）
          let text
          try { text = atob(payload.data) } catch { text = '' }
          this._feedSse(text)
          break
        case 'end':
          this.readyState = 3
          this.dispatchEvent(new Event('close'))
          break
        case 'error':
          this.readyState = 3
          this.dispatchEvent(new Event('error'))
          this.dispatchEvent(new Event('close'))
          break
      }
    }

    _feedSse(text) {
      this._sseBuffer = (this._sseBuffer || '') + text
      let idx
      while ((idx = this._sseBuffer.indexOf('\n\n')) !== -1) {
        const frame = this._sseBuffer.slice(0, idx)
        this._sseBuffer = this._sseBuffer.slice(idx + 2)
        const data = frame.split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('')
        if (data === '') continue // 注释/keep-alive 帧
        this.dispatchEvent(new MessageEvent('message', { data }))
      }
    }

    send() {
      // dsh 下行流为 downlink-only；send 静默（WebApiClient 不用 send）
      throw new Error('BridgeWebSocket is downlink-only')
    }

    close() {
      if (this._stream) { this._stream.close(); this._stream = null }
      if (this.readyState === 1 || this.readyState === 0) {
        this.readyState = 2 // CLOSING
        this.readyState = 3 // CLOSED
        this.dispatchEvent(new Event('close'))
      }
    }
  }

  window.WebSocket = BridgeWebSocket
})()
