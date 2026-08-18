# P0 PoC — 运行说明

P0 技术预研的最小可运行验证。代码依赖 dsh 仓库的 workspace（`node_modules` 与源码布局），
因此在 `deepseek-harness` 仓库内运行；本目录为归档副本。

## 运行环境

- Node ≥ 22.19（本地 v24.17.0 已验证）
- dsh 仓库已 `pnpm install` 且已构建 host 侧（`pnpm run build:lib:host`）

## 文件

| 文件 | 角色 |
|---|---|
| `parent.ts` | 主进程：fork host 子进程，实现远程 fetch transport，验证 PoC A + B |
| `host-child.ts` | host 子进程：`boot()` 组合（base + 过滤 web 层）、`toFetchHandler(ctx.apiProxy)`、经 Node IPC 暴露 |

## 运行

```sh
# 在 deepseek-harness 仓库内
cd ../deepseek-harness
$env:DSH_HOME = "<临时 home 目录>"   # 避免污染真实 ~/.dsh
node --import tsx/esm ../deepcodebuddy/p0-poc/parent.ts
```

## 验证点

- **PoC A**：子进程 `boot()` 后不监听任何网络端口，经 Node IPC 提供 `apiProxy` handler
- **PoC B**：`InProcessApiClient(远程 transport)` 与自定义 `IpcApiClient extends AbstractApiClient`
  两条路径均调通 `host.describe` / `session.list`

## 注意事项

- 子进程组合通过**程序化过滤**剔除了 dsh-web-app 的 transport/client 层
  （`webserver`、`web-startup`、`client-*`、`ui-*` 等），并把 `directory-picker` 换成
  `-native` 实现；这是"无 webserver 的 host-only 组合"的 PoC 起点，P1 应固化为正式配置。
- 详见 [`../P0-RESULTS.md`](../P0-RESULTS.md)。
