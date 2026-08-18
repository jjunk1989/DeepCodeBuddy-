/**
 * host 子进程管理器（D9）：spawn、就绪信号、优雅关闭、崩溃检测与重启。
 * 通道为 Node IPC（fork，D20）。
 */
import { fork, type ChildProcess } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostChannel, HostRequest, HostResponse } from '../common/ipc-protocol.ts'

const here = dirname(fileURLToPath(import.meta.url))

export interface HostManagerOptions {
  /** 是否在 host 异常退出时自动重启。 */
  restart?: boolean
  /** host 退出回调（含主动关闭）。 */
  onExitCallback?: (code: number | null, reason: 'clean' | 'crash' | 'killed') => void
}

export class HostManager implements HostChannel {
  private child: ChildProcess | undefined
  private messageCbs = new Set<(msg: HostResponse) => void>()
  private exitCbs = new Set<(code: number | null, signal: string | null) => void>()
  private ready = false
  private readonly restart: boolean
  private readonly onExitCallback?: (code: number | null, reason: 'clean' | 'crash' | 'killed') => void
  private shuttingDown = false

  constructor(options: HostManagerOptions = {}) {
    this.restart = options.restart ?? true
    this.onExitCallback = options.onExitCallback
  }

  /** 启动 host 子进程。 */
  start(): void {
    if (this.child !== undefined) return
    const child = fork(join(here, '..', 'host', 'index.js'), [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      cwd: resolve(here, '..', '..'), // 项目根
      // --expose-internals：让 dsh 的 Loader 拿到 Node internal loader，从而用
      // bareModuleBaseUrl（本项目 node_modules）解析顶层裸包（Electron fork 差异）
      execArgv: ['--expose-internals'],
      env: { ...process.env },
    })
    this.child = child
    this.ready = false

    child.on('message', (msg: HostResponse) => {
      if (msg?.type === 'ready') {
        this.ready = true
        process.stdout.write('[main] host ready\n')
      }
      for (const cb of this.messageCbs) {
        try { cb(msg) } catch (error) { console.error('[main] host message listener threw:', error) }
      }
    })

    child.on('exit', (code, signal) => {
      const wasClean = this.shuttingDown || code === 0
      const reason: 'clean' | 'crash' | 'killed' = this.shuttingDown ? 'clean' : code === 0 ? 'clean' : 'crash'
      process.stdout.write(`[main] host exited code=${code} signal=${signal} reason=${reason}\n`)
      this.child = undefined
      this.ready = false
      for (const cb of this.exitCbs) { try { cb(code, signal) } catch { /* ignore */ } }
      this.onExitCallback?.(code, reason)
      if (this.restart && !this.shuttingDown && reason === 'crash') {
        process.stdout.write('[main] restarting host...\n')
        this.start()
      }
    })

    child.on('error', (error) => {
      console.error('[main] host spawn error:', error)
      this.child = undefined
    })
  }

  get isReady(): boolean { return this.ready }

  send(msg: HostRequest): boolean {
    if (this.child === undefined || !this.child.connected) return false
    return this.child.send(msg)
  }

  onMessage(cb: (msg: HostResponse) => void): void {
    this.messageCbs.add(cb)
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.add(cb)
  }

  /** 优雅关闭：dispose → 退出（参考 dsh-sdk-client 的 close 阶梯）。 */
  async stop(): Promise<void> {
    this.shuttingDown = true
    const child = this.child
    if (child === undefined) return
    child.send({ type: 'shutdown' })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve() }, 3000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }

  dispose(): void {
    this.child?.kill('SIGKILL')
    this.child = undefined
    this.messageCbs.clear()
    this.exitCbs.clear()
  }
}
