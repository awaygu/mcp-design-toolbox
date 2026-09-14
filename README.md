<div align="center">

# 🧰 MCP Toolbox

**让 AI Coding Agent 读懂设计稿、产品原型与多语言翻译表**

蓝湖 · 腾讯 CoDesign · 石墨文档 —— 把国内团队日常开发里的"设计资产"，
变成 AI 编码助手可直接消费的结构化数据。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org/)
[![Protocol](https://img.shields.io/badge/Model%20Context%20Protocol-stdio-blue)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://www.typescriptlang.org/)

</div>

## 这解决什么问题

AI 编码 Agent（Claude Code / Cursor / Trae / opencode…）写代码很快，但在国内团队的日常开发里，它一直缺几双"眼睛"：

- 需求原型画在 **腾讯 CoDesign（Axure）** 里 —— 它读不到 PRD，只能靠你复制粘贴；
- 设计稿挂在 **蓝湖** 上 —— 它拿不到精确的图层/色值/字号，只能靠截图 OCR 猜；
- 翻译文案锁在 **石墨表格** 里 —— 它取不出 i18n 数据，只能让你手动导出。

本仓库把这三步全部接进 [MCP 协议](https://modelcontextprotocol.io/)，形成一条 **"需求 → 设计 → 文案 → 验收"** 的 AI 编码数据供给闭环：

```
get_requirement_doc  →  拿到结构化 PRD（原型自动遍历 + 视觉解析）
lanhu_fetch_design   →  拿到图层树精确数值（x/y/色值/字号/圆角…）
        ↓  AI 写代码
shimo_export_i18n    →  一键产出各语言 JSON（漏填自动预警）
vision_defect_check  →  渲染结果 vs 设计稿验收（缺陷检测 / E2E 归因）
```

## 工具一览

| MCP Server | 一句话 | 杀手级特性 |
| --- | --- | --- |
| **[lanhu-design-mcp](./lanhu-design-mcp/)** [![npm](https://img.shields.io/npm/v/lanhu-design-mcp)](https://www.npmjs.com/package/lanhu-design-mcp) | 蓝湖设计稿读取 + 视觉理解/验收 | 官方 API 结构化图层树（**不靠 OCR 猜小字**）；团队→项目→分组→稿 全层级枚举；切图下载；渲染对比 / UI 缺陷检测 / E2E 失败归因 |
| **[codesign-prd-mcp](./codesign-prd-mcp/)** [![npm](https://img.shields.io/npm/v/codesign-prd-mcp)](https://www.npmjs.com/package/codesign-prd-mcp) | 腾讯 CoDesign 原型 → 结构化 PRD | 一个调用遍历整个需求分组：分段截图 + VLM 解析成纯文本需求文档；大文档自动落盘防撑爆上下文；两级缓存，重跑秒回 |
| **[shimo-mcp](./shimo-mcp/)** [![npm](https://img.shields.io/npm/v/shimo-mcp)](https://www.npmjs.com/package/shimo-mcp) | 石墨多语言翻译表 → i18n JSON | Cookie 直调官方 values API（零浏览器依赖）；行号/语言列增量取数；自动识别语言列；`txt_中文首字码+行号` key 规则、分组行识别、漏填预警 |

三者均为 **stdio MCP server**，可被任意支持 MCP 的宿主接入：Claude Code / Cursor / Trae / opencode / MCP Inspector…

## 30 秒接入（以 shimo 为例，无需任何 API Key）

三个包都已发布 npm，**无需 clone 仓库**，在项目根 `.mcp.json` 里直接用 npx：

```json
{
  "mcpServers": {
    "shimo-mcp": {
      "command": "npx",
      "args": ["-y", "shimo-mcp"],
      "env": {
        "SHIMO_COOKIE_FILE": "D:/path/to/.mcp-local/shimo.cookie",
        "SHIMO_URL": "https://shimo.im/sheets/xxx/yyy"
      }
    }
  }
}
```

准备 cookie：浏览器登录石墨 → F12 → Network → 复制任意请求的 `Cookie` 头，存进 `SHIMO_COOKIE_FILE` 指向的本地文件。重启 Agent，直接说"读一下翻译表里的 1v1活动 工作表，导出 en/ar 的 i18n JSON"即可。✅

> 蓝湖 / CoDesign 的接入分别见其目录内 README（蓝湖带双击即用的登录脚本；两者配一个 OpenAI 兼容视觉模型的 Key 即可解锁截图解析）。
> 想改代码或参与开发：`git clone https://github.com/awaygu/mcp-design-toolbox.git` 后在子目录 `npm install && npm run build`，把上面的 `command`/`args` 换成 `node` + `dist/index.js` 绝对路径即可。

## 共同设计理念

- **结构化数据优先**：精确数值一律来自 API / DOM（色值、行号、图层几何），视觉模型只做语义补充，禁止用截图 OCR 冒充精确数据。
- **上下文友好**：分页读取、大文档自动落盘只回路径、解析结果按内容缓存——为大表/大原型做了大量"别撑爆 Agent 上下文"的工程。
- **低依赖、可分发**：除官方 MCP SDK 外零强制依赖（蓝湖登录脚本可选装 Playwright），`npm run build` 后单文件分发。
- **登录态安全**：Cookie/Key 只进本地 gitignore 文件（`.mcp-local/`、`.auth/`），不入库、不打日志。
- **环境变量兜底**：`url` / `cookie` / 密码都遵循"工具入参 > 环境变量 > 文件"优先级，MCP 配置里写一次即可。

## 目录结构

```
mcp-design-toolbox/
├── lanhu-design-mcp/      # 蓝湖：读稿 + 视觉验收
├── codesign-prd-mcp/      # CoDesign：原型 → PRD
├── shimo-mcp/             # 石墨：翻译表 → i18n JSON
└── scripts/               # 仓库级辅助脚本（Inspector 补丁等）
```
```

每个子目录自包含 `package.json` / `README.md` /（部分含）`.mcp.json` 示例，可独立使用、独立分发。

## 本地调试（MCP Inspector）

三个 MCP 共用官方调试工具 [MCP Inspector](https://github.com/modelcontextprotocol/inspector)：命令行参数与环境变量写进仓库根的本地配置文件 `inspector.config.json`（已 gitignore），Web UI 里可视化调用、查看 JSON-RPC 报文：

```bash
npx @modelcontextprotocol/inspector --config inspector.config.json   # Web UI，下拉选 server
```

<details>
<summary>调试要点（踩坑总结）</summary>

- **`env` 即注入 server 进程的环境变量**；**`cwd` 写绝对路径**钉住子项目目录（官方未定义相对路径解析基准），`./.mcp-local/*.cookie` 相对路径才可靠。
- **改代码免 build**：`command` 换 `"npx"`、`args` 换 `["tsx", "src/index.ts"]`。
- **CLI 模式脚本化调试**：`--server <名字> --cli --method tools/list`；MCP Inspector web 模式有 60s 后端等待限制，跑一次根目录 `node scripts/patch-inspector.mjs` 解除（详见 codesign README）。
- **配置文件不支持 `${VAR}` 插值**：密钥写实际值（配合 gitignore），或只传 `*_COOKIE_FILE` 路径。
- **优先级陷阱**：工具入参 > 环境变量 > cookie 文件。设过 `LANHU_COOKIE`/`SHIMO_COOKIE` 旧环境变量会压制文件内容——login 脚本续期后仍 401 就是这个原因。

</details>

## FAQ

<details>
<summary><b>需要视觉模型吗？不配会怎样？</b></summary>

不配也能用：蓝湖读稿走官方 API 纯结构化数据；石墨完全不需要。CoDesign 的原型解析和蓝湖的封面理解/渲染验收依赖视觉模型——配任意 **OpenAI Chat Completion 兼容**的 `VLM_BASE_URL` + `VLM_API_KEY` 即可（GLM / 通义 / DeepSeek / OpenAI 均可）。
</details>

<details>
<summary><b>Cookie 会泄露吗？过期了怎么办？</b></summary>

Cookie 是你的完整登录态，只发往对应服务的官方域名，写入本地 gitignore 文件，不入库、不打日志。过期后各工具会先探活区分「真过期」与「单文档无权限」，提示你重新复制；蓝湖还提供双击即用的登录脚本自动续期。
</details>

<details>
<summary><b>私有部署 / 企业版服务能用吗？</b></summary>

石墨支持 `SHIMO_BASE_URL` 指向私有部署端点；蓝湖/CoDesign 走官方云端 API。有需求欢迎提 issue。
</details>

<details>
<summary><b>npx 启动报 404：The requested resource 'xxx@*' could not be found？</b></summary>

你配置了国内 npm 镜像源（报错地址是 mirrors.xxx 而非 registry.npmjs.org），镜像同步官方源有几分钟到几小时的延迟。临时解决——在 MCP 配置的 `args` 里显式指定官方源：

```json
"args": ["-y", "--registry", "https://registry.npmjs.org", "shimo-mcp"]
```

或在 `env` 里加 `"npm_config_registry": "https://registry.npmjs.org"`。等镜像同步后可去掉。
</details>

## 贡献

欢迎 PR / issue：新增工作流 MCP（在根目录建自包含子目录，参考现有三个的结构与 README 风格）、修复、文档改进都欢迎。顺手点个 ⭐ 就是最大的鼓励！

## License

[MIT](./LICENSE) © [awaygu](https://github.com/awaygu)
