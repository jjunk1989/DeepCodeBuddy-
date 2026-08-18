/**
 * 虚拟 webServer 服务（D10：不监听任何网络端口）。
 *
 * 提供与 @deepseek-ai/dsh-host-webserver 相同的 `webServer` 服务接口
 * （register / registerUpgrade / registerFallback / tapIndex / applyIndexTaps），
 * 使 web-runtime 依赖链上的插件（client-modules / connection / frontend-static）
 * 得以激活，但请求处理不经过 TCP 端口：
 *
 *  - handleRequest(method, pathname, headers, body)：以 node:http 语义（duck-typed
 *    IncomingMessage / ServerResponse）调用已注册路由；无匹配则回退到内置静态服务
 *  - 静态服务：读本项目 resources/web（apps/web dist 的相对路径版），index.html
 *    应用已注册的 index taps（client-modules 注入 window.__DSH_BOOT__）
 *  - upgrade 路由：返回 501（下行流走 IPC 桥，不经 HTTP）
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: unknown, head: Buffer) => void | Promise<void>
}

/** 捕获 handler 写入的响应（duck-typed ServerResponse，不触碰真实 socket）。 */
class CapturingResponse {
  statusCode = 200
  statusMessage = 'OK'
  headers: Record<string, string | number | string[]> = {}
  chunks: Buffer[] = []
  headersSent = false

  writeHead(status: number, headers?: Record<string, string | number | string[]>): this {
    this.statusCode = status
    if (headers !== undefined) this.headers = headers
    return this
  }

  setHeader(key: string, value: string | number | string[]): void {
    this.headers[key] = value
  }

  write(chunk?: unknown): boolean {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk as string | Uint8Array))
    return true
  }

  end(chunk?: unknown): this {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk as string | Uint8Array))
    return this
  }

  getHeaders(): Record<string, string | number | string[]> {
    return this.headers
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
}

export class VirtualWebServer extends Service {
  readonly host = '127.0.0.1'
  readonly port = 0 // 假值：不监听端口（D10）；本服务不经网络面

  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  private fallback: WebRoute['handler'] | undefined
  private readonly taps: Array<(html: string) => string> = []

  constructor(
    ctx: Context,
    private readonly distRoot: string,
    private readonly distIndex: string,
  ) {
    super(ctx, 'webServer')
  }

  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`virtual-webserver: duplicate ${route.kind} route "${route.path}"`)
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) throw new Error(`virtual-webserver: duplicate upgrade route "${route.path}"`)
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  registerFallback(handler: WebRoute['handler']): () => void {
    if (this.fallback !== undefined) throw new Error('virtual-webserver: fallback already registered')
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  tapIndex(tap: (html: string) => string): () => void {
    this.taps.push(tap)
    return () => {
      const i = this.taps.indexOf(tap)
      if (i !== -1) this.taps.splice(i, 1)
    }
  }

  applyIndexTaps(html: string): string {
    return this.taps.reduce((h, tap) => tap(h), html)
  }

  /** 以 fetch 语义处理一个请求（由 host 的 IPC 通道调用）。 */
  async handleRequest(
    method: string,
    pathname: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; statusText: string; headers: Record<string, string | string[]>; body: Buffer }> {
    const res = new CapturingResponse()
    const req = { method, url: pathname, headers: { ...headers } } as unknown as IncomingMessage

    const route = this.match(pathname)
    const resLike = res as unknown as ServerResponse
    try {
      if (route !== undefined) {
        await route.handler(req, resLike)
      } else if (this.fallback !== undefined) {
        await this.fallback(req, resLike)
      } else {
        await this.serveStatic(pathname, res)
      }
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`internal error: ${String(error)}`)
    }

    return {
      status: res.statusCode,
      statusText: res.statusMessage,
      headers: res.headers as Record<string, string | string[]>,
      body: Buffer.concat(res.chunks),
    }
  }

  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        if (best === undefined || prefix.length > best.path.length) best = route
      }
    }
    return best
  }

  /** 静态服务：读本项目 resources/web；index.html 应用 taps（注入 __DSH_BOOT__）。 */
  private async serveStatic(pathname: string, res: CapturingResponse): Promise<void> {
    const safePath = normalize(pathname).replace(/^([/\\])+/, '')
    const target = safePath === '' || safePath === '/'
      ? this.distIndex
      : resolve(this.distRoot, safePath)

    if (safePath === '' || safePath === '/' || target === this.distIndex) {
      const html = this.applyIndexTaps(await readFile(this.distIndex, 'utf8'))
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
      res.end(html)
      return
    }

    if (!target.startsWith(resolve(this.distRoot))) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (!existsSync(target)) {
      // assets 保持 404；其他路径按 SPA 语义回退 index
      if (pathname.startsWith('/assets/')) {
        res.writeHead(404)
        res.end()
      } else {
        const html = this.applyIndexTaps(await readFile(this.distIndex, 'utf8'))
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
        res.end(html)
      }
      return
    }
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  }
}

export default VirtualWebServer
