# DeepCodeBuddy — App 开发路线

> 基于 DeepSeek Harness（dsh）内嵌的 Electron 桌面应用。本文档汇总已确认的架构决策、分阶段开发路线与待确认事项；结论来源为 dsh 仓库的实际机制（`AbstractApiClient` carrier、profile/plugin 体系、capability seam、`ctx.llm` 配置模式等）。

## 一、项目目标

- 一个基于 dsh 的原生桌面 App（Electron 壳），复用 dsh 的 Web 客户端包与 host 运行时
- 默认功能开箱即用，用户可配置模型
- 支持安装社区插件（`dsh-plugin` npm 生态）
- 附带自有功能扩展，如**图片生成**模块（能力 seam + 可配置模型，支持第三方 provider）

## 二、已确认的架构决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | **集成形态** | **Electron 真实文件系统形态**（host 以 npm/源码形态跑在真实文件系统，非 pkg 封闭闭包） | 唯一能支持"运行时装社区插件"的形态；闭包内共享 cordis 实例是官方未解决的难题 |
| D2 | **客户端接入** | 复用 `packages/client/*` Web 客户端包；实现 `AbstractApiClient` 的 carrier 子类 | 官方设计即"Electron 复用同一套 web client 包"，`AbstractApiClient` 只需实现 `doFetch` |
| D3 | **前端** | 加载 `apps/web` 的 dist（`AppWebEntry` 薄入口） | 全功能会话 UI（多会话、审批、配置页）直接复用 |
| D4 | **插件管理** | 保留 `$DSH_HOME/profiles/` 机制（指向应用用户数据目录）；自建安装器替代 `dsh plugin` 的 pnpm 转发；移植 `reconcilePlugins` 逻辑 | 社区插件天然是"用户可写目录 + npm 包" |
| D5 | **图片生成** | **独立能力 seam**（`ctx.imageGen`：Service Definition / Provider / Consumer），**配置体系模仿 `ctx.llm`**（provider registry + settings 域 + credentials 域 + 默认模型） | 文生图不是 chat/stream 语义，挂 `ctx.llm` 会污染其 seam；但配置体验要对齐 LLM，用户零学习成本 |
| D6 | **图片生成开箱即用** | 插件作为 app **默认 bundle 的常驻行**（随 app 分发），预置默认 provider + 默认模型 | 满足"默认功能 + 开箱即用" |
| D7 | **模型可见 ⟺ 已记录** | 图片生成结果必须走 `attachments` 域 + 扩展 `SessionEventMap` | dsh 硬原则：任何进模型上下文的内容必须可从会话日志重建 |
| D8 | **更新模式** | pin `@deepseek-ai/dsh` 版本；client 与 host **一起发版**（`/api` 无协议版本号） | 官方尚未提供独立客户端版本协商 |
| D9 | **host 跑法** | **独立子进程 spawn**：完整 host（`boot()` + apiproxy）跑在子进程，主进程不跑 cordis | 隔离、可重启、host 崩溃不拖垮主进程；需进程生命周期管理（参考 `dsh-sdk-client` 的 close 阶梯） |
| D10 | **carrier 通道** | **IPC 直连**：渲染进程 → 主进程 IPC 网关 → host 子进程，全程不监听网络端口 | 无网络面、天然安全；符合官方"Electron 不复用 webserver"的设计 |
| D11 | **图片生成 provider** | **第三方 provider 均可**（deepseek 无图片 API）：provider registry 支持多 provider，每 provider 独立 credentials | 印证独立 seam 正确性；默认 provider 见 D19 |
| D12 | **插件集** | **全量官方 bundle**（`dsh-base` + `dsh-web-app` 等官方 bundle 全量） | 开箱即用、免自维护裁剪集；体积约 174MB，P4 阶段再按收益优化 |
| D13 | **打包工具** | **electron-builder**（+ electron-updater 自动更新） | 自动更新/签名/公证一站式最成熟；`asarUnpack` 插件与 `.node` addon 资料最多；electron-forge 的"官方维护"优势对本项目价值有限（需跟进的是 dsh 而非打包工具） |
| D14 | **目标平台** | **Windows / macOS / Linux 全平台** | 三平台全覆盖；原生 addon（node-pty / Landlock 等）、签名与 CI 按平台矩阵规划（P5） |
| D15 | **是否回传上游** | **初期私有**，成熟后可选贡献 dsh | 初期避免包命名与门禁（Agent Note、doc-sync）约束；成熟后 `ctx.imageGen` seam、models 页扩展等可回传 |
| D16 | **Node/Electron 版本** | **Electron 43**（内置 Node 24.18.1，≥ 22.19 满足 dsh 引擎下限） | 当前最新 stable（2026-08，Chromium 150）；Electron 无 LTS，官方维护最新 3 个 major（43/42/41）；支持至 2027-01-05，届时随 dsh 一起升级 |
| D17 | **社区插件安全策略** | **首版：安装前权限提示**；后续增强为签名校验 | 插件 = 任意代码执行（bash/fs 工具）；先做用户知情 + 权限提示（低成本高收益），签名校验列入后续增强 |
| D18 | **更新策略** | **自管版本为主 + 半自动更新检查**：pin dsh 基线版本；定期查 npm registry 评估上游变更（breaking / 安全修复 / 新特性），值得升级才触发：dsh 全量门禁 → DeepCodeBuddy 冒烟 → 发版 | 纯跟随上游在 preview 阶段回归成本过高；敏感安全修复即时跟进，普通功能攒批升级，兼顾稳定与安全 |
| D19 | **图片生成默认 provider** | **默认：智谱 GLM-Image**（0.1 元/次，中文文字渲染开源 SOTA）；provider registry 支持用户添加其他 provider（OpenAI gpt-image-2 / 阿里云 Qwen-Image / FLUX 等） | 面向中文用户：中文文字渲染强、价格低、国内直连；GLM-Image 与 OpenAI 同为 `/images/generations` 协议，适配器可复用，后续扩展成本低 |
| D20 | **子进程间通道形态** | **Node IPC channel 为主通道**（`spawn(..., {stdio:[...'ipc']})`，fd 3）；抽象为可替换 `Channel` 接口（后续可切 stdio JSON-RPC，复用 dsh-sdk 协议层）；**不用 loopback 端口** | 对象直传零协议层、无网络面（满足 D10）、stdout/stderr 全留诊断、多次 `send()` 模拟下行流；大二进制走 attachment 文件路径绕行 IPC 大小限制；loopback 违反"无网络面"红线，仅作未来 fallback |

## 三、开发路线（分阶段）

### P0 — 技术预研（半天～1 天）

- [ ] 确认 Electron 内置 Node ≥ 22.19（dsh 引擎下限）
- [ ] **子进程可行性 PoC**：spawn 一个完整 host 子进程（`boot()` + apiproxy），确认不监听端口也能通过内部 handler 通信
- [ ] 最小 `AbstractApiClient` 子类 PoC：`doFetch` 走 IPC，调通 `host.describe` / `session.list`
- [ ] `apps/web` dist 在 `file://` 下 + IPC bridge 可运行

### P1 — 核心集成（主要工作量）

- [ ] **host 子进程**：spawn 完整 host（子进程内 `boot()` + apiproxy），**不监听网络端口**
- [ ] 子进程生命周期：spawn、优雅关闭（dispose → 退出）、崩溃检测与重启、stdout/stderr 分离（协议与诊断分离，诊断走 stderr）
- [ ] 编写裁剪后的默认 `cordis.yml`（只装需要的 bundle）
- [ ] `$DSH_HOME` 重定向到应用用户数据目录
- [ ] **IPC 网关（主进程）**：桥渲染进程 ↔ host 子进程（子进程侧暴露 `toFetchHandler(api)`；主进程转发请求/响应与下行流，见 D20）
- [ ] **渲染进程 carrier**：`IpcApiClient extends AbstractApiClient`（`doFetch` → 主进程 IPC → 子进程）
- [ ] 下行流桥接：`events.mux` / `events.host`（浏览器形态是 WebSocket，IPC 形态提供等效 AsyncIterable，跨两级转发）
- [ ] 渲染进程加载 `apps/web` dist，替换默认 fetch 为 IPC carrier
- [ ] 单实例锁、崩溃恢复、重启后会话恢复

### P2 — 社区插件管理

- [ ] 自建安装器：在 profile 目录执行 `npm install <pkg> --no-save`
- [ ] 移植 `apps/cli/src/plugin.ts` 的 `reconcilePlugins`（`dsh.bundle` 声明 → 加入/退出层栈）
- [ ] `cordis.patch.yml` 读写 + 复用 `watchUserPatches` HMR
- [ ] 插件 UI：npm registry 搜索（`dsh-plugin` topic）、安装/卸载/更新/启停、错误展示
- [ ] 安全：来源校验、安装前权限提示、沙箱联动

### P3 — 图片生成（默认功能，支持第三方 provider）

- [ ] `ctx.imageGen` 能力 seam：Service Definition + **多 provider registry**（模仿 `ctx.llm`：provider → model catalog → configurable providers）
- [ ] **provider 适配器**：默认智谱 GLM-Image（OpenAI 兼容 `/images/generations` 协议）；可扩展 OpenAI gpt-image-2 / 阿里云 Qwen-Image / FLUX 等
- [ ] **每 provider 独立 credentials 引用**（`ctx.credentials`，不可复用 deepseek key）
- [ ] 默认 provider + 默认模型选择（`imagegen-default-model`，settings 域）
- [ ] model-facing tool `image_generate`（`defineTool`，schema 自动进系统提示词、Code Mode 可用）
- [ ] 图片资产：`attachments.saveImage`（内容寻址存储）+ 尊重 `imageLimits`
- [ ] 会话日志：扩展 `SessionEventMap`（`imagegen/result`），保证回放
- [ ] UI 卡片：`presentCall` / `presentResult`（注意 purity：纯函数、replay 安全）

### P4 — 打包与发布

- [ ] electron-builder 配置（electron-updater 自动更新、Win/macOS 签名与公证）
- [ ] asar 策略：动态 import 插件、`worker.cjs`、`.node` addon → `asarUnpack` / `extraResources`
- [ ] 体积优化（按收益）：全量 bundle 内未用行裁剪 → 排除 dev 产物/测试/`lib/types` → 平台裁剪（node-pty 等 optional dep）→ minify
- [ ] 版本管理：pin dsh 版本；client/host 同发；更新管线（可选：查 npm registry → 替换内置 runtime）

### P5 — 信任、安全与测试

- [ ] IPC 形态天然无网络面（绕过 `/api` loopback fence 与无认证问题）——保持本地 IPC，勿暴露 HTTP
- [ ] 原生能力：`directory-picker` seam 的 Electron 原生对话框 backend；`host.openPath` 用 `shell.openPath`
- [ ] 端到端冒烟：启动 → 会话 → 工具调用 → 插件安装 → HMR → 关机
- [ ] 平台矩阵 + 打包产物验证进 CI

## 四、待确认事项（开工前必须定）

| # | 决策点 | 选项 | 影响 | 建议 |
|---|---|---|---|---|
| Q1 | ~~插件集裁剪程度~~ ✅ **已定：全量官方 bundle** | 全量官方 bundle（见决策 D12） | 体积约 174MB，P4 再按收益优化 | 已确认，不再待定 |
| Q2 | ~~打包工具~~ ✅ **已定：electron-builder** | electron-builder（见决策 D13） | 自动更新（electron-updater）+ 签名/公证一站式 | 已确认，不再待定 |
| Q3 | ~~Node/Electron 版本~~ ✅ **已定：Electron 43（内置 Node 24.18.1）** | Electron 43（见决策 D16） | 内置 Node 24.18.1 ≥ 22.19，满足 dsh 引擎下限 | 已确认，不再待定 |
| Q4 | ~~更新策略~~ ✅ **已定：自管版本为主 + 半自动更新检查** | pin dsh 基线；定期评估上游，值得升级才触发全量门禁 + 冒烟（见决策 D18） | `/api` 无版本号，client/host 必须同发 | 已确认，不再待定 |
| Q5 | ~~社区插件安全策略~~ ✅ **已定：首版安装前权限提示，后续加签名** | 首版权限提示；后续签名校验（见决策 D17） | 插件可执行任意代码（bash/fs 工具），至少安装前提示 | 已确认，不再待定 |
| Q6 | ~~目标平台~~ ✅ **已定：Windows / macOS / Linux** | 全平台（见决策 D14） | 原生 addon、签名、CI 平台矩阵 | 已确认，不再待定 |
| Q7 | ~~是否回传上游~~ ✅ **已定：初期私有，成熟后可选贡献** | 初期私有，成熟后可选贡献（见决策 D15） | 包命名、开发流程门禁（Agent Note、doc-sync）初期不适用 | 已确认，不再待定 |
| Q8 | ~~子进程间通道形态~~ ✅ **已定：Node IPC channel 为主通道 + Channel 抽象** | Node IPC channel；`Channel` 接口可替换（见决策 D20） | 决定 IPC 网关实现复杂度与协议转换量 | 已确认，不再待定预置适配器、默认模型、定价与 key | 已确认，不再待定 |
| Q9 | **子进程间通道形态** | Node IPC channel vs stdio 自定义管道 vs loopback 随机端口 | 决定 IPC 网关实现复杂度与协议转换量 | 倾向 Node IPC / 自定义管道（避免网络面） |

## 五、关键技术参考（dsh 机制）

- **客户端接入**：`packages/host/apiproxy/src/fetch/client.ts`（`AbstractApiClient` / `InProcessApiClient` / `toFetchHandler`）
- **host 集成**：`packages/boot/app-boot`（`boot()` / `mountRootInclude` / `bareModuleBaseUrl`）
- **子进程生命周期先例**：`packages/sdk/client`（`dsh-sdk-client` 的 spawn / `close()` 阶梯：stdin EOF → SIGTERM → SIGKILL）
- **插件管理**：`apps/cli/src/plugin.ts`（`reconcilePlugins`）、`docs/cordis-primer.md`（loader 配置）
- **工具编写**：`docs/cookbook/adding-a-tool.md`（`defineTool`、UI 卡片、purity 规则）
- **能力 seam**：`docs/architecture.md`（Service Definition / Provider / Consumer）
- **配置模式**：`packages/host/apiproxy/README.md`（`settings.*` / `credentials.*` / `llm.*` 域）、配置源所有权 Agent Note
- **模型可见 ⟺ 已记录**：`docs/architecture.md`（session log）、`packages/core/session`（`SessionEventMap`）
- **图片资产先例**：`packages/fs/tool-fs`（`read_image`：attachments + imageLimits）
- **打包先例**：`scripts/build-exe-for-python-sdk.ts` + `2026-07-10-single-file-executable-sdk-runtime-distribution` Agent Note（闭包思路，仅参考——本 app 不采用封闭闭包）

## 六、风险与红线

- **`/api` 契约未冻结**（无协议版本号）：client 与 host 必须同版发布，升级 dsh 时全量回归
- **闭包形态不支持外部插件**：不要走 pkg SEA 封闭闭包（官方 future evolution，未解决）
- **图片生成进模型上下文必须记录**：违反"Model-visible ⟺ logged"会破坏回放与持久化不变量
- **社区插件 = 任意代码执行**：安全模型要提前定（Q5），不要事后补
- **第三方图片 provider 的密钥管理**：每个 provider 独立 credentials，绝不进 cordis.yml 明文；注意各 provider 的定价/速率限制/内容政策差异
- **dsh 是 developer preview**：会有破坏性变更，文档与 API 以当前 master 为准，升级前先跑 dsh 全量门禁
