/**
 * 主进程窗口：加载 apps/web dist（file:// + 相对路径版），preload 注入 IPC 桥。
 * contextIsolation 开启、nodeIntegration 关闭（D10 无网络面 + 渲染进程隔离）。
 */
import { BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'DeepCodeBuddy',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(here, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  // 外部链接交给系统浏览器（file:// 下无外部导航需要）
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 加载 dshapp:// 协议：页面内容（index.html / assets / /plugins/*）由 host 的
  // 虚拟 webServer 提供（含 __DSH_BOOT__ 注入），全程无网络端口（D10）
  void win.loadURL('dshapp://web/index.html')

  win.once('ready-to-show', () => win.show())

  return win
}
