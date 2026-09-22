# shimo-mcp

零浏览器依赖的 stdio MCP server：结构化读取**石墨文档（shimo.im）表格**数据，供任意 MCP 宿主在开发流程中直接取用。

- **读表格**：按工作表读取行列数据，输出 `[{_row, 中文, 英文, …}]`（`_row` 为石墨 UI 行号，1-based、表头=1，与网页一致）
- **增量取数**：`rows` / `columns` 按行号与表头取指定行列，文档更新后不必全量重拉
- **i18n 导出**：列映射配置表（exact/regex/fuzzy）适配任意列名，生成各语言 key→文案 JSON（缺值兜底 + 漏填清单）
- **xlsx 导出**：走石墨「批量下载」通道落盘，本地零依赖解析出 sheet 清单（石墨没有该 API）
- **cookie 探活**：区分「cookie 过期」与「单文档无权限」，不再一刀切让用户重新登录

## 安装

```bash
npm install && npm run build   # esbuild 打包到 dist/index.js（单文件）
```

## 准备石墨 Cookie

浏览器登录 shimo.im → F12 → Network → 复制任意请求的 `Cookie` 请求头整串，写入 `.mcp-local/shimo.cookie`（已 gitignore），或设环境变量 `SHIMO_COOKIE`。Cookie 通常几天到几周过期，重新复制即可。

## 接入 Agent（MCP 配置）

### Claude Code

项目根 `.mcp.json`：

```json
{
  "mcpServers": {
    "shimo-mcp": {
      "command": "npx",
      "args": ["-y", "shimo-mcp"],
      "env": {
        "SHIMO_COOKIE_FILE": "./.mcp-local/shimo.cookie",
        "SHIMO_URL": "https://shimo.im/sheets/xxx/yyy"
      }
    }
  }
}
```

### Codex CLI

编辑 `~/.codex/config.toml`（TOML 格式，键名是 `mcp_servers` 下划线）：

```toml
[mcp_servers.shimo-mcp]
command = "npx"
args = ["-y", "shimo-mcp"]
env = { SHIMO_COOKIE_FILE = "./.mcp-local/shimo.cookie", SHIMO_URL = "https://shimo.im/sheets/xxx/yyy" }
```

### OpenCode

项目根 `opencode.json`（注意差异：`mcp`、`command` 是数组、env 键名是 `environment`）：

```json
{
  "mcp": {
    "shimo-mcp": {
      "type": "local",
      "command": ["npx", "-y", "shimo-mcp"],
      "environment": {
        "SHIMO_COOKIE_FILE": "./.mcp-local/shimo.cookie",
        "SHIMO_URL": "https://shimo.im/sheets/xxx/yyy"
      },
      "enabled": true
    }
  }
}
```

### 注意事项

- TRAE / Cursor / Cline 等其他宿主用 Claude Code 的通用 `mcpServers` JSON 格式即可
- 源码开发把 `command`/`args` 改为 `node` + `/path/to/shimo-mcp/dist/index.js`（Windows 写 `C:/path/to/...`，正斜杠免转义）
- `SHIMO_URL` 预置默认文档链接后，工具调用免传 `url`
- cookie 优先级：工具入参 `cookie` > 环境变量 `SHIMO_COOKIE` > 文件

## 工具

| 工具 | 作用 |
|---|---|
| `shimo_check_auth` | 探活 cookie（可顺带返回文档名/权限/更新时间） |
| `shimo_read_sheet` ⭐ | 读单个工作表：表头 + 数据行（带 `_row` 行号） |
| `shimo_read_column` | 读单列 `[{_row, value}]`（空值保留），配 `rows` 精确取某行在某列的值 |
| `shimo_list_sheets` | 列出全部工作表名（走 xlsx 通道，约 5~20s） |
| `shimo_export_xlsx` | 导出整文档 xlsx 落盘；传 `sheet` 抽取单表另存 |
| `shimo_export_i18n` | 生成各语言 key→文案 JSON（多行文案拆 key_N） |

- **分页**：`shimo_read_sheet` 默认最多 200 行（`truncated:true` 表示还有更多），大表用 `rows` 按行号分段取，避免撑爆上下文；`shimo_read_column` 默认放宽到 500 行
- **列映射**（`shimo_export_i18n`）：表头与内置语言关键词对不上时，传 `columnMap` 入参或建 `.mcp-local/shimo-column-map.json`（配置表优先于内置规则；key 列、备注列天然排除）：

```json
[
  { "match": "english", "lang": "en" },
  { "match": "^繁体", "lang": "zh-TW", "type": "regex" },
  { "match": "pt-BR", "lang": "pt", "type": "exact" }
]
```

## 红线

- 翻译文案一律从结构化数据取（values API / xlsx），不要截图 OCR
- Cookie 是完整登录态，只发往 `shimo.im`（及石墨导出 CDN），不入库、不打日志
- `_row` 行号与 Agent/用户在网页上看到的行号一致，报 bug 时可直接引用

## License

MIT
