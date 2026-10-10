# dsh-mcp-design-toolbox — 把设计工具箱 MCP 接入 DeepSeek Harness

一个 **DeepSeek Harness（DSH）插件**：把已发布 npm 的三个 MCP Server 接入 DSH，让 Agent 直接把它们的工具当原生工具用。

| MCP Server（npm） | 作用 | DSH 中的工具名前缀 |
|---|---|---|
| `shimo-mcp` | 结构化读取石墨文档表格、i18n 增量取数、xlsx 导出 | `mcp__shimo__*` |
| `lanhu-design-mcp` | 蓝湖设计稿读取 + 分组枚举 + 视觉理解 | `mcp__lanhu__*` |
| `codesign-prd-mcp` | 腾讯 CoDesign 原型（Axure）→ 结构化需求文档 | `mcp__codesign__*` |

**三个 MCP 的代码零改动** —— 本插件是一个"纯配置 bundle"：只有 `package.json` + `cordis.patch.yml`，每行配置实例化一个 DSH 内置的官方桥接插件 [`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client)，由它 `npx` 拉起你的 MCP Server（stdio 传输），自动发现工具并注册到 `ctx.tools`。

配置里**不含任何机器专属信息**：Windows / macOS / Linux 的命令差异、缓存目录都用 `!!js` 表达式在加载时自动计算。

---

## 工作原理

```
MCP Server（npm 包，stdio）        本插件（纯配置 bundle）
shimo-mcp ──┐                     ┌─ mcp__shimo__*  ─┐
lanhu-design-mcp ──┤ npx 拉起 ── dsh-mcp-client ──┤→ ctx.tools → 模型按普通工具调用
codesign-prd-mcp ──┘   发现/重连/超时  └─ mcp__codesign__* ─┘
```

- DSH 的 profile 由多层 patch 叠加而成；插件包在 `package.json` 里用 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` 声明自己的 patch 层（一个 YAML 数组，每行一个插件实例）。
- 模型看到的工具名是 `mcp__<serverName>__<工具原始名>`（与 Claude Code / Codex 同款命名），不同 server 的同名工具天然不冲突。
- 连接失败不影响 DSH 启动（`failOnStartupError` 默认 `false`）；断线自动重连（500ms 起指数退避，30s 封顶，连续 10 次失败后移除该 server 工具，恢复稳定后重新注册）。

## 前置条件

| 依赖 | 说明 |
|---|---|
| DeepSeek Harness | 桌面版即可；`dsh-mcp-client` 是 DSH 内置插件，无需单独安装 |
| Node.js ≥ 18 | 需要在 PATH 里（`npx` 可用）；MCP Server 首次运行会由 npx 自动下载 |
| 石墨 cookie | `SHIMO_COOKIE_FILE` 指向的文件（内容为完整 cookie 串），或环境变量 `SHIMO_COOKIE`，或调用时传入 |
| 蓝湖 cookie | `LANHU_COOKIE_FILE` 指向的文件（过期后用 lanhu-login 脚本续期） |
| VLM 密钥 | 用户级环境变量 `VLM_API_KEY`（蓝湖视觉理解、CoDesign 截图解析共用） |
| Playwright 浏览器 | 仅 CoDesign 需要，装一次：`npx playwright install chromium` |

## 安装

### 方式 A：发布 npm 后一键安装（推荐）

```sh
dsh plugin --profile web add dsh-mcp-design-toolbox
```

也可以在 DSH 桌面版 **设置 → 插件** 里安装。装完重载 profile 生效。

### 方式 B：本地目录安装（发布前验证）

```sh
dsh plugin --profile web add <插件包所在目录>
```

### 方式 C：不装插件，直接写 profile patch（个人机器最快）

把 `cordis.patch.yml` 里的三段配置粘进：

```
C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml
```

（该文件是 DSH 的"用户 patch 层"，本身就是顶层数组。）重启 DSH 生效。

> ⚠️ **方式 C 与方式 A/B 不要同时用**：两边都配会导致 `shimo` / `lanhu` / `codesign` 三个 `serverName` 重复注册，后加载的一方会报错。二选一即可。

## 安装后必做：本机化配置（1 分钟）

插件配置本身不含任何路径和密钥，装完后按需二选一：

**推荐：设置用户级环境变量**（对所有 MCP 宿主通用，改一处即可）

```powershell
# Windows（PowerShell；macOS/Linux 写进 ~/.zshrc 或 ~/.bashrc）
setx SHIMO_COOKIE_FILE "C:\Users\你\.mcp-local\shimo.cookie"   # 石墨 cookie 文件
setx LANHU_COOKIE_FILE "C:\Users\你\.mcp-local\lanhu.cookie"   # 蓝湖 cookie 文件
setx VLM_API_KEY "sk-你的视觉模型密钥"                           # 视觉理解（蓝湖/CoDesign 共用）
# 可选：
setx CODESIGN_URL "https://codesign.tencent.com/xxxx"          # 默认原型链接，调用时可省 url 参数
setx CODESIGN_PASSWORD "访问密码"
setx CODESIGN_CACHE_DIR "D:\某个可写目录"                # CoDesign 的 VLM 缓存目录（默认系统临时目录）
```

**或者：改安装后的 yml**，把 `SHIMO_COOKIE_FILE` / `LANHU_COOKIE_FILE` 的 `!!js` 回退值直接写成你的本机路径（仅限本机自用，勿提交/发布）。

说明：`VLM_API_KEY` 这类密钥变量**必须**通过 yml 里的 `!!js process.env.VLM_API_KEY` 显式回传 —— DSH 启动子进程时会剥掉环境里带 `KEY/SECRET/TOKEN/PASSWORD` 字样的变量；`SHIMO_COOKIE_FILE` 等非密钥变量会原样传给子进程。

## 安装后 5 分钟自检

1. 设置好上面的环境变量（或改好 yml），重载 profile。
2. 等工具发现完成（首次 `npx` 下载包会慢一点）。
3. 工具列表出现 `mcp__shimo__*` / `mcp__lanhu__*` / `mcp__codesign__*`。
4. 让 Agent 做一次只读调用（例如读一个石墨表格的某个工作表）。
5. 会话中能看到成对的工具调用与结果。
6. （可选）手动结束某个 MCP 进程，观察日志里的自动重连。

## 可调参数速查（每行 config 里）

| 字段 | 默认 | 说明 |
|---|---|---|
| `toolCallTimeoutMs` | 60000 | 单次工具调用超时；本包对 lanhu 设 180s、codesign 设 600s（爬取 + VLM 耗时长） |
| `failOnStartupError` | false | 首连失败是否拒绝激活；false 时 DSH 正常启动、仅该 server 无工具 |
| `reconnect.*` | 见下 | `enabled: true`、`initialDelayMs: 500`、`maxDelayMs: 30000`、`maxAttempts: 10` |
| `maxInstructionBytes` | 32768 | server instructions 字节数上限（MCP 的 instructions 会进系统提示词） |
| `env` / `cwd` | — | 追加环境变量（覆盖在被清洗的环境之上）与工作目录 |

> 兼容提示：若你的 DSH 版本不支持列表型 `!!js` 表达式，把 `command`/`args` 换成固定写法（Windows：`cmd` + `['/c', 'npx', '-y', '<包名>']`；macOS/Linux：`npx`）。

## 已知限制

- 只桥接 MCP **tools**；MCP prompts 模板不支持（server instructions 会以文本进系统提示词），resources 由 DSH 内置的共享资源服务按需读取。
- 图片结果需要当前模型支持图像输入，否则降级为诊断文本。
- `serverName` 在同一注册范围内必须唯一；改 `serverName` 会改变模型可见工具名（影响历史会话与权限规则）。

## 发布与分发

- 在本目录 `npm publish` 后，任何 DSH 用户：`dsh plugin add dsh-mcp-design-toolbox`。
- 发布前自查：`npm pack --dry-run` 看清将发布的文件清单（本包只含 `package.json` / `cordis.patch.yml` / `README.md`，不含任何本机路径、cookie 与密钥）。
- 也可提交到社区插件目录（如 dshbase）增加曝光。

## 来源

- 官方 MCP 客户端插件：`@deepseek-ai/dsh-mcp-client`（[packages/mcp/mcp-client](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client)）
- 社区教程：[dshbase](https://dshbase.com/zh/) · [hello-dsh 零基础插件教程](https://github.com/pingfanfan/hello-dsh)
