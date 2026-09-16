# lanhu-design-mcp

零依赖 stdio MCP server，让任意支持 MCP 的 coding Agent（Claude Code / Cursor / Trae /
opencode）直接读蓝湖设计稿做开发与验收：

- **结构化图层树**：官方 API（Cookie 直调）取 x/y/宽高/色值/字号/圆角（含逐角）/描边/阴影/文本，精确数值来自结构化数据，**不靠视觉模型 OCR 截图小字**；
- **团队目录导航**：团队 → 项目 → 分组（需求）→ 设计稿完整层级，一次拉取、按需下钻；
- **切图下载**：单稿或分组批量，三层去重 + 字节级验真，直接落盘本地 assets；
- **视觉理解与验收**：配置视觉模型后自动理解封面图语义（`visionAnalysis`），另有渲染对比、UI 缺陷检测、E2E 失败归因。

TypeScript + 官方 MCP SDK。你的 coding Agent 就是流水线里的"代码生成引擎"——本 MCP 只负责"读设计"和"做验收"。

## 环境要求

- Node.js >= 18

## 安装 & 构建

```bash
npm install && npm run build   # esbuild 打包为单文件 dist/index.js
```

## 快速开始

### 1. 蓝湖 Cookie

- **推荐**：Windows 双击 `lanhu-login.bat`（或 `npm run login`），浏览器登录后回终端按 Enter，cookie 自动写入 `.mcp-local/lanhu.cookie`（已 gitignore）；
- **手动**：F12 → Network → 任意请求复制 `Cookie` 头整串，写入同一文件；
- 过期后重跑一次登录脚本即可，AI 检测到 401 时会提示你。

### 2. 视觉模型（analyze / 验收需要）

配置 `VLM_API_KEY`，可选 `VLM_BASE_URL` / `VLM_MODEL`（任何 OpenAI 兼容端点均可，默认 DeepSeek）。
配好后 `lanhu_fetch_design` **默认自动返回视觉理解**；想跳过传 `analyze:false`，或设 `LANHU_AUTO_ANALYZE=0` 全局关闭。

### 3. 接入 Agent（项目根 `.mcp.json`）

```json
{
  "mcpServers": {
    "lanhu-design-mcp": {
      "command": "npx",
      "args": ["-y", "lanhu-design-mcp"],
      "env": {
        "VLM_API_KEY": "your-api-key",
        "VLM_BASE_URL": "https://api.deepseek.com",
        "LANHU_COOKIE_FILE": "./.mcp-local/lanhu.cookie"
      }
    }
  }
}
```

源码开发时改为 `node` + `dist/index.js` 绝对路径。Cursor（`.cursor/mcp.json`）/ Trae / opencode 配置字段一致。

## 工具一览

| 工具 | 用途 |
|---|---|
| `lanhu_check_auth` | 探活 cookie，区分"已过期"与"该资源无权限" |
| `lanhu_list_teams` | 列账号加入的全部团队（多团队发现） |
| `lanhu_list_directory` | 一次拉团队目录（项目 → 分组，无需链接） |
| `lanhu_read_sector` | 按分组列稿目录（稿名/尺寸/层数，不含图层树） |
| `lanhu_fetch_design` | 读单稿结构化图层树 + 视觉语义理解 |
| `lanhu_download_slices` | 切图下载到本地 assets（单稿 / 分组批量） |
| `lanhu_verify_spec` | 设计稿验收：图层树期望值 ↔ 页面计算样式逐字段 diff |
| `lanhu_verify_render` | 渲染页 vs 设计稿语义对比（主观线索） |
| `vision_defect_check` | 整页/局部 UI 缺陷检测（12 类） |
| `vision_e2e_triage` | E2E 失败截图 + DOM 归因 |

工具入参 schema 自描述，Agent 在工具列表里即可看到完整入参说明。

## 验收口径（H5 webview 项目）

`lanhu_verify_spec` 验收 webview 内嵌页时，以下差异属预期，会自动降级：

- **宽度严格、高度宽松**：`x` / 非文本层 `width` 严比；`y` / `height` 因状态栏与动态渲染整体偏移，降 `minor`；
- **状态栏不渲染**：稿顶状态栏层比对前剔除，整体竖直偏移记入 `offset`，不报缺陷；
- **文案语义接近即可**：文本差异降 `minor`；配视觉模型时做语义等价判定，确为不同含义才升 `major`；
- **前置去噪**：`opacity=0`、零尺寸、蒙版/标注/备份组、占位切图等无效层不参与比对；
- **背景回退**：叶子节点背景透明时向上回退 3 级祖先背景色，未命中封顶 `major`。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `VLM_API_KEY` | analyze/验收时必填 | — | 视觉模型 Key（须为对应平台签发，如 api.deepseek.com 需 DeepSeek key） |
| `VLM_BASE_URL` | 否 | `https://api.deepseek.com` | 任意 OpenAI 兼容端点 |
| `VLM_MODEL` | 否 | `deepseek-v4-flash-vision-exp` | 视觉模型名 |
| `LANHU_VISION_MAX_TOKENS` | 否 | `8192` | 输出上限（GLM 系模型因 thinking 计入预算，分支内默认 `16384`；设太小 JSON 会被半截截断） |
| `LANHU_VISION_TIMEOUT_MS` | 否 | `120000` | 单次视觉请求超时（毫秒） |
| `LANHU_VISION_MAX_EDGE` | 否 | `1568` | 入参图压缩最长边 |
| `LANHU_VISION_CACHE` | 否 | `1` | 设 `0` 关闭视觉结果缓存（`LANHU_VISION_CACHE_DIR` 可改目录） |
| `LANHU_AUTO_ANALYZE` | 否 | — | 设 `0` 关闭 fetch_design 自动视觉分析（视觉模型配齐时默认自动开） |
| `VISION_USE_V1` | 否 | — | 设 `0` 切到端点原生 `/chat/completions` |
| `LANHU_COOKIE` | api 模式必填（与 `LANHU_COOKIE_FILE` 二选一） | — | 蓝湖 Cookie 串（F12 复制） |
| `LANHU_COOKIE_FILE` | 同上 | — | cookie 文件路径；`lanhu-login.bat` 续期时自动写入 |
| `LANHU_MOCK` | 否 | — | 设 `1` 时 fetch_design 返回内置示例（无需联网） |
| `LANHU_SLICE_CONCURRENCY` | 否 | `6` | 切图下载并发数 |
| `LANHU_ALLOWED_ASSET_HOSTS` | 否 | — | 切图主机白名单追加项（逗号分隔），默认仅放行蓝湖/阿里云系 |
| `LANHU_MIN_VISIBLE_FRACTION` | 否 | `0.25` | 出画窄条剔除阈值，设 `0` 关闭 |
| `LANHU_PRUNE_OCCLUDED` | 否 | `1` | 设 `0` 关闭遮挡剔除 |
| `LANHU_PRUNE_FRAGMENTS` | 否 | `1` | 设 `0` 关闭碎片装饰带剔除 |

> cookie 解析优先级：**工具入参 `cookie` > 环境变量 `LANHU_COOKIE` > 文件 `LANHU_COOKIE_FILE`**。
> ⚠️ 若设过 `LANHU_COOKIE` 环境变量，它会压制文件内容——登录脚本续期后新 cookie 写入了文件，但旧环境变量仍生效，会持续 401；需删除/更新该环境变量。

## 部署

- **拷贝即用**：整个目录发给对方，`npm install && npm run build` 后指向 `dist/index.js`；
- **npm**：`npm i -g lanhu-design-mcp`，或一次性 `npx -y lanhu-design-mcp`；
- **Docker**：`node:18-alpine` 内 build，运行时 `-e` 注入密钥。

## 红线（务必遵守）

- **蓝湖小字（色值、字号、间距）只从 `lanhu_fetch_design` 结构化数据取，绝不靠视觉模型 OCR 截图**——图片压缩后 10px 小字/密集文本必读错；
- 视觉模型结论只当线索；**钱 / 权限 / 用户数据相关流程必须人审**;
- 没调 `lanhu_check_auth` 探活前不断定 cookie 过期——单资源 401 多半是权限问题，重新登录无效。
