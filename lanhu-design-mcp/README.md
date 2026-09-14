# lanhu-design-mcp

零依赖 stdio MCP server，让任意支持 MCP 的 coding Agent（Claude Code / Cursor / Trae /
opencode）获得三件事：

- **读蓝湖的眼睛**：通过蓝湖官方 API（Cookie 直调，无需浏览器）取结构化图层树
  （x/y/宽高/色值/字号/圆角（含逐角）/描边/阴影（内外）/文本），精确数值来自结构化数据，**不靠视觉模型 OCR 截图上的小字**。
- **按项目/分组组织**：`lanhu_list_directory` 一次拉全团队目录（**无需链接**，项目→分组一页地图），
  `lanhu_read_sector` 按分组列稿目录（不含图层树，防上下文爆炸），支持「团队 → 项目 → 分组（需求）→ 设计稿」完整层级。
- **下载切图**：`lanhu_download_slices` 把设计稿切图素材拉到本地 assets，供开发引用。
- **视觉理解 + 验收**：`lanhu_fetch_design` 在配置了视觉模型时**默认自动**理解设计稿封面图（返回 `visionAnalysis`），无需每次手带 `analyze`；`lanhu_verify_render` /
  `vision_defect_check` / `vision_e2e_triage` 做渲染对比、UI 缺陷检测、E2E 失败归因。

TypeScript 实现，基于官方 MCP SDK（`@modelcontextprotocol/sdk` + `zod`）。
你自己的 coding Agent 就是流水线里的"代码生成引擎"——本 MCP 只负责"读设计"和"做验收"。

## 环境要求

- Node.js >= 18

## 安装 & 构建

```bash
npm install      # 装 SDK + zod
npm run build    # tsc 编译到 dist/
```

## 快速开始

### 1. 准备蓝湖 Cookie（仅需 Cookie）

从浏览器 F12 → Network → 任意请求的 `Cookie` 头复制，写入本地文件 `.mcp-local/lanhu.cookie`（已 gitignore，不入仓库）。
多团队场景：cookie 即可列团队（`lanhu_list_teams`）+ 从链接 tid 定位（`lanhu_list_directory({url})`）。

> 也可改用环境变量 `LANHU_COOKIE` 直填 cookie 串；或跑登录脚本自动续期（见下）。

**小白登录（双击即用，推荐）**：Windows 下双击 `lanhu-login.bat`，自动装依赖 → 弹浏览器 → 你登录 → 回终端按 Enter，cookie 自动写入 `.mcp-local/lanhu.cookie`。

**命令行登录**：

```bash
npm i playwright              # 仅 lanhu-login.mjs 需要
npx playwright install chromium
node lanhu-login.mjs
#   → 弹出浏览器手动登录蓝湖，回终端按 Enter，把 cookie 串写入 .mcp-local/lanhu.cookie（已 gitignore）
```

**cookie 过期后**：重新跑一次上面的 `lanhu-login.bat` 或 `node lanhu-login.mjs` 即可。AI 检测到过期时会提示你。

### 2. 配置视觉模型（analyze / 验收需要）

配置 `VLM_API_KEY`（视觉模型 Key），可选 `VLM_MODEL`。

配好后 `lanhu_fetch_design` 会**默认带上视觉理解**（`analyze` 自动为 `true`）；想省掉这次视觉调用传 `analyze:false`，或设 `LANHU_AUTO_ANALYZE=0` 全局关闭。

### 3. 接入 Agent（项目根 `.mcp.json`）

**npm 包（推荐，免 clone 免构建）**：

```json
{
  "mcpServers": {
    "lanhu-design-mcp": {
      "command": "npx",
      "args": ["-y", "lanhu-design-mcp"],
      "env": {
        "VLM_API_KEY": "your-api-key",
        "VLM_BASE_URL": "https://api.openai.com/v1",
        "LANHU_COOKIE_FILE": "./.mcp-local/lanhu.cookie"
      }
    }
  }
}
```

**源码方式**（参与开发时用）：

```json
{
  "mcpServers": {
    "lanhu-design-mcp": {
      "command": "node",
      "args": ["/绝对路径/mcp-design-toolbox/lanhu-design-mcp/dist/index.js"],
      "env": {
        "VLM_API_KEY": "your-api-key",
        "LANHU_COOKIE_FILE": "./.mcp-local/lanhu.cookie"
      }
    }
  }
}
```

`LANHU_COOKIE_FILE` 指向本地 cookie 文件（内容为完整 cookie 串，已 gitignore）；
`VLM_API_KEY` 也可从 shell 环境变量展开。两者都不入库。

## 工具一览

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `lanhu_check_auth` | 探活 cookie 是否有效（401 二次确认） | `cookie` |
| `lanhu_fetch_design` | 读单个设计稿图层树（+视觉理解，配置了视觉模型时默认开） | `url` 或 `imageId+projectId` / `mode`(api/mock) / `analyze?` / `analyzeFocus?`(关注点注入) / `cookie` |
| `lanhu_list_teams` | 列出账号加入的全部团队（多团队发现入口） | `cookie` |
| `lanhu_list_directory` | 一次拉团队目录（项目→分组）。约 1.6k tokens | `url?`(提 tid) / `teamId?` / `cookie` |
| `lanhu_read_sector` | 按分组名列出稿目录（稿名/尺寸/层数，不含图层树——全量会撑爆上下文） | `url`(链接/UUID) / `sector` / `cookie` |
| `lanhu_download_slices` | 下载切图到本地目录（单稿或分组批量，三层去重，并发下载）。倍率与格式由蓝湖 OSS 在线处理（`scale` 可选 1x/2x/3x/original，`format` 可选 png/webp），下载字节原样落盘、本地零二次处理。host 白名单 + 重定向逐跳校验 + 字节级验真（HTML 伪装/格式/实际像素），验真不过不落盘。`withScaleUrls` 可附带全平台倍率 URL | `url` / `outputPath` / `sector?` / `sliceNames?` / `skipExisting?` / `scale?` / `format?` / `withScaleUrls?` |
| `lanhu_verify_spec` | **设计稿验收**：图层树期望值 ↔ 页面计算样式，逐字段 diff 出偏差清单 | `designUrl` / `pageUrl` / `waitFor?` / `maxDiffs?` |
| `lanhu_verify_render` | 渲染页 vs 设计稿 语义对比（主观线索，不作验收结论；不传 designImagePath 时退化为单图一致性检查） | `actualImagePath` / `designImagePath?` / `context?`(已知刻意差异，跳过不报)；base64 兜底 |
| `vision_defect_check` | 整页/局部 UI 缺陷检测（12 类缺陷枚举） | `imagePath` / `context?` / `language?`；base64 兜底 |
| `vision_e2e_triage` | E2E 失败截图+DOM 归因（期望-实际差异分析） | `expectedBehavior?`(强烈建议传) / `testSteps?` / `screenshotPath` / `domSnapshot?` / `errorText?` |

## 使用示例

> 示例中的 `cookie` 参数均可省略——省略时走环境变量 `LANHU_COOKIE` 或 `LANHU_COOKIE_FILE` 指定的文件。

### cookie 过期怎么办（AI 判断流程）

任何蓝湖工具报 `HTTP 401` 或返回异常空数据时，AI 会先调 `lanhu_check_auth` 探活来区分原因：

```
lanhu_check_auth({})
```

- 返回 `{ ok:true, teamCount, teams }` → cookie 仍有效，刚才的 401 是**无权访问该资源**（稿没对你分享）。重新登录无效，需联系设计者开权限。
- 返回 `{ ok:false, reason:"cookie_expired", hint:"..." }` → cookie 确实过期。提示用户运行**`lanhu-login.bat`**或 `npm run login` 续期。
- `reason:"http_xxx"` → 蓝湖其它 HTTP 错误，稍后重试或检查网络。
- `reason:"network_error"` → 网络不通。

> 401 不一定是 cookie 过期：全局接口 401 多半是 cookie 问题；单个稿 401 而 `check_auth` 通过，则是权限问题。`check_auth` 让 AI 不再一刀切误报过期。

### 读单个设计稿

```
lanhu_fetch_design({
  mode: "api",                 // 默认，官方 Cookie 接口
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy"
})
```

返回 `{ name, viewport, layers(精确坐标/色值/字号/文本), meta }`。
layers 已清洗：过滤无样式纯容器层（实测省 20-30% 体积），每层带 `parentPath`（有语义的父容器名链）保分组语义；`meta.payloadBytes/droppedLayerCount` 报告数据体积与过滤量。
二次清洗（面向输出形态）：alpha=1 颜色缩写为 hex；自动生成名（矩形/编组N/Rectangle 9943…）不输出（切图层豁免——名字是下载句柄）；空壳层剔除（仅透明度/仅圆角、无填充描边的层不渲染任何东西）；完全在画布外的层、逐字段一致的堆叠副本、同几何的重复切图标记（编组+子层各标一次，保留 type=image 的）剔除；被上方不透明纯色矩形完整遮挡的层剔除；可见面积占比过低（默认 <25%，只露出窄条）的矩形剔除；碎片装饰带剔除（同一容器内一排首尾相接的微小矢量段——高≤8/宽≤24/成带/宽度参差，等宽等距的分段与孤立小点保留）；「备份/backup」命名的备用层整棵子树剔除；布尔运算节点（Subtract/Union 等）的操作数子层折叠（操作数从不独立渲染，只留带真实填充的布尔节点）。各规则计数见 `meta.droppedLayerCount / dedupedLayerCount / outsideCanvasLayerCount / occludedLayerCount / sliverLayerCount / fragmentLayerCount / backupLayerCount / booleanOperandLayerCount`。切图 CDN URL 不随稿返回（按名下载走 `lanhu_download_slices` 的 `sliceNames`）。返回体为紧凑 JSON。

### 读 + 视觉理解设计稿（双重验证）

```
lanhu_fetch_design({
  mode: "api",
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy",
  analyze: true                 // 下载封面图 → 喂给视觉模型 → 返回 visionAnalysis 文字描述
})
```

**`analyze` 默认自动开启**：已配置视觉模型（模型名 + `VLM_API_KEY`）时，不传 `analyze` 也等价于 `analyze: true`；
未配置视觉能力时默认 `false`。显式传 `true`/`false` 始终优先于自动判断。
想保留图层树、跳过视觉调用，显式传 `analyze: false`，或设 `LANHU_AUTO_ANALYZE=0` 全局关闭自动分析。
`analyzeFocus` 可注入调用方关注点/业务背景（如「重点分析签到奖励领取规则」），视觉模型会将其融入分析但不改变 JSON 结构——同一张稿、不同关注点会得到不同侧重的分析结果。

`analyze` 会返回 `visionAnalysis`（纯语义理解：page_type/版面区块/组件清单(position 用档位词+区块名)/视觉叠放层级/imagery(每张背景图的内容+与文字的关系+真伪占位)/氛围/动效暗示；精确数值一律不输出，由 layers 提供），**封面图 base64 不进上下文**，
只在 server 内部喂给视觉模型——且喂前已压到 **1x JPEG**（4x 封面 1.6MB → 约 100KB 内）。
视觉分析失败（模型超时/鉴权失败/无封面图）不再让整次读稿失败，而是原样返回图层树并附 `visionError` 字段说明原因。
`lanhu_verify_render` / `vision_defect_check` / `vision_e2e_triage` 的入参截图也会在 server 端统一压到最长边 1568 再发模型。
结合图层树的精确数值做双重验证。

### 设计稿验收（lanhu_verify_spec）

替代人工走查的主手段：**不靠模型看图，靠数值比对**。

```
lanhu_verify_spec({
  designUrl: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy",
  pageUrl: "http://localhost:5173/task-center",
  waitFor: ".task-list"        // 等接口数据渲染完再采，可选
})
```

流程：设计稿图层树取**期望值** → Playwright 打开页面采 `getComputedStyle` 取**实际值** → 逐字段 diff → 输出偏差清单。
比对字段：`x / y / width / height`（容差 1px）、`color / fill`（通道差 ≤2 且 alpha 差 ≤0.02）、`fontSize`（容差 0.5）、`fontWeight`、`lineHeight`（容差 1px）、`text`。
偏差按 `minor / major / critical` 分级，带 `delta`。

**H5 webview 验收口径**（内嵌 Android/iOS webview 的移动端项目）：
- **宽度严格、高度宽松**：`x` / 非文本层 `width` 严比对；`y` / `height` 因状态栏占位与内容动态渲染，整体偏移属预期，差异一律降 `minor`。
- **状态栏不渲染**：设计稿顶部状态栏层（命名或顶部整条几何特征）比对前剔除；页面整体竖直偏移 `dy` 回 `offset` 字段并标注为预期，不报缺陷。
- **文案语义接近即可**：文本差异默认降 `minor`（warning）；配了视觉模型时批量做语义等价判定，仅当确为不同含义才升 `major`。
- **前置去噪**：`opacity=0`、零尺寸、蒙版/标注/备份组(`*备份`)/占位/切图导出件等无效图层比对前剔除，不污染匹配与未匹配统计。
- **_fill 在父级背景实现_**：页面叶子节点背景透明时向上回退 3 级祖先背景色；命中即跳过；叶子全透明仍未命中则封顶 `major`，不刷 critical。

**元素匹配打分**：文案精确相等 > 纯几何 IoU ≥0.5。
统一候选池 + **全局贪心**分配，不按图层顺序逐个挑——顺序贪心在重复 key 下会先到先得、整队错位。
不依赖任何 DOM 标注属性，开发无需在页面写 `data-design`；密集/重叠区域的归属歧义由「样式清单比对」安全网兜底（见下）。

**整体偏移估算**（页面与设计稿常差一个状态栏高度，不校正会让所有 IoU 归零）：
用**真实位置匹配对**（IoU≥0.5，与文案/语言无关）RANSAC 反推整体偏移 → 再用校正后的偏移重跑几何轮补齐漏配。
不依赖文案锚点，故设计稿与页面语言不同（简/繁/英）也能估准（实测 EN/ZH 均收敛到 dx≈0, dy≈-35）。

**样式清单比对（永远在线的安全网，无需任何标注）**：
不做元素配对，只比「设计稿文字样式集合」vs「页面文字样式集合」，元组 = `fontSize / 字重 / 色值`。
它**不比文案**，因此跨语言、跨迭代文案差异都不会让它失盲——是逐元素配对的主信号兜底，也是开发无需在页面写标注属性的前提下仍能发现样式漂移的抓手。
结果落在返回的 `inventory` 字段：`missingOnPage`（设计稿有、页面无 → 元素缺失/样式被覆盖）与
`notInDesign`（页面有、设计稿无 → 样式漂移/硬编码），每项附示例图层名/选择器便于定位。
> 实测（任务中心稿，零标注）：`inventory` 以 7 类差异定位到真缺陷集群——任务名 `<p>` 被 `:last-child` 误伤（`10px/700` 共 16 处）、
> Go/Claim 按钮字号漂移（`14px→12px` 共 7 处）；而配对模式同条件下输出 55 条偏差，信噪比显著提升。

> 注意：**纯几何匹配对同尺寸重叠的大矩形区分力弱**（如白色卡片矩形易误配到相邻橙色进度条）。
> 这类归属歧义不靠 DOM 标注解决，而是交给「样式清单比对」安全网按样式集合兜底——它不做几何匹配，天然不受大矩形误配影响。

> 真实项目实测（任务中心线上稿 375×1078 / 339 层 vs 本地 dev 页面）：
> 去噪+宽松化后 EN 偏差 50 条（critical 6）、ZH 26 条（critical 3）；抓到 1 类真缺陷并定位根因——
> 任务名 `<p>` 被 `p:last-child` 降级规则误伤（期望 14px/700/#232129，实际 10px/400/#262529，7 个任务项全中）。
> 前提是设计稿与页面**同语言、同迭代**；跨语言/跨迭代时文本对不上，偏差里大部分是噪音（已降级为 warning）。

当前为最小可用版本：只跑默认态、按设计稿 viewport 单一视口、不评分。

### 列账号所属团队（多团队发现）

```
lanhu_list_teams({})
```

返回 `{ teamCount, teams: [{ teamId, name, role, isOwner, memberNum }] }`。
多团队时先列团队，拿 `teamId` 传给 `lanhu_list_directory`；省略敏感字段（phone/company/tax_id_no 等）。

### 列项目分组（团队目录定位）

团队定位优先级：`url`（提 tid，最准）> `teamId`（来自 list_teams）。两者都没有则报错。

```
// 有蓝湖链接——直接传 url，从 tid 定位团队（最准，推荐）
lanhu_list_directory({
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy&tid=zzz"
})

// 没链接——先 lanhu_list_teams 拿 teamId
lanhu_list_directory({
  teamId: "21e6d63c-..."
})
```

返回 `{ teamId, projectCount, sectorCount, directory: [{ project, projectId, sectors: [{ name, designCount }] }] }`。

### 按分组看稿目录（完成某个需求）

```
lanhu_read_sector({
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy",
  sector: "会员体系"            // 分组名，从 lanhu_list_directory 看到
})
```

返回 `{ sector, designCount, designs: [{ image_id, name, viewport, layerCount }] }`——只含稿目录（稿名/尺寸/层数），**不含图层树**。全量 layers 实测 26 稿约 395KB，会撑爆 Agent 上下文，故故意不返回；按稿名挑出要实现的目标后，用 `lanhu_fetch_design` 逐张读图层树。

### 不知道蓝湖链接，按活动名找分组（一页目录）

当你说"帮我看看节日活动页有几个设计稿"时，AI 无需你给链接，一次拉全团队目录直接定位：

```
// 需先 lanhu_list_teams 拿 teamId（或传任意该团队蓝湖链接的 url）
lanhu_list_directory({ teamId: "21e6d63c-..." })
```

返回一张完整目录（约 1.6k tokens，并行拉取约 2 秒）：

```js
{
  teamId, projectCount: 8, sectorCount: 163,
  directory: [
    { project: "示例项目 H5/Web",
      projectId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
      sectors: [
        { name: "会员体系", designCount: 18 },
        { name: "节日活动页", designCount: 5 },
        // ...
      ] },
    // ...更多项目
  ]
}
```

AI 在这份目录里按分组名匹配"节日活动页" → 拿到所在项目的 `projectId` →
传给 `lanhu_read_sector({ url: projectId, sector: "节日活动页" })` 读稿。
没匹配上则如实回答未找到，或问用户补充。

> `lanhu_read_sector` 的 `url` 参数同时接受**蓝湖链接**和**项目 UUID**（来自 `lanhu_list_directory` 的 `projectId`）。
> `lanhu_list_directory` 的 `team_id` 两级定位：`url` 入参提取的 tid > `teamId` 入参。两者都没有则报错（实测 `tenantId=0` 返回空目录而非默认团队，不能兜底）。有链接传 `url` 最准；没链接用 `lanhu_list_teams` 拿 `teamId`。
> 只到分组层（含 designCount），不展开设计稿名——保持轻量；稿名在读 sector 时才按需拉。

### 下载切图到本地项目（开发引用素材）

实现某个设计稿时，把稿里标记导出的切图（icon/图/头像框等）拉到本地 assets。两种范围、三层去重：

**单稿下载**：

```
lanhu_download_slices({
  url: "https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy",
  outputPath: "src/assets/masked-ball/"
})
```

**分组批量下载**（跨稿去重，公共 icon 只下一次）：

```
lanhu_download_slices({
  url: "b54e3d95-...",                      // 项目 UUID 或该分组任一稿链接
  sector: "会员体系",                         // 分组名（从 lanhu_list_directory 看到）
  outputPath: "src/assets/membership/"
})
```
拉该分组所有稿的切图合并去重。实测 20 稿 194 切图 → URL 去重后 133 张，省 61 张重复。

**只下指定切图**（sliceNames 过滤）：

```
lanhu_download_slices({
  url: "...",
  outputPath: "...",
  sliceNames: ["关闭icon", "返回btn"]        // 只下这几个名字的切图
})
```

返回：
```js
{
  scope: "会员体系",        // 单稿=稿名，分组=分组名
  outputDir: "/abs/.../src/assets/membership",
  downloaded: 133,          // 实际下载张数
  skipped: { dup: 61, exist: 0 },  // URL 去重跳过 / 本地已存在跳过
  failed: [],               // 下载失败明细（不再静默跳过）
  slices: [{ name, file, bytes, w, h }]  // 全部已落盘+已存在的切片
}
```

三层去重（默认全开，可独立开关）：
1. **URL 去重** —— 蓝湖切图 URL 按图内容 hash 命名，同 URL = 同图，只下一次（解决跨稿+稿内重复）
2. **skipExisting** —— 本地已存在同名文件就跳过（`skipExisting:false` 可强制重下；默认 true）
3. **sliceNames** —— 只下指定名字的切图（同名不同 URL 都下，因为它们是不同的图）

文件名为「图层名 + 短 hash + 扩展名」（清洗非法字符 `/ \ : * ? " < > |`、防重名），AI 拿到 `file` 路径即可在代码里引用。切图来自蓝湖公开 CDN，无需 cookie 即可下载。

> **关于倍率/平台**：蓝湖客户端可按 `@2x/@3x` 或安卓 `mipmap-xxxhdpi` 选倍率，但官方 API 返回的切图 URL 是单一默认值（安卓端最高分辨率 xxxhdpi/4x）。本工具**下载时自动压缩到 2x**（按设计尺寸 ×2 resize + PNG 调色板压缩，实测 138KB → 24KB），H5 用 CSS 控制显示尺寸。返回的 `slices[].w/h` 仍是设计坐标，落盘像素 = w×2 / h×2。

**存量 4x 图批量压缩**（对之前下载的旧目录）：

```bash
node scripts/compress-images.mjs src/assets/xxx/ [--factor 0.5] [--dry-run]
```

⚠️ 2x 目录不要重复跑（会变 1x）。`lanhu_download_slices` 下载即压，无需再跑脚本。

### 验收（做完页面后）

```
vision_defect_check({ imagePath: "渲染页截图.png", language: "zh-CN" })
lanhu_verify_render({ actualImagePath: "渲染页.png", designImagePath: "设计稿.png" })
vision_e2e_triage({ screenshotPath: "失败截图.png", domSnapshot: "<DOM>", errorText: "<报错>" })
```

## 抽取后端（mode）

| mode | 说明 | 依赖 |
|---|---|---|
| `api`（默认） | 蓝湖官方 Cookie 接口：`GET /api/project/image` → `json_url` 图层树 + `detail.url` 封面图 | 仅 Cookie |
| `mock` | 内置示例图层树 | 无 |

官方 `api` 模式直调蓝湖数据接口拿 `detail.url` 封面图（完整设计稿截图）+ 标注 JSON，
不走前端渲染画布，稳、快、准。已移除 `scrape`（playwright 爬取）模式——蓝湖前端鉴权 + 阿里云风控
让浏览器拦截路径不可靠，官方 API 才是正路。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `VLM_API_KEY` | analyze/验收时必填 | — | 视觉模型 Key |
| `VLM_BASE_URL` | 否 | `https://api.deepseek.com` | 视觉模型端点（验证时可指向 mock） |
| `VLM_MODEL` | 否 | `deepseek-v4-flash-vision-exp` | 视觉模型名 |
| `LANHU_AUTO_ANALYZE` | 否 | — | 设为 `0` 关闭 `lanhu_fetch_design` 的自动视觉分析（配置齐全时也默认不开） |
| `LANHU_VISION_MAX_TOKENS` | 否 | `4096` | 输出上限。JSON Output 模式下不设会被截断 |
| `LANHU_VISION_MAX_EDGE` | 否 | `1568` | 入参图压缩的最长边。DeepSeek 进模型前统一缩到约 800×800 等效像素、每张封顶 384 token，设 `1024` 可省流量 |
| `LANHU_VISION_CACHE` | 否 | `1` | 设 `0` 关闭视觉结果缓存（`LANHU_VISION_CACHE_DIR` 可改缓存目录） |
| `LANHU_VISION_TIMEOUT_MS` | 否 | `120000` | 单次视觉模型请求超时（毫秒） |
| `VISION_USE_V1` | 否 | — | 设为 `0` 时端点用文档原生的 `/chat/completions`，默认 `/v1/chat/completions` |
| `LANHU_SLICE_CONCURRENCY` | 否 | `6` | 切图下载并发数（分组批量下载时生效） |
| `LANHU_ALLOWED_ASSET_HOSTS` | 否 | — | 切图资源主机白名单的追加项（逗号分隔）。默认只放行 `lanhuapp.com`/`*.lanhuapp.com` 与 `aliyuncs.com`/`*.aliyuncs.com`，白名单外主机一律拒绝下载 |
| `LANHU_MIN_VISIBLE_FRACTION` | 否 | `0.25` | 出画窄条剔除阈值：可见面积占比低于它的矩形被剔除，设 `0` 关闭该规则 |
| `LANHU_PRUNE_FRAGMENTS` | 否 | `1` | 设 `0` 关闭碎片装饰带剔除（同容器一排首尾相接的微小矢量段） |
| `LANHU_COOKIE` | 官方 api 模式必填（与 `LANHU_COOKIE_FILE` 二选一） | — | 蓝湖登录 Cookie 串（F12 复制） |
| `LANHU_COOKIE_FILE` | 同上 | — | cookie 文件路径（内容为完整 cookie 串，已 gitignore）；`lanhu-login.bat` 续期时自动写入此文件 |
| `LANHU_MOCK` | 否 | — | 设为 `1` 时 fetch_design 返回内置示例（无需联网） |

> cookie 解析优先级：**工具入参 `cookie` > 环境变量 `LANHU_COOKIE` > 文件 `LANHU_COOKIE_FILE`**。
> ⚠️ 注意：若曾设置过 `LANHU_COOKIE` 环境变量，它会**压制文件内容**——用 `lanhu-login.bat` 续期后新 cookie 写入了文件，但旧环境变量仍在生效，请求会持续 401。此时需删除/更新该环境变量，或清掉它改用文件方式。

## DeepSeek 视觉接入规范（已对齐）

按 [图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision) 与 [JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode) 文档实现：

| 规范要求 | 实现 |
|---|---|
| 模型名 `deepseek-v4-flash-vision-exp`（唯一支持图片的实验模型） | 默认模型名；其它模型传图会 400 |
| 图片只能出现在 `user` 消息 | 只发 `user` 消息，`image_url` 块、`detail` 放在 `image_url` 对象内 |
| 单图 ≤ 32 MiB、请求体 ≤ 48 MiB | 发请求前按 base64 长度预估拦截，超限直接报可读错误（不浪费一次调用） |
| JSON Output 要求 prompt 含小写 `json` 字样 + 给出 JSON 样例 | `callVision` 自动校验并补齐；四个工具的 prompt 都自带 JSON 结构样例 |
| JSON Output 必须设 `max_tokens` 防截断 | 默认 4096，`LANHU_VISION_MAX_TOKENS` 可调 |
| JSON Output 有概率返回空 content（官方已知问题） | 最多 3 次尝试 + 退避重试 |
| 图片进模型前被缩到约 800×800 等效像素、每张封顶 384 token | 送图前先压到 `LANHU_VISION_MAX_EDGE`（默认 1568，DeepSeek 场景建议 1024） |

两个自适应降级（避免实验性模型/代理差异直接把调用打死）：

- HTTP 404 → 自动在 `/v1/chat/completions` 与 `/chat/completions` 之间切换一次；
- HTTP 400 且错误指向 `response_format` → 剥掉 JSON Output，退回纯提示词约束再解析。

> ⚠️ 401 `Authentication Fails`：说明 `VLM_API_KEY` 不是 **DeepSeek 平台**的 key（其它厂商的 `sk-` key 打不通 api.deepseek.com）。去 <https://platform.deepseek.com/api_keys> 申请后替换。

## 开发 / 类型检查

```bash
npm run typecheck   # tsc --noEmit，类型检查
npm run dev         # tsx 直接跑 src/index.ts（开发模式，无需先 build）
npm run build       # tsc 编译到 dist/
```

## 三种部署 / 分发方式

### 方式 A：拷贝即用（最简单，推荐给同事）
把整个 `lanhu-design-mcp/` 目录发给对方，对方 `npm install && npm run build` 后，
用绝对或相对路径指到 `dist/index.js` 即可。

### 方式 B：npm 全局安装 / npx
```bash
npm i -g lanhu-design-mcp     # 发布后；或本地：npm link
lanhu-design-mcp              # 等价于 node dist/index.js
# 或一次性：npx -p lanhu-design-mcp lanhu-design-mcp
```

### 方式 C：Docker（团队统一运行时，可选）
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install && npm run build
CMD ["node", "dist/index.js"]
```
构建：`docker build -t lanhu-design-mcp .`，运行时通过 `-e VLM_API_KEY=...` 注入密钥。

## 接入各 coding Agent

所有 Agent 都接受同一份 MCP 配置。把上面「快速开始」的 `.mcp.json` 内容写进项目根
（Claude Code / Cursor / Trae / opencode 通用；Cursor 用 `.cursor/mcp.json`，opencode 用
`.opencode/mcp.json`，字段一致）。

- **Claude Code**：`~/.claude.json` 或项目 `.mcp.json`；可用 `settings.json` 的
  `PostToolUse` Hook 做到"改完 `.vue` 自动截屏 → `vision_defect_check` 验收"。
- **opencode**：`.opencode/mcp.json` + `hooks` 同样支持自动验收闭环。
- **Cursor**：`.cursor/mcp.json`；无原生 Hook，靠 `Rules`（`.cursor/rules`）让 Agent
  主动调工具，验收门禁放 CI 更稳。
- **Trae**：`.trae/mcp.json`；无原生 Hook，靠 `AGENTS`/规则 + SOLO 模式驱动。

## 给 Agent 的提示词骨架（建议写进 CLAUDE.md / AGENTS.md）

```
你可用 lanhu-vision MCP：
0. 多团队先 `lanhu_list_teams` 列出账号加入的全部团队，拿 `teamId`；单团队可跳过直接进 1。
1. 不知道蓝湖链接时，lanhu_list_directory 一次拉全团队目录（项目→分组），
   在里面按分组名匹配用户说的活动 → 拿到 projectId 传给 lanhu_read_sector。
   没匹配则如实回答未找到或问用户。无需让用户补链接，无需自己下钻。
2. 有链接或项目 UUID 时，lanhu_read_sector({url: 链接或UUID, sector: 分组名}) 看该分组的稿目录（稿名/尺寸/层数，不含图层树），按稿名挑出要实现的目标。
3. 实现单个 UI 前用 lanhu_fetch_design 逐张读目标稿的结构化图层树（一次只读当前要实现的那 1 张，不要批量读；色值/字号从数据取，不要靠截图 OCR 小字）；
   配了视觉模型时会自带 visionAnalysis（版面/组件的文字理解），想省掉这次视觉调用就传 analyze:false。
4. 需要切图素材时 lanhu_download_slices 下载到项目 assets 目录，代码里引用返回的 file 路径。
5. 实现后把渲染页截图传给 lanhu_verify_render 做对比，或 vision_defect_check 做缺陷检测。
6. E2E 失败时把截图+DOM 传给 vision_e2e_triage 拿根因。
7. 任何蓝湖工具报 HTTP 401 或返回异常空数据时，先调 lanhu_check_auth 探活：
   - ok:true → cookie 有效，是那个资源无权访问，提示用户联系设计者开权限（不要让用户重新登录）。
   - ok:false(reason=cookie_expired) → 真过期，提示用户双击 `lanhu-login.bat` 或跑 npm run login 续期，完成后重试。
   - ok:false(reason=network_error) → 网络问题，稍后重试。
   不要在没探活前就断定 cookie 过期——单资源 401 多半是权限问题，重新登录无效。
视觉模型的结论只当线索，涉及钱/权限/用户数据的流程必须人审。
```

## 红线（务必遵守）

- `-exp` 模型契约不稳定：`VLM_MODEL` 走环境变量，保留像素 diff / axe 兜底。
- **蓝湖小字（色值、字号、间距）只从 `lanhu_fetch_design` 结构化数据取，绝不靠视觉模型 OCR 截图**——
  这是该视觉模型已知短板（图片压缩后 10px 数字/密集文本必读错）。
- 视觉模型判断只当线索；**钱 / 权限 / 用户数据相关流程必须人审或留 fallback**。
