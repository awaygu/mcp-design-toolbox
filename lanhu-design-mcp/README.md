# lanhu-design-mcp

零依赖 stdio MCP server，让任意支持 MCP 的 coding Agent 直接读蓝湖设计稿做开发：

- **结构化图层树**：官方 API（Cookie 直调）取 x/y/宽高/色值/字号/圆角/描边/阴影/文本——精确数值来自结构化数据，不靠视觉模型 OCR 截图小字
- **团队目录导航**：团队 → 项目 → 分组（需求）→ 设计稿，一次拉取、按需下钻
- **切图下载**：单稿或分组批量，三层去重 + 字节级验真
- **视觉理解**：配置视觉模型后自动理解设计稿封面语义

## 安装

```bash
npm install && npm run build   # esbuild 打包为单文件 dist/index.js
npx playwright install chromium   # 仅登录脚本需要
```

## 准备蓝湖 Cookie

- **推荐**：F12 → Network → 复制任意请求的 `Cookie` 头整串，写入同一文件
- **备用**：双击 `lanhu-login.bat`（或 `npm run login`），浏览器登录后回终端按 Enter，cookie 自动写入 `.mcp-local/lanhu.cookie`（已 gitignore）
- 过期后重新拿Cookie即可；工具遇 401 会先区分「过期」与「该资源无权限」

## 接入 Agent（MCP 配置）

### Claude Code

项目根 `.mcp.json`：

```json
{
  "mcpServers": {
    "lanhu-design-mcp": {
      "command": "npx",
      "args": ["-y", "lanhu-design-mcp"],
      "env": {
        "VLM_API_KEY": "your-api-key",
        "LANHU_COOKIE_FILE": "./.mcp-local/lanhu.cookie"
      }
    }
  }
}
```

### Codex CLI

编辑 `~/.codex/config.toml`（TOML 格式，键名是 `mcp_servers` 下划线）：

```toml
[mcp_servers.lanhu-design-mcp]
command = "npx"
args = ["-y", "lanhu-design-mcp"]
env = { VLM_API_KEY = "your-api-key", LANHU_COOKIE_FILE = "./.mcp-local/lanhu.cookie" }
```

### OpenCode

项目根 `opencode.json`（注意差异：`mcp`、`command` 是数组、env 键名是 `environment`）：

```json
{
  "mcp": {
    "lanhu-design-mcp": {
      "type": "local",
      "command": ["npx", "-y", "lanhu-design-mcp"],
      "environment": {
        "VLM_API_KEY": "your-api-key",
        "LANHU_COOKIE_FILE": "./.mcp-local/lanhu.cookie"
      },
      "enabled": true
    }
  }
}
```

### 注意事项

- TRAE / Cursor / Cline 等其他宿主用 Claude Code 的通用 `mcpServers` JSON 格式即可
- cookie 优先级：工具入参 `cookie` > 环境变量 `LANHU_COOKIE` > 文件。⚠️ 设过 `LANHU_COOKIE` 环境变量会压制文件内容——登录脚本续期后仍 401 就是这个原因，需删除/更新该环境变量
- `VLM_API_KEY`（任意 OpenAI 兼容端点，默认 DeepSeek）配好后 `lanhu_fetch_design` 自动返回视觉理解；不配则跳过
- 源码开发把 `command`/`args` 改为 `node` + `/path/to/lanhu-design-mcp/dist/index.js`（Windows 写 `C:/path/to/...`，正斜杠免转义）；npm 包已发布，可 `npx -y lanhu-design-mcp` 免构建

## 工具

| 工具 | 用途 |
|---|---|
| `lanhu_check_auth` | 探活 cookie，区分「已过期」与「无权限」 |
| `lanhu_list_teams` | 列出账号加入的全部团队 |
| `lanhu_list_directory` | 一次拉团队目录（项目 → 分组） |
| `lanhu_read_sector` | 按分组列设计稿目录（稿名/尺寸/层数） |
| `lanhu_fetch_design` ⭐ | 读单稿结构化图层树 + 视觉语义理解 |
| `lanhu_download_slices` | 切图下载到本地 assets（单稿 / 分组批量） |

工具入参 schema 自描述，Agent 在工具列表里即可看到完整入参说明；其余调优环境变量（并发/超时/缓存/剔除阈值）见 `src/` 内定义。

## 红线

- 蓝湖小字（色值、字号、间距）**只从 `lanhu_fetch_design` 结构化数据取**，绝不靠视觉模型 OCR 截图——图片压缩后小字必读错
- 视觉模型结论只当线索；钱 / 权限 / 用户数据相关流程必须人审
- 没调 `lanhu_check_auth` 探活前不断定 cookie 过期——单资源 401 多半是权限问题，重新登录无效

## License

MIT
