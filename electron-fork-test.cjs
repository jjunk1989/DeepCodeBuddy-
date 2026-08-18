// 诊断：Electron 主进程 fork host 子进程的环境差异
const { app } = require('electron')
const { fork } = require('node:child_process')
const { join } = require('node:path')

const args = process.argv
const useHome = args.includes('--home')

app.whenReady().then(() => {
  console.log('[forktest] forking host (DSH_HOME=' + useHome + ')...')
  const env = { ...process.env }
  if (useHome) env.DSH_HOME = join(__dirname, '.runtime', 'forktest-home')
  const child = fork(join(__dirname, 'dist', 'host', 'index.js'), [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    cwd: __dirname,
    execArgv: ['--expose-internals'],
    env,
  })
  child.on('message', (msg) => {
    if (msg && msg.type === 'ready') {
      console.log('[forktest] HOST READY')
      child.send({ type: 'shutdown' })
    }
  })
  child.on('exit', (code) => {
    console.log('[forktest] host exited', code)
    app.quit()
  })
  setTimeout(() => { console.log('[forktest] timeout'); child.kill(); app.exit(2) }, 30000)
})
