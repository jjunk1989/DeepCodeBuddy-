/**
 * host 子进程入口（跑在独立子进程，由 Electron 主进程 fork 启动，D9/D20）。
 *
 *  - boot() 组合 host-only 配置（不监听端口）
 *  - toFetchHandler(ctx.apiProxy) → 纯内存 fetch handler
 *  - 经 Node IPC（fork 通道）暴露 fetch 语义：协议与诊断分离，诊断走 stderr
 *  - 生命周期：ready / shutdown（dispose → 退出）/ 崩溃由主进程处理
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { buildHostPatches } from './composition.ts'
import { VirtualWebServer } from './virtual-webserver.ts'
import type { HostRequest, HostResponse, WireFetchInit } from '../common/ipc-protocol.ts'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  const patches = buildHostPatches()

  // 空根配置（Loader 需要真实 include 根锚定 baseUrl）
  const tmpDir = join(here, '..', '..', '.runtime', 'host')
  mkdirSync(tmpDir, { recursive: true })
  const rootConfig = join(tmpDir, 'cordis.yml')
  writeFileSync(rootConfig, '# deepcodebuddy host root — empty entry list, composed via patches\n[]\n')

  // 静态资源根（apps/web dist 的相对路径版，copy-web-dist 生成）
  const distRoot = resolve(here, '..', '..', 'resources', 'web')
  const distIndex = join(distRoot, 'index.html')

  process.stderr.write('[host] booting...\n')
  // Loader 顶层裸包从本项目的 node_modules 解析（D1 源码形态：DeepCodeBuddy 拥有
  // 完整插件集），避免 Electron 下 junction realpath 后从 dsh 仓库路径解析失败。
  const nodeModulesUrl = pathToFileURL(resolve(here, '..', '..', 'node_modules')).href + '/'
  let webServer: VirtualWebServer | undefined
  const ctx = await boot('deepcodebuddy-host', rootConfig, patches, (hostCtx) => {
    // 虚拟 webServer（D10：不监听端口）：Service 构造即注册 webServer 服务，
    // 使 client-modules / connection 依赖链激活
    webServer = new VirtualWebServer(hostCtx, distRoot, distIndex)
    // webRuntime：web-app bundle 的 web-runtime 行被禁用，这里直接提供等价服务
    hostCtx.provide('webRuntime', { lanAddresses: [], trustedHosts: [] })
  }, nodeModulesUrl)
  const apiProxyHandler = toFetchHandler(ctx.apiProxy as never)
  // /api/* 用 connection 的共享 fetch handler：让 typert 拦截器（dynamicCordisRunner/* 等
  // @Remote 端点）生效，fallback 仍为 apiProxy（等价于 connection 的 /api 路由，D10）
  const connection = ctx.get('connection') as HostConnectionService | undefined
  const handler = connection !== undefined && typeof connection.createSharedFetchHandler === 'function'
    ? connection.createSharedFetchHandler('/api', apiProxyHandler as never)
    : apiProxyHandler
  const server = webServer ?? (ctx.get('webServer') as VirtualWebServer)
  process.stderr.write('[host] booted, apiProxy + virtual webServer serving via IPC (no port bound)\n')

  process.send?.({ type: 'ready' } satisfies HostResponse)

  // IPC 服务循环（协议走 IPC 通道；诊断走 stderr，见 P1）
  process.on('message', (msg: HostRequest) => {
    if (msg?.type === 'fetch') {
      void handleFetch(handler, server, msg.id, msg.input, msg.init)
    } else if (msg?.type === 'shutdown') {
      process.stderr.write('[host] shutdown requested, disposing tree\n')
      void ctx.fiber.dispose().catch(() => undefined).finally(() => process.exit(0))
    }
  })

  process.on('disconnect', () => {
    void ctx.fiber.dispose().catch(() => undefined).finally(() => process.exit(0))
  })

  // 崩溃上报：未捕获异常/拒绝 → 记录诊断并退出（主进程负责重启）
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[host] uncaughtException: ${String(error)}\n${error.stack ?? ''}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[host] unhandledRejection: ${String(reason)}\n`)
  })
}

async function handleFetch(
  handler: { fetch: (req: Request) => Promise<Response> },
  webServer: VirtualWebServer,
  id: number,
  input: string,
  init: WireFetchInit | undefined,
): Promise<void> {
  try {
    const req = new Request(input, init as RequestInit)
    const url = new URL(input)
    // /api/* → connection 共享 fetch handler（typert 拦截器 + apiProxy fallback，D10）
    // 其他路径（/plugins/*、静态资源、/）→ 虚拟 webServer（client-modules 路由 + 内置静态服务）
    const response = url.pathname.startsWith('/api/')
      ? await handler.fetch(req)
      : await webServerToResponse(webServer, req)

    process.send?.({
      type: 'fetch-headers', id,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    } satisfies HostResponse)
    if (response.body !== null) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        process.send?.({ type: 'fetch-chunk', id, chunk: Buffer.from(value).toString('base64') } satisfies HostResponse)
      }
    }
    process.send?.({ type: 'fetch-done', id } satisfies HostResponse)
  } catch (error) {
    process.send?.({ type: 'fetch-error', id, message: String(error) } satisfies HostResponse)
  }
}

/** 调用虚拟 webServer 处理请求，组装为 fetch Response。 */
async function webServerToResponse(webServer: VirtualWebServer, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const body = await req.text().catch(() => '')
  const result = await webServer.handleRequest(
    req.method,
    url.pathname,
    Object.fromEntries(req.headers.entries()),
    body,
  )
  return new Response(new Uint8Array(result.body), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers as Record<string, string>,
  })
}

function describeError(error: unknown, depth = 0): string {
  const pad = '  '.repeat(depth)
  if (error instanceof AggregateError) {
    return `${pad}AggregateError(${error.errors.length}):\n${error.errors.map((e) => describeError(e, depth + 1)).join('\n')}`
  }
  if (error instanceof Error) {
    const cause = error.cause !== undefined ? `\n${pad}cause: ${describeError(error.cause, depth + 1)}` : ''
    return `${pad}${error.message}${cause}`
  }
  return `${pad}${String(error)}`
}

main().catch((error) => {
  process.stderr.write(`[host] fatal:\n${describeError(error)}\n`)
  process.exit(1)
})
