# CoDesign PRD MCP Server

读取腾讯 CoDesign 产品原型（Axure），通过 DOM 确定性提取 + VLM 视觉解析（仅补充 DOM 拿不到的内容），生成纯文本结构化需求文档（PRD），供 AI Coding Agent 直接使用。

## 安装

```bash
cd codesign-prd-mcp
npm install
npm run build                      # 编译到 dist/index.js
npx playwright install chromium    # 仅首次需要，爬取原型用
```

## 接入 Agent（MCP 配置）

三个宿主格式不同，按需取用。都通过 `npx -y codesign-prd-mcp` 启动（免 clone 免构建）。

### Claude Code

项目根 `.mcp.json`：

```json
{
  "mcpServers": {
    "codesign-prd-mcp": {
      "command": "npx",
      "args": ["-y", "codesign-prd-mcp"],
      "env": {
        "VLM_API_KEY": "your-api-key",
        "VLM_BASE_URL": "https://api.openai.com/v1",
        "VLM_MODEL": "gpt-4o"
      }
    }
  }
}
```

### Codex CLI

编辑 `~/.codex/config.toml`（TOML 格式，键名是 `mcp_servers` 下划线）：

```toml
[mcp_servers.codesign-prd-mcp]
command = "npx"
args = ["-y", "codesign-prd-mcp"]
env = { VLM_API_KEY = "your-api-key", VLM_BASE_URL = "https://api.openai.com/v1", VLM_MODEL = "gpt-4o" }
```

### OpenCode

项目根 `opencode.json`（注意差异：`mcp`、`command` 是数组、env 键名是 `environment`）：

```json
{
  "mcp": {
    "codesign-prd-mcp": {
      "type": "local",
      "command": ["npx", "-y", "codesign-prd-mcp"],
      "environment": {
        "VLM_API_KEY": "your-api-key",
        "VLM_BASE_URL": "https://api.openai.com/v1",
        "VLM_MODEL": "gpt-4o"
      },
      "enabled": true
    }
  }
}
```

### 注意事项

- TRAE / Cursor / Cline 等其他宿主用 Claude Code 的通用 `mcpServers` JSON 格式即可
- 参与开发时把 `command` 换成 `node`、`args` 换成 `["/path/to/codesign-prd-mcp/dist/index.js"]`（Windows 写 `C:/path/to/...`，JSON 里用正斜杠免转义；未构建可跑源码：`npx tsx` + `src/index.ts`）
- `CODESIGN_URL` / `CODESIGN_PASSWORD` 也写入 env 后，调用工具时无需再传 `url` / `password`
- Windows 原生环境部分宿主无法直接执行 `npx`，需改为 `"command": "cmd"`、`"args": ["/c", "npx", "-y", "codesign-prd-mcp"]`
- VLM 视觉解析默认关闭：纯 DOM 提取（不截图、更快），流程图/内嵌图解析不可用，其余正常；传 `vlmEnabled:true` 且配置 `VLM_API_KEY` 时启用，只配了 Key 不传参也不启用

## MCP 工具

| 工具 | 作用 |
|---|---|
| `get_prototype_outline` | 获取原型页面目录大纲（左侧导航树） |
| `get_page_content` | 读取单个页面的结构化内容 |
| `get_requirement_doc` ⭐ | 获取指定需求分组的完整 PRD（自动遍历所有页面） |
| `analyze_flowchart` | 分析流程图截图，输出节点/连线 + Mermaid |
| `cache_stats` / `clear_cache` | 查看与清空 VLM 解析缓存 |

常用参数（完整定义见工具 description）：`groupName` / `pageName` 定位分组或页面；`detailLevel` 三档详细度 `summary`/`standard`/`full`；`pageNames` 断点续跑时只重跑指定页（段级缓存，已完成的秒回）；`outputFile:false` 强制返回全文（默认大文档 >30KB 自动落盘到 `output/` 并返回路径+摘要）。

## 环境变量

| 变量 | 说明 |
|---|---|
| `VLM_API_KEY` | 视觉模型 API Key；VLM 默认关闭，传 `vlmEnabled:true` 且配置了本变量才启用 |
| `VLM_BASE_URL` / `VLM_MODEL` | 默认 `https://api.openai.com/v1` / `gpt-4o`，任何 OpenAI 兼容接口均可 |
| `CODESIGN_URL` / `CODESIGN_PASSWORD` | CoDesign 分享链接与访问密码，预置后调用免传 |

调优参数（并发/超时/重试/token 上限）见 `src/vlm.ts` 的环境变量定义。

## 命令行脚本（无需 Agent）

```bash
npm run generate -- --url=https://codesign.qq.com/s/xxx --group=<分组名> --password=XXXX
```

## 已知限制

- 仅支持「分享链接 + 密码」访问，不支持需登录的私有原型
- VLM 识别可能有误差，文档中会标注置信度和待确认项
- 缓存无 TTL，长期不用可用 `clear_cache` 或删除 `.codesign-mcp/cache/` 清理

## License

MIT
