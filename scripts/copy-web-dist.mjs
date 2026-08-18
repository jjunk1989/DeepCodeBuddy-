/**
 * 复制 apps/web dist（相对路径版）到 resources/web，并注入渲染进程桥：
 *  1. 在 index.html 的 </head> 前插入 <script src="./bridge.js">（普通 script 同步执行，
 *     早于 defer 的 module entry，确保 fetch/WebSocket 在 apps/web 启动前被替换）
 *  2. 复制 bridge.js 与 preload 到目标
 */
import { readdirSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const src = resolve(root, '..', 'deepseek-harness', 'apps', 'web', 'dist')
const dest = join(root, 'resources', 'web')

if (!existsSync(src)) {
  console.error(`web dist not found: ${src}\nRun build:web in deepseek-harness first.`)
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

function copyDir(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, entry.name)
    const d = join(to, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

copyDir(src, dest)

// 渲染进程桥 + preload
copyFileSync(join(root, 'src', 'renderer', 'bridge.js'), join(dest, 'bridge.js'))
mkdirSync(join(root, 'dist', 'preload'), { recursive: true })
copyFileSync(join(root, 'src', 'preload', 'index.cjs'), join(root, 'dist', 'preload', 'index.cjs'))

// 注入 bridge.js 到 index.html
const indexPath = join(dest, 'index.html')
const html = readFileSync(indexPath, 'utf8')
if (!html.includes('bridge.js')) {
  const injected = html.replace('</head>', '    <script src="./bridge.js"></script>\n  </head>')
  writeFileSync(indexPath, injected)
  console.log('bridge.js injected into index.html')
} else {
  console.log('bridge.js already injected')
}

console.log(`web dist copied → ${dest}`)
