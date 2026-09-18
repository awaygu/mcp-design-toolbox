# shimo-mcp

零浏览器依赖的 stdio MCP server：结构化读取**石墨文档（shimo.im）表格**数据，
供任意 MCP 宿主（Claude Code / Cursor / Trae / opencode）在开发流程中直接取用。

核心能力：

- **读表格**：按工作表（底部标签页）读取行列数据，输出 `[{_row, 中文, 英文, …}]` 结构。
- **增量取数**：`rows` 按石墨 UI 行号取指定行、`columns` 按表头名/列序取指定列——文档更新后不必全量重拉。
- **单列直读**：`shimo_read_column` 传一个表头名/列序即返回 `[{_row, value}]` 行号→值列表（空值保留，缺翻译行一目了然）；配 `rows:[行号]` 可精确取「某行在某列」的值。
- **清洗与结构化**：单元格统一为文本、空行剔除且行号对齐石墨 UI、表头缺失自动合成。
- **i18n 导出（可选）**：生成各语言 key→文案 JSON；列→语言映射由配置表驱动（exact/regex/fuzzy 三种匹配），key 规则、缺值兜底、分组行全部可配，不写死任何团队约定。
- **xlsx 导出**：走石墨「批量下载」通道导出整个文档为 xlsx 落盘；本地零依赖解析出 sheet 清单（石墨没有 sheet 清单 API）。
- **cookie 探活**：区分「cookie 过期」与「单文档无权限」，不再一刀切让用户重新登录。

内置规则只覆盖常见语言关键词；其他团队的列名差异用**列映射配置表**（`columnMap` 参数或 `.mcp-local/shimo-column-map.json`）扩展/覆盖，业务语义全部走配置，代码不写死。

基于官方 MCP SDK（`@modelcontextprotocol/sdk` + `zod`）；xlsx 解析为内置纯 Node 实现，无 sharp/playwright 依赖。

## 环境要求

- Node.js >= 18

## 安装 & 构建

```bash
npm install
npm run build    # esbuild 打包到 dist/index.js（单文件）
```

## 准备石墨 Cookie

浏览器登录 shimo.im → F12 → Network → 点任意请求 → 复制 `Cookie` 请求头整串，写入本地文件
`.mcp-local/shimo.cookie`（已 gitignore），或直接设环境变量 `SHIMO_COOKIE`。

> Cookie 会过期（通常几天到几周）。AI 遇到 401 会先调 `shimo_check_auth` 判断，真过期时提示你重新复制。

## 接入 Agent（项目根 `.mcp.json`）

**npm 包（推荐，免 clone 免构建）**：

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

**源码方式**（参与开发时用）：

```json
{
  "mcpServers": {
    "shimo-mcp": {
      "command": "node",
      "args": ["/绝对路径/mcp-design-toolbox/shimo-mcp/dist/index.js"],
      "env": {
        "SHIMO_COOKIE_FILE": "./.mcp-local/shimo.cookie"
      }
    }
  }
}
```

## 工具一览

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `shimo_check_auth` | 探活 cookie（可顺带返回文档名/权限/更新时间） | `url?` / `cookie` |
| `shimo_read_sheet` ⭐ | 读单个工作表：表头+数据行（带 `_row` 石墨行号） | `url?` / `sheet` / `rows?` / `columns?` / `limit?` |
| `shimo_read_column` | 读单列：`[{_row, value}]` 行号→值列表（空值保留；配 `rows:[行号]` 精确取某行在某列的值） | `url?` / `sheet` / `column` / `rows?` / `limit?` |
| `shimo_list_sheets` | 列出全部工作表名（走 xlsx 导出通道解析，约 5~20s） | `url?` |
| `shimo_export_xlsx` | 导出 xlsx 落盘；传 `sheet` 则从整文档抽取该单个工作表另存为独立 xlsx | `url?` / `sheet?` / `outputPath?` / `fileName?` |
| `shimo_export_i18n` | 生成各语言 key→文案 映射 JSON（多行文案拆 key_N；缺值兜底 + 漏填清单；列映射配置表驱动，适配任意列名） | `url?` / `sheet` / `columns?` / `columnMap?` / `keyColumn?` / `fallbackLanguage?` / `groupRows?` / `rows?` / `outputPath?` |

### 列映射配置表（columnMap）

表头与内置语言关键词对不上时（其他团队列名任意），用映射配置表把表头映射到语言码。两种提供方式可同时用（入参优先）：

- 工具入参 `columnMap`：`[{ "match": "...", "lang": "en", "type": "fuzzy" }]`
- 配置文件 `.mcp-local/shimo-column-map.json`（路径可用 `SHIMO_COLUMN_MAP_FILE` 改），一次配置长期复用

| type | 语义 | 示例 |
|---|---|---|
| `fuzzy`（默认） | 归一化（小写、去空白标点）后双向包含 | `"english"` 命中 `English (US)` |
| `regex` | 正则，忽略大小写 | `"^繁体"` 命中 `繁体中文` |
| `exact` | 表头全等 | `"pt-BR"` 只命中 `pt-BR` |

```json
[
  { "match": "english", "lang": "en" },
  { "match": "^繁体", "lang": "zh-TW", "type": "regex" },
  { "match": "pt-BR", "lang": "pt", "type": "exact" }
]
```

配置表优先于内置规则（先查配置，未命中再走内置）。未命中任何规则的列不会导出为语言——key 列、备注列无需配置，天然排除；需要以某列的值作为 key 时传 `keyColumn`（表头名）。

`url?` 表示可不传：未传时使用环境变量 `SHIMO_URL` 配置的默认文档链接。

**分页**：`shimo_read_sheet` 默认最多返回 200 行（`truncated:true` 表示还有更多），大表用 `rows` 按行号分段取，避免撑爆 Agent 上下文。`shimo_read_column` 单列体积小，默认放宽到 500 行，取法相同。

**语言识别（仅 `shimo_export_i18n`）**：按表头自动识别语言列（内置常见语言关键词 + `columnMap` 配置）；识别不到的表头原样保留，可把它当表头名传给 `columns` 或 `keyColumn`。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `SHIMO_COOKIE` | 与 `SHIMO_COOKIE_FILE` 二选一 | — | 石墨登录 Cookie 串（F12 复制） |
| `SHIMO_COOKIE_FILE` | 同上 | — | Cookie 文件路径（内容为完整 cookie 串，gitignore） |
| `SHIMO_URL` | 否 | — | 默认石墨文档链接；工具调用不传 `url` 时使用 |
| `SHIMO_BASE_URL` | 否 | `https://shimo.im` | 石墨端点（私有部署可改） |
| `SHIMO_COLUMN_MAP_FILE` | 否 | `./.mcp-local/shimo-column-map.json` | i18n 列映射配置表路径，存在即自动加载（工具入参 `columnMap` 优先） |

> cookie 优先级：工具入参 `cookie` > `SHIMO_COOKIE` > `SHIMO_COOKIE_FILE` 文件。
> url 优先级：工具入参 `url` > `SHIMO_URL`；都没有时报错提示。注意 `SHIMO_URL` 是文档链接，`SHIMO_BASE_URL` 是站点端点，两者互不相干。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # tsx 直接跑源码（stdio）
npm run build       # esbuild → dist/index.js

# 端到端测试（真实文档，需 SHIMO_COOKIE）
SHIMO_COOKIE="$(cat .mcp-local/shimo.cookie)" npx tsx scripts/e2e.ts
SHIMO_COOKIE="$(cat .mcp-local/shimo.cookie)" node scripts/mcp-e2e.mjs   # MCP 协议层
```

## 红线

- **翻译文案一律从结构化数据取**（values API / xlsx），不要截图 OCR。
- Cookie 是完整登录态，只发往 `shimo.im`（及石墨导出 CDN），不入库、不打日志。
- `shimo_read_sheet` 的行号是**石墨 UI 行号**（1-based，表头=1），与 Agent/用户在网页上看到的行号一致，报 bug 时可直接引用。
