/**
 * 将 deepseek-harness 仓库内所有 @deepseek-ai/* 包（含 vendored cordis）通过
 * junction 链接到本项目的 node_modules/@deepseek-ai 下，使 P1 代码可直接
 * import 本地 dsh 源码/构建产物（D1 源码形态 + D8 本地 pin 版本）。
 *
 * Windows 使用 junction（mklink /J），无需管理员权限；其它平台用 symlink。
 * 用法：node scripts/link-dsh.mjs
 */
import { readdirSync, existsSync, mkdirSync, rmSync, symlinkSync, readFileSync, readlinkSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dshRoot = resolve(root, '..', 'deepseek-harness')
const scopeDir = join(root, 'node_modules', '@deepseek-ai')

/** 收集 dsh 仓库内所有 name 以 @deepseek-ai/ 开头的包目录。 */
function collectScopedPackages(base) {
  const found = new Map() // name -> packageDir
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const pkgJson = join(full, 'package.json')
        if (existsSync(pkgJson)) {
          try {
            const name = JSON.parse(readFileSync(pkgJson, 'utf8')).name
            if (typeof name === 'string' && name.startsWith('@deepseek-ai/')) found.set(name, full)
          } catch { /* ignore malformed */ }
        }
        walk(full)
      }
    }
  }
  walk(base)
  return found
}

const pkgs = collectScopedPackages(dshRoot)
console.log(`found ${pkgs.size} @deepseek-ai packages in ${dshRoot}`)

mkdirSync(scopeDir, { recursive: true })

// 清理旧链接（保留真实目录中非链接的条目）
for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
  const full = join(scopeDir, entry.name)
  try {
    const real = resolve(entry.isSymbolicLink() ? '' : full)
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      // 只移除我们创建的 junction/symlink（目标是 dsh 仓库路径的）
      const target = readlinkSafe(full)
      if (target && target.includes('deepseek-harness')) rmSync(full, { recursive: true, force: true })
    }
  } catch { /* ignore */ }
}

for (const [name, pkgDir] of pkgs) {
  const linkPath = join(scopeDir, name.split('/').pop())
  if (existsSync(linkPath)) continue
  const target = resolve(pkgDir)
  if (process.platform === 'win32') {
    execSync(`cmd /c mklink /J "${linkPath}" "${target}"`, { stdio: 'ignore' })
  } else {
    symlinkSync(target, linkPath, 'dir')
  }
}

console.log(`linked ${pkgs.size} packages into ${relative(root, scopeDir)}`)
console.log('sample:', [...pkgs.keys()].slice(0, 8).join(', '))

function readlinkSafe(p) {
  try { return readlinkSync(p) } catch { return undefined }
}
