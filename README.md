<div align="center">

# 🧰 MCP Toolbox

**让 AI Coding Agent 读懂设计稿、产品原型与多语言翻译表**

蓝湖 · 腾讯 CoDesign · 石墨文档 —— 把国内团队日常开发里的「设计资产」，
变成 AI 编码助手可直接消费的结构化数据，形成 **「需求 → 设计 → 文案」** 的 MCP 数据供给闭环。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org/)
[![Protocol](https://img.shields.io/badge/Model%20Context%20Protocol-stdio-blue)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://www.typescriptlang.org/)

</div>

## 工具一览

| MCP Server | 一句话 | 杀手级特性 |
| --- | --- | --- |
| **[lanhu-design-mcp](./lanhu-design-mcp/)** [![npm](https://img.shields.io/npm/v/lanhu-design-mcp)](https://www.npmjs.com/package/lanhu-design-mcp) | 蓝湖设计稿读取 + 视觉理解 | 官方 API 结构化图层树；全层级枚举；切图下载； |
| **[codesign-prd-mcp](./codesign-prd-mcp/)** [![npm](https://img.shields.io/npm/v/codesign-prd-mcp)](https://www.npmjs.com/package/codesign-prd-mcp) | 腾讯 CoDesign 原型 → 结构化 PRD | 一个调用遍历整个需求分组；大文档自动落盘防撑爆上下文；两级缓存，重跑秒回 |
| **[shimo-mcp](./shimo-mcp/)** [![npm](https://img.shields.io/npm/v/shimo-mcp)](https://www.npmjs.com/package/shimo-mcp) | 石墨表格 → i18n JSON | Cookie 直调官方 values API（零浏览器依赖）；行/列增量取数；列映射配置表适配任意列名 |

三者均为 **stdio MCP server**，可被任意支持 MCP 的宿主接入：Claude Code / Cursor / Trae / opencode…

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

准备 cookie：浏览器登录石墨 → F12 → Network → 复制任意请求的 `Cookie` 头，存进 `SHIMO_COOKIE_FILE` 指向的本地文件。重启 Agent，直接说"把翻译表里 xx 工作表导出成 i18n JSON"即可。✅

> 蓝湖 / CoDesign 的接入见各自目录内 README，每个 README 均含 Claude Code / Codex CLI / OpenCode 三种宿主的完整配置示例。
> 想改代码或参与开发：clone 后在子目录 `npm install && npm run build`，把 `command`/`args` 换成 `node` + `/path/to/<server>/dist/index.js`（Windows 写 `C:/path/to/...`，正斜杠免转义）即可。

## 共同设计理念

- **结构化数据优先**：精确数值一律来自 API / DOM（色值、行号、图层几何），视觉模型只做语义补充，禁止截图 OCR 冒充精确数据
- **上下文友好**：分页读取、大文档自动落盘只回路径、解析结果按内容缓存——为大表/大原型做了大量「别撑爆 Agent 上下文」的工程
- **登录态安全**：Cookie/Key 只进本地 gitignore 文件（`.mcp-local/`、`.auth/`），不入库、不打日志；取值遵循「工具入参 > 环境变量 > 文件」优先级

## FAQ

<details>
<summary><b>需要视觉模型吗？不配会怎样？</b></summary>

不配也能用：蓝湖读稿走官方 API 纯结构化数据；石墨完全不需要。CoDesign 的原型解析和蓝湖的封面理解依赖视觉模型——配任意 **OpenAI Chat Completion 兼容**的 `VLM_BASE_URL` + `VLM_API_KEY` 即可（GLM / 通义 / DeepSeek / OpenAI 均可）。
</details>

<details>
<summary><b>Cookie 会泄露吗？过期了怎么办？</b></summary>

Cookie 是你的完整登录态，只发往对应服务的官方域名，写入本地 gitignore 文件，不入库、不打日志。过期后各工具会先探活区分「真过期」与「单文档无权限」，提示你重新复制；蓝湖还提供双击即用的登录脚本自动续期。
</details>

<details>
<summary><b>npx 启动报 404：The requested resource 'xxx@*' could not be found？</b></summary>

你配置了国内 npm 镜像源（报错地址是 mirrors.xxx 而非 registry.npmjs.org），镜像同步官方源有延迟。临时解决——在 MCP 配置的 `args` 里显式指定官方源：

```json
"args": ["-y", "--registry", "https://registry.npmjs.org", "shimo-mcp"]
```

或在 `env` 里加 `"npm_config_registry": "https://registry.npmjs.org"`。等镜像同步后可去掉。
</details>

## 贡献

欢迎 PR / issue：新增工作流 MCP（在根目录建自包含子目录，参考现有三个的结构）、修复、文档改进都欢迎。顺手点个 ⭐ 就是最大的鼓励！

## License

[MIT](./LICENSE) © [awaygu](https://github.com/awaygu)
