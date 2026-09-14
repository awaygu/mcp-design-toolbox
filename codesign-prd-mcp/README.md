# CoDesign PRD MCP Server

读取腾讯 CoDesign 产品原型（Axure），**分段截图 + VLM 视觉解析**，生成纯文本结构化需求文档（PRD），供 AI Coding Agent 直接使用——Agent 只拿文字，不需要看图、不需要处理截图路径。

## 功能特性

- **6 个 MCP 工具**：获取原型大纲、读取单页内容、生成整份需求文档、单独分析流程图、查看/清理解析缓存
- **结构化 DOM 提取**：不靠 `innerText` 揉成文本流，改用 Axure 导出自带的确定性语义——控件前导注释（类型）、`.table_cell` + viewbox 坐标（表格网格）、`.text > <p>`（行结构）、连接线 `_segN` 几何（流程图拓扑）
- **确定性优先、VLM 补充**：表格与流程图优先用 DOM 还原（零调用成本、零幻觉），视觉模型负责组件/交互/状态等语义补充；两者分区输出并各自标注来源，文末汇总待确认项
- **Agent 友好输出**：表格 / 流程 / 规则 / 界面文案 / 交互状态各成一节，同时产出机器可读的 JSON（`output/<分组>_结构化数据.json`），不用反解 Markdown
- **表格语义标题推断**：DOM 表格按 `.table_cell` 边界矩形找**正上方紧贴**的标注文本块作标题（如「活动奖励明细(活动结束后手动发放…)」），渲染为 `表格 N · 标题`——不再是无语义的「表格 1/表格 2」；标题也写入结构化 JSON 的 `tables[].title`
- **输出降噪**（画布型大页内容多时不刷屏）：控件文案**按界面区块分组**——以大内嵌图为锚点把画布切成界面区块（区块归属 `sec` 也写进结构化 JSON），mockup 的示例文案归属到所属界面，画布散落文字（全局规则/标题）单列「画布级说明与规则」，不再页面级平铺；说明与规则整块去重计数（相同文案合并为 ×N）；相邻同表头的表格自动合并（Axure 常把长表拆成两段）；「页面文字」兜底剔除纯符号行、整行重复、以及已被表格/控件块覆盖的内容。回归验证：`npm run test:doc`
- **分段截图**：超大页面自动网格分段滚动截图，宽图/长图内容完整不丢失
- **VLM 解析**：流程图 / 表格 / 普通页面三类专用 Prompt 并行调用，输出结构化 JSON
- **结果合并**：多段解析自动去重、补全、交叉验证，文末标注置信度与待确认项
- **纯文本输出**：输出 Markdown PRD，无需在 Agent 上下文里塞截图
- **DOM 网格表格重建**：Axure 的定位式表格（无真 <table>）优先用语义化 .table_cell 单元格直接重建 Markdown 表格（确定性、零 VLM 成本）；无语义标记时按坐标聚类重建。防误判门槛：单元格体积、内嵌大图数量、每格碎块密度——原型画布/截图拼贴页自动回落纯文字
- **画布页空间切分**：整页画布（多界面拼贴）以大内嵌图（手机屏截图）为锚点，把周边文字聚成「界面区块」，逐块输出——不再是一坨无结构的文字堆
- **缓存机制**：基于截图文件哈希缓存 VLM 结果，重复运行不重复付费调用
- **三档详细度**：`summary` / `standard` / `full`，适配不同场景
- **优雅降级**：未配置视觉模型时自动退化为仅 DOM 文字提取

## 安装与运行

```bash
cd codesign-prd-mcp
npm install            # 只装依赖，不再自动构建
npm run build          # 编译到 dist/index.js（首次或改 src/ 后需手动执行）
npx playwright install chromium   # 仅首次需要
```

常用脚本：

```bash
npm run build      # esbuild 打包：src → dist/index.js（单文件 + minify）
npm run typecheck  # 只做类型检查
npm run dev        # tsx 直接以 TS 源码启动 MCP Server（stdio，免构建）
npm start          # 运行编译产物 dist/index.js
npm run verify     # 端到端自检：真实链接爬取 → 结构化提取 → 生成文档（加 -- --vlm 带视觉模型）
npm run test:doc   # 文档输出清理回归：规则去重 / 表格合并 / 页面文字去噪（合成用例，离线）
```

## 接入 Agent（MCP 配置）

**npm 包（推荐，免 clone 免构建）**：

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

**源码方式**（参与开发时用，路径换成你的实际位置）：

```json
{
  "mcpServers": {
    "codesign-prd-mcp": {
      "command": "node",
      "args": ["/绝对路径/mcp-design-toolbox/codesign-prd-mcp/dist/index.js"],
      "env": {
        "VLM_API_KEY": "your-api-key",
        "VLM_BASE_URL": "https://api.openai.com/v1",
        "VLM_MODEL": "gpt-4o"
      }
    }
  }
}
```

> 首次使用需安装浏览器内核：`npx playwright install chromium`（爬取 Axure 原型用）。
> 未构建时也可直接跑源码：把 `command` 换成 `npx tsx`、`args` 换成 `["/path/to/codesign-prd-mcp/src/index.ts"]`。
> `CODESIGN_URL` / `CODESIGN_PASSWORD` 写在 `env` 里后，调用工具时可不传 `url` / `password`。

## MCP 工具一览

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `get_prototype_outline` | 获取原型页面目录大纲（左侧导航树） | `url?` / `password?` |
| `get_page_content` | 读取单个页面的结构化内容（组件/交互/表格/内嵌原型图清单） | `url?` / `password?` / `pageName` / `vlmEnabled?` |
| `get_requirement_doc` ⭐ | 获取指定需求分组的完整 PRD（自动遍历所有页 + 分段截图 + VLM 解析） | `url?` / `password?` / `groupName`(必填) / `vlmEnabled?` / `detailLevel?` / `outputFile?` / `pageNames?`(按页分块重跑) |
| `analyze_flowchart` | 单独分析一张流程图截图，输出节点/连线/分支 + Mermaid | `imagePath`(必填) |
| `cache_stats` | 查看 VLM 解析缓存的条目数与体积 | 无 |
| `clear_cache` | 清空 VLM 解析缓存，下次调用重新请求视觉模型 | 无 |

**VLM 分级策略**：VLM 只用于 DOM 提取不到的内容——内嵌图（图内文字，DOM 无法获取）始终单独定向解析；整页分段仅对 DOM 提取不到内容的页面运行（纯图片页、DOM 拓扑还原失败的流程图）。表格、规则文字、流程拓扑均由 DOM 确定性提取并作为真源优先渲染，无需视觉模型参与。

`get_requirement_doc` 默认把大文档（>30KB）自动写入 `output/<分组名>_需求文档.md` 并返回**文件路径 + 每页摘要**（显式传 `outputFile:true` 恒写文件、`outputFile:false` 强制全文），避免大文档占满上下文；之后按需读文件即可。`detailLevel` 默认 `standard`，分组名不确定时直接调用，失败会返回候选列表。

**断点续跑/分块**：超时或中断后，用 `pageNames: ["页面A","页面B"]` 只重跑指定页；缓存是**段级增量**的——每个分段/内嵌图解析完成立即落盘，重跑只补缺失的段，已完成的段（甚至已完成的页）秒回，不再整组从头再来；未命中的页面名会在返回中以错误条目列出可用页面。

**进度上报与宿主超时**：`get_prototype_outline` / `get_page_content` / `get_requirement_doc` / `analyze_flowchart` 四个长工具均支持 progress 通知（宿主在请求 `_meta` 里带 `progressToken` 时生效）：逐页爬取、逐段 VLM 解析实时上报，单次 VLM 调用期间（实测可达 100s+）另有 15s 心跳兜底。大多数宿主（Claude/Code 等）每收到一条进度就重置请求计时器，长任务不会再撞默认 60s 请求超时。

> **MCP Inspector 注意**：v2 的 config 文件 server 条目支持 `"requestTimeout": 600000`（毫秒），web 与 TUI 模式会接到 SDK 客户端；**web 模式**另有一层后端 `/api/mcp/send` 的 60s 等待不受 progress 和该配置影响，需跑一次仓库根目录的 `node scripts/patch-inspector.mjs`（npx 缓存清理或 inspector 升级后重跑；把后端等待改为读 `MCP_SEND_WAIT_TIMEOUT_MS`，默认 1800s = 30 分钟）。**CLI 模式** v2.6.0 有 bug：config 的 requestTimeout 被解析但从未传给客户端（TUI/web 均正常），补丁脚本会一并注入环境变量接线：调用时设 `MCP_REQUEST_TIMEOUT_MS=600000` 即可。

## 命令行脚本

无需 Agent，也能直接用脚本生成文档（链接与密码通过参数传入，不写进代码）：

```bash
# 生成需求文档
npm run generate -- --url=https://codesign.qq.com/s/xxx --group=会员体系优化 --password=XXXX

# 只验证爬取层（不调视觉模型）
npm run test:crawl -- --url=https://codesign.qq.com/s/xxx --group=会员体系优化 --password=XXXX

# 也可用环境变量代替参数：CODESIGN_URL / CODESIGN_GROUP / CODESIGN_PASSWORD
```

输出：`output/<分组名>_需求文档_v2.md` 与 `output/<分组名>_merged_v2.json`（结构化数据）。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `VLM_API_KEY` | 否 | - | 视觉模型 API Key，配置后启用流程图/表格/页面自动解析 |
| `VLM_BASE_URL` | 否 | `https://api.openai.com/v1` | API 基础 URL（带不带 `/v1` 均可，自动归一化） |
| `VLM_USE_V1` | 否 | `1` | 设 `0` 切到不带 `/v1` 的 `/chat/completions`（少数网关） |
| `VLM_MODEL` | 否 | `gpt-4o` | 视觉模型名称 |
| `VLM_MAX_PARALLEL` | 否 | `3` | 视觉模型请求最大并发数 |
| `VLM_TIMEOUT_MS` | 否 | `180000` | 单段请求超时（推理型模型单次可达 100s+，勿设太小） |
| `VLM_MAX_ATTEMPTS` | 否 | `5` | 瞬态错误（网络/超时/429/5xx）最大尝试次数；429 另有全局限流惩罚（退避翻倍 + 并发共享排队） |
| `VLM_MAX_TOKENS` | 否 | `8192` | 单次输出 token 上限 |
| `CODESIGN_URL` | 否* | - | CoDesign 分享链接（*脚本模式必填） |
| `CODESIGN_PASSWORD` | 否 | - | 访问密码，无密码可不填 |

支持任何 OpenAI 兼容的视觉模型接口（豆包、GPT-4o、Claude 等）。

## 已知限制

- **VLM 识别精度**：流程图和表格由 VLM 从图片识别，可能有误差，文档中会标注置信度和待确认项
- **浏览器单例**：进程内只有一个 page，涉及浏览器的工具调用会被串行排队
- **登录态**：仅支持「分享链接 + 密码」访问，不支持需登录的私有原型
- **缓存无 TTL**：缓存只增不减，长期不用可用 `clear_cache` 工具或删除 `.codesign-mcp/cache/` 清理

## License

MIT
