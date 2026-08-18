/**
 * host 组合（P1 完整 UI 形态）：无真实 webserver 的 dsh 组合。
 *
 * 保留完整 web-app bundle（含 client 插件层：modules / connection / ui-* 等，
 * 供 client-modules 扫描生成 window.__DSH_BOOT__ 与 /plugins/ 服务）；
 * 通过 overlay 替换 transport 层：
 *  - webserver（真实 HTTP 监听）→ 禁用，改用 DeepCodeBuddy 虚拟 webServer（D10）
 *  - web-runtime / web-startup / client-hmr → 禁用（webRuntime 由 prepare 提供；
 *    静态服务与 index taps 由虚拟 webServer 内置）
 *  - directory-picker → -native（不依赖 HTTP 能力）
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const require = createRequire(import.meta.url)

/** 定位 dsh 仓库根（通过 @deepseek-ai/dsh-base 的 realpath 反推）。 */
export function resolveDshRoot(): string {
  const entry = realpathSync(require.resolve('@deepseek-ai/dsh-base'))
  // <dsh>/packages/bundle/base/lib/index.js → 上溯到仓库根
  return resolve(dirname(entry), '..', '..', '..', '..')
}

/** 构建 host 组合的完整 patch 栈（base + 全量 web-app + transport 替换 overlay）。 */
export function buildHostPatches(): PatchOptions[] {
  const dshRoot = resolveDshRoot()
  const bundlePatch = (pkgDir: string): string => join(dshRoot, 'packages', pkgDir, 'cordis.patch.yml')
  return [
    ...(loadOverlayPatches('deepcodebuddy', bundlePatch('bundle/base')) ?? []),
    ...(loadOverlayPatches('deepcodebuddy', bundlePatch('bundle/web-app')) ?? []),
    // transport 层替换（D10：不监听端口）
    { id: 'webserver', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'web-startup', disabled: true },
    { id: 'client-hmr', disabled: true },
    // directory-picker：native 实现（虚拟 webServer 不提供 HTTP 升级等能力）
    { id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-native' },
  ]
}
