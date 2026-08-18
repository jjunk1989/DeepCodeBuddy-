/**
 * DeepCodeBuddy 主进程入口。
 *
 * 生命周期（P1）：
 *   app ready → 启动 host 子进程 → 注册 IPC 网关 → 创建窗口
 *   退出 → 优雅关闭 host（dispose）→ 单实例锁（requestSingleInstanceLock）
 */
import { app } from 'electron'
import { HostManager } from './host-manager.ts'
import { registerIpcGateway, closeIpcGateway } from './ipc-gateway.ts'
import { registerSchemePrivileges, registerAppProtocol } from './protocol.ts'
import { createMainWindow } from './window.ts'

// 自定义协议特权必须在 app ready 之前注册
registerSchemePrivileges()

// 单实例锁：第二个实例启动时聚焦已有窗口（P1）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  const host = new HostManager({ restart: true })

  app.on('second-instance', () => {
    // 聚焦已有窗口（暂以单窗口实现）
  })

  await app.whenReady()

  host.start()
  registerIpcGateway(host)
  registerAppProtocol(host)

  createMainWindow()

  app.on('activate', () => {
    // macOS：点击 Dock 图标时若无窗口则重建
    if (require('electron').BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })

  // 优雅关闭：先 dispose host 树，再退出
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    closeIpcGateway()
    void host.stop().finally(() => app.exit(0))
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
