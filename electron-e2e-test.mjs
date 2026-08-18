/**
 * P1 E2E 验证（完整 UI）：
 *  - 渲染进程经 dshapp:// 协议加载页面（host 虚拟 webServer 提供 index.html，注入 __DSH_BOOT__）
 *  - 页面 shell 应从 /plugins/* 加载 client 插件，渲染 UI
 *  - bridge fetch（/api → IPC → host）可用
 */
import { app, BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostManager } from './dist/main/host-manager.js'
import { registerIpcGateway, closeIpcGateway } from './dist/main/ipc-gateway.js'
import { registerSchemePrivileges, registerAppProtocol } from './dist/main/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))

registerSchemePrivileges()

app.whenReady().then(async () => {
  const host = new HostManager({ restart: false })
  host.start()
  registerIpcGateway(host)
  registerAppProtocol(host)

  const win = new BrowserWindow({
    width: 1100, height: 700, show: false,
    webPreferences: {
      preload: join(here, 'dist', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 等 host ready
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (host.isReady) { clearInterval(t); resolve() }
    }, 200)
    setTimeout(() => { clearInterval(t); resolve() }, 30000)
  })

  await win.loadURL('dshapp://web/index.html')
  console.log('[e2e] page loaded via dshapp://')

  // 检查 window.fetch 是否被 bridge 替换 + 页面 origin + __dshBridge
  const envCheck = await win.webContents.executeJavaScript(`({
    origin: location.origin,
    hasBridge: typeof window.__dshBridge !== 'undefined',
    bridgeKeys: window.__dshBridge ? Object.keys(window.__dshBridge) : [],
    fetchSrc: window.fetch.toString().slice(0, 60),
  })`)
  console.log('[e2e] env:', JSON.stringify(envCheck))

  // 检查 __DSH_BOOT__ 是否注入（client-modules 的 index tap）
  const bootCheck = await win.webContents.executeJavaScript(`({
    hasBoot: typeof window.__DSH_BOOT__ === 'object' && window.__DSH_BOOT__ !== null,
    pluginCount: window.__DSH_BOOT__ && window.__DSH_BOOT__.plugins ? window.__DSH_BOOT__.plugins.length : -1,
    moduleCount: window.__DSH_BOOT__ && window.__DSH_BOOT__.modules ? window.__DSH_BOOT__.modules.length : -1,
  })`)
  console.log('[e2e] __DSH_BOOT__:', JSON.stringify(bootCheck))

  // bridge fetch（渲染进程 /api → IPC → host）
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const r = await window.fetch('http://dsh.internal/api/host.describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'e2e-ui-1', method: 'host.describe', payload: {} })
      })
      return { status: r.status, body: (await r.text()).slice(0, 200) }
    })()
  `)
  console.log('[e2e] bridge fetch:', JSON.stringify(result))

  // 模拟页面 connection.rpc 的 typert 请求（信封与 api-gateway client 一致）
  const rpcTest = await win.webContents.executeJavaScript(`
    (async () => {
      const r = await window.fetch('http://dsh.internal/api/dynamicCordisRunner/inventory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'e2e-typert-1', method: 'dynamicCordisRunner/inventory', payload: { args: {} } })
      })
      return { status: r.status, body: (await r.text()).slice(0, 300) }
    })()
  `)
  console.log('[e2e] typert rpc (renderer):', JSON.stringify(rpcTest))

  // 等待 UI 渲染（页面 cordis 树 settle，插件加载），观察 DOM
  await new Promise((r) => setTimeout(r, 15000))
  const domCheck = await win.webContents.executeJavaScript(`({
    rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
    bodyText: document.body.innerText.slice(0, 120),
  })`)
  console.log('[e2e] DOM after settle:', JSON.stringify(domCheck))

  closeIpcGateway()
  await host.stop()
  app.quit()
}).catch((error) => {
  console.error('[e2e] failed:', error)
  app.exit(1)
})
