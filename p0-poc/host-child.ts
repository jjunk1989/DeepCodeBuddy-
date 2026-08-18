/**
 * P0 PoC — host 子进程侧。
 *
 * 验证点（PoC A 核心）：
 *  - 在子进程内 boot() 一个 dsh host 组合（base + web-app bundle，禁用 webserver 行）
 *  - 全程不监听任何网络端口：通过 ctx.apiProxy + toFetchHandler 得到纯内存 fetch handler
 *  - 通过 Node IPC（fork 通道）把该 handler 暴露给父进程，父进程可远程调用 /api/*
 *
 * 通信协议（子进程侧接收）：
 *  - { type: 'fetch', id, input, init }           → 执行一次 fetch，流式回传
 *  - { type: 'shutdown' }                          → dispose 整棵树后退出
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

const here = dirname(fileURLToPath(import.meta.url))

// ── 1. 组合 patch 栈：base + 过滤后的 web-app host 层 ───────────────────────
// PoC 跑在 deepseek-harness 源码树内，bundle 包位置固定，直接按仓库布局定位。
function bundlePatchPath(pkgDir: string): string {
  return join(here, '..', 'packages', pkgDir, 'cordis.patch.yml')
}

// 剔除 web transport 与 browser 层：不监听端口（D10）、无浏览器插件。
const WEB_DISABLE = new Set([
  'webserver', 'web-startup', 'web-runtime', 'client-hmr', 'modules', 'connection',
  'api-remotes', 'client-runtime', 'cordis-client-runner', 'locale',
])

function isWebRow(row: { id?: string }): boolean {
  const id = row.id ?? ''
  return WEB_DISABLE.has(id) || id.startsWith('ui-') || id.startsWith('client-')
}

function filterWebPatches(list: ReturnType<typeof loadOverlayPatches>): ReturnType<typeof loadOverlayPatches> {
  const out: ReturnType<typeof loadOverlayPatches> = []
  for (const patch of list ?? []) {
    const p = patch as { insert?: Array<{ id?: string; name?: string }> } & { id?: string }
    if (Array.isArray(p.insert)) {
      const kept = p.insert
        .filter((row) => !isWebRow(row))
        .map((row) => row.id === 'directory-picker'
          ? { ...row, name: '@deepseek-ai/dsh-host-directory-picker-native' }
          : row)
      if (kept.length > 0) out.push({ ...patch, insert: kept })
    } else if (typeof p.id === 'string' && isWebRow({ id: p.id })) {
      // 单行 patch 命中 web 层 → 丢弃
    } else {
      out.push(patch)
    }
  }
  return out
}

const patches = [
  ...(loadOverlayPatches('p0', bundlePatchPath('bundle/base')) ?? []),
  ...filterWebPatches(loadOverlayPatches('p0', bundlePatchPath('bundle/web-app'))),
]

// ── 2. 空根配置（Loader 需要一个真实 include 根来锚定 baseUrl）──────────────
const tmpDir = join(here, '.tmp')
mkdirSync(tmpDir, { recursive: true })
const rootConfig = join(tmpDir, 'cordis.yml')
writeFileSync(rootConfig, '# p0 poc root — empty entry list, composed via patches\n[]\n')

// ── 3. boot 并暴露 fetch handler ─────────────────────────────────────────────
const ctx = await boot('p0', rootConfig, patches)
const handler = toFetchHandler(ctx.apiProxy as never)
console.log('[host-child] booted, apiProxy available, serving via IPC (no port bound)')

// ── 4. IPC 服务循环 ──────────────────────────────────────────────────────────
process.on('message', async (msg: any) => {
  if (msg?.type === 'fetch') {
    const { id } = msg
    try {
      // handler 的 fetch 接受 (RequestInfo, init)；doFetch 侧传的是 URL + init
      const req = new Request(msg.input as string, msg.init as RequestInit)
      const response = await handler.fetch(req)
      // 先回传元数据，再流式回传 body chunks
      process.send!({
        type: 'fetch-headers', id,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      })
      if (response.body !== null) {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          process.send!({ type: 'fetch-chunk', id, chunk: Buffer.from(value).toString('base64') })
        }
      }
      process.send!({ type: 'fetch-done', id })
    } catch (error) {
      process.send!({ type: 'fetch-error', id, message: String(error) })
    }
  } else if (msg?.type === 'shutdown') {
    console.log('[host-child] shutdown requested, disposing tree')
    await ctx.fiber.dispose().catch(() => undefined)
    process.exit(0)
  }
})

process.on('disconnect', () => {
  // 父进程断开 → 主动退出
  ctx.fiber.dispose().catch(() => undefined).finally(() => process.exit(0))
})
