// 最小 Electron 冒烟：确认本环境能启动 electron 主进程与窗口
const { app, BrowserWindow } = require('electron')
console.log('[smoke] electron starting, version', process.versions.electron)
app.whenReady().then(() => {
  console.log('[smoke] app ready')
  const win = new BrowserWindow({ width: 800, height: 600, show: false })
  win.loadURL('data:text/html,<h1>ok</h1>').then(() => {
    console.log('[smoke] window loaded ok')
    app.quit()
  }).catch((e) => {
    console.error('[smoke] window load failed:', e)
    app.exit(1)
  })
})
app.on('window-all-closed', () => app.quit())
