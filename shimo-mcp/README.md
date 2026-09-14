# shimo-mcp

零浏览器依赖的 stdio MCP server：读取**石墨文档（shimo.im）多语言翻译表格**的结构化数据，
供任意 MCP 宿主（Claude Code / Cursor / Trae / opencode）在开发流程中直接取用翻译文案。

核心能力：

- **读翻译表**：按工作表（底部标签页）读取行列数据，表头自动识别语言列（中文/繁体/英文/印尼/马来/葡/西/印地/越南/土耳其/阿拉伯…），输出 `[{_row, 中文, 英文, …}]` 结构。
- **增量取数**：`rows` 按石墨 UI 行号取指定行、`languages` 按语言码取指定列——文档更新后不必全量重拉。
- **xlsx 导出**：走石墨「批量下载」通道导出整个文档为 xlsx 落盘；本地零依赖解析出 sheet 清单（石墨没有 sheet 清单 API）。
- **i18n JSON**：一键生成各语言 `key→文案` 映射，可落盘为 `<lang>.json` 直接喂前端 i18n 框架。
- **cookie 探活**：区分「cookie 过期」与「单文档无权限」，不再一刀切让用户重新登录。

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
| `shimo_read_sheet` ⭐ | 读单个工作表：表头+数据行（带 `_row` 石墨行号），自动识别语言列 | `url?` / `sheet` / `rows?` / `languages?` / `limit?` |
| `shimo_list_sheets` | 列出全部工作表名（走 xlsx 导出通道解析，约 5~20s） | `url?` |
| `shimo_export_xlsx` | 导出 xlsx 落盘；传 `sheet` 则从整文档抽取该单个工作表另存为独立 xlsx | `url?` / `sheet?` / `outputPath?` / `fileName?` |
| `shimo_export_i18n` | 生成各语言 key→文案映射（key 默认 `txt_中文首字码+行号`，多行文案拆 `key_0/key_1…`；仅中文有值的行视为分组行跳过；其他语言缺值用英文兜底） | `url?` / `sheet` / `languages?` / `keyColumn?` / `outputPath?` |

`url?` 表示可不传：未传时使用环境变量 `SHIMO_URL` 配置的默认文档链接。

### 使用示例

```
// 只取某个需求的英文+阿拉伯语列、指定行（增量场景）
shimo_read_sheet({
  url: "https://shimo.im/sheets/xxx/yyy",
  sheet: "会员体系文案",
  rows: [2, 3, 4],              // 石墨 UI 行号（表头恒为第 1 行，自动带出）
  languages: ["zh", "en", "ar"] // 语言码或表头名（"英文"/"阿拉伯语"）
})

// 只把一个工作表导出为独立 xlsx 文件（从整文档 xlsx 抽取，本地零依赖重写）
shimo_export_xlsx({
  url: "https://shimo.im/sheets/xxx/yyy",
  sheet: "会员体系文案",         // 不传=整文档全部工作表
  outputPath: "output/"
})
// → output/会员体系文案.xlsx（含该表全部行列，Excel/WPS 可直接打开）

// 导出 i18n JSON 到本地
shimo_export_i18n({
  url: "https://shimo.im/sheets/xxx/yyy",
  sheet: "1v1活动",
  outputPath: "src/i18n/"       // → src/i18n/zh.json, src/i18n/en.json, …
})
// key 规则（默认，与 multilingual-excel-converter 脚本一致）：
//   txt_ + 中文首字符编码 + 石墨行号，如第 5 行「登录」→ "txt_30331_5"
//   中文缺失 → "txt_row_5"；传 keyColumn 则用该列的值作 key
//   含换行的文案按行拆分 → "txt_30331_5_0"、"txt_30331_5_1"（空行剔除）
// 行规则：只有中文有值的行 = 分组行（小节标题），不导出（返回 skippedGroups 计数）；
//   其他语言列缺值时用英文值兜底（如只有中文+英文，则繁体/印尼语等列都用英文）；
//   漏填会记入 missing 字段（行号/key/缺的语言）并附 warning，兜底只是补救、漏填仍需补填
```

**分页纪律**：`shimo_read_sheet` 默认最多返回 200 行（`truncated:true` 表示还有更多）。
大表按行号分段取（如先 `rows:[2..201]` 再 `rows:[202..401]`），避免撑爆 Agent 上下文。

## 数据链路（实测验证，2026-09）

```
行列数据：GET shimo.im/api/sas/files/{guid}/sheets/values?range={sheet}!A1:Z{end}
          Cookie 认证；单次 ≤5000 单元格 → 内置按 180 行/块分页，连续 50 空行视为结束
文件元数据：GET shimo.im/lizard-api/files/{guid}（名称/角色/更新时间）
xlsx 导出：POST /panda-api/drive/batch_downloads {guids:[guid]}
          → 轮询 GET /panda-api/drive/tasks/{taskId} 直到 completed
          → 下载 detail.url（ZIP）→ 解出 xlsx（本地零依赖解析 sheet 清单/单元格）
```

注意：

- 石墨**没有 sheet 清单 REST API**（前端从加密快照解析），`shimo_list_sheets` 走一次导出通道实现。
- 表格内容快照（`I-encrypt-*`）是私有加密格式，不可直接解析——读数据一律走 values API。
- 公开版石墨不识别 `Authorization: Bearer`，只认浏览器 Cookie；企业版 lizard-api 接口对公开版账号返回 404。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `SHIMO_COOKIE` | 与 `SHIMO_COOKIE_FILE` 二选一 | — | 石墨登录 Cookie 串（F12 复制） |
| `SHIMO_COOKIE_FILE` | 同上 | — | Cookie 文件路径（内容为完整 cookie 串，gitignore） |
| `SHIMO_URL` | 否 | — | 默认石墨文档链接；工具调用不传 `url` 时使用 |
| `SHIMO_BASE_URL` | 否 | `https://shimo.im` | 石墨端点（私有部署可改） |
| `SHIMO_EXPORT_DIR` | 否 | `./.mcp-local` | `shimo_list_sheets` 临时产物落盘目录 |

> cookie 优先级：工具入参 `cookie` > `SHIMO_COOKIE` > `SHIMO_COOKIE_FILE` 文件。
> url 优先级：工具入参 `url` > `SHIMO_URL`；都没有时报错提示。注意 `SHIMO_URL` 是文档链接，`SHIMO_BASE_URL` 是站点端点，两者互不相干。

## 语言码对照（表头自动识别）

| 表头关键词 | 语言码 | Android 目录（参考） |
|---|---|---|
| 中文 | `zh` | values-zh |
| 繁体 | `zh-TW` | values-zh-rTW |
| 英文 | `en` | values（默认） |
| 印尼语 | `in` | values-in |
| 马来文 | `ms` | values-ms |
| 葡萄牙语 | `pt` | values-pt |
| 西班牙语 | `es` | values-es |
| 印地语 | `hi` | values-hi |
| 越南语 | `vi` | values-vi |
| 土耳其语 | `tr` | values-tr |
| 阿拉伯语 | `ar` | values-ar |
| key/文案名 | `_key` | （作 key 列，不是语言） |
| UI | `_ui` | （翻译备注列，导出时跳过） |

识别不到的表头原样保留，可把它当表头名传给 `languages` 或 `keyColumn`。

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
