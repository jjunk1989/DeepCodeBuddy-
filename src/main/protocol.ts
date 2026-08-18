/**
 * 主进程自定义协议 `dshapp://`：渲染进程的全部页面请求（index.html、assets、
 * /plugins/*）经此协议转发到 host 子进程（虚拟 webServer），无需任何网络端口（D10）。
 *
 *  - dshapp://web/index.html  → host 的 /index.html（虚拟 webServer 注入 __DSH_BOOT__）
 *  - dshapp://web/assets/...  → host 静态资源
 *  - dshapp://web/plugins/... → host 的 client-modules 路由
 */
import { protocol } from 'electron'
import { RemoteFetch } from '../common/remote-fetch.ts'
import type { HostChannel } from '../common/ipc-protocol.ts'

/** 必须在 app ready 之前调用。 */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'dshapp',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }])
}

/** app ready 后调用：注册协议处理。 */
export function registerAppProtocol(channel: HostChannel): void {
  const remote = new RemoteFetch(channel)
  protocol.handle('dshapp', async (request) => {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/web/, '') || '/'
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => { headers[key] = value })
    // body 以文本传递：Uint8Array 跨 Node IPC（JSON 序列化）会损坏为普通对象，
    // host 端 new Request 会得到 [object Object] → 400。文本跨两级 IPC 安全。
    const text = await request.text().catch(() => '')
    return remote.fetch(`http://dsh.internal${path}`, {
      method: request.method,
      headers,
      body: text.length > 0 ? text : undefined,
    })
  })
}
