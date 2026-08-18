# P0 — 技术预研结果（2026-08-18）

验证结论基于 `deepseek-harness` @ `dsh-v0.1.0-rc.7`（master，99f6f02fec）。

## ✅ PoC A — host 子进程不监听端口通信

**结论：可行。**

- 子进程内 `boot(binName, rootConfig, patches)` 组合 base + web-app bundle（程序化过滤
  掉 transport/client 层），`toFetchHandler(ctx.apiProxy)` 得到纯内存 fetch handler；
- **全程不监听任何网络端口**：子进程通过 Node IPC（fork fd 3）暴露 fetch 语义；
- 优雅关闭：`ctx.fiber.dispose()` → exit 0（验证通过，exit code 0）。

**关键机制（已验证）**
- `boot()` 返回根 `Context`，`ApiProxyService` 以 `ctx.apiProxy` 提供；
- `toFetchHandler(api)`（`packages/host/apiproxy/src/fetch/handler.ts`）把 ApiProxy 包成
  纯 fetch 函数：`/api/<method>` POST 信封 + `events.mux`/`events.host` SSE GET + respond；
- 组合方式：`loadOverlayPatches` 解析 bundle 的 `cordis.patch.yml` → `PatchOptions[]`。

## ✅ PoC B — AbstractApiClient 子类走 IPC

**结论：可行，两条路径均调通 `host.describe` / `session.list`。**

1. **复用官方 `InProcessApiClient`**：`new InProcessApiClient({ fetch: 远程transport })`
2. **自定义子类（D2 形态）**：`class IpcApiClient extends AbstractApiClient { doFetch → IPC }`

`AbstractApiClient` 持有全部协议不变量（rpcId 铸造、四象限信封、zod 解析、SSE 帧解码），
transport 与协议层解耦——IPC 只需实现 `doFetch`，无需触碰协议。

**IPC 传输实现要点（远程 fetch transport）**
- 请求方向：`{ type:'fetch', id, input, init }`（`doFetch` 收到的是 `URL` + `RequestInit`）
- 响应方向：`fetch-headers`（status/statusText/headers）→ 流式 `fetch-chunk`（base64）→ `fetch-done`
  / `fetch-error`；父进程用 `ReadableStream` 重建 `Response`，unary 与 SSE 长连接统一适用；
- 大二进制：PoC 用 base64 分块；P1 建议 attachment 走文件路径（内容寻址存储）绕行。

## ⚠️ PoC C — apps/web dist 在 file:// 下

**部分可行，P1 需处理路径基线。**

- `apps/web` dist 可构建（`pnpm run build:web`，~11MB / 114 文件）；
- **默认产物用绝对路径（`/assets/...`），`file://` 下不可直接加载**；
- **`vite build --base=./` 可产出相对路径版本（`./assets/...`），`file://` 可加载** ✅；
- IPC bridge（preload → 主进程 → host 子进程）依赖 Electron 环境，属 P1 工程化内容。

**P1 待定方案**（择一）：
1. 在 deepcodebuddy 的 web 构建流程加 `base: './'`（或 `--base=./`）；
2. 或 Electron 自定义协议（如 `app://`）映射 dist——可保留绝对路径。

## P0 → P1 的结论清单

| # | 结论 | P1 影响 |
|---|---|---|
| 1 | host 子进程 boot + apiProxy 不监听端口可行 | 固化"host-only 组合"配置（含 directory-picker native） |
| 2 | AbstractApiClient 只需实现 doFetch | 实现 `IpcApiClient`（正式化）+ Channel 抽象（D20） |
| 3 | IPC 可流式转发（unary + SSE） | 下行流 events.mux/host 跨两级转发可行 |
| 4 | web dist 需相对路径才能 file:// 加载 | web 构建加 `base:'./'` 或自定义协议 |
| 5 | IPC bridge 需 Electron | P1 搭建 Electron 43 壳 + preload |

## 运行方式

见 [`p0-poc/README.md`](p0-poc/README.md)。PoC 脚本归档于 `p0-poc/`（在 dsh 仓库内运行）。
