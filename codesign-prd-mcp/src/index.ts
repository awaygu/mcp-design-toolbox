#!/usr/bin/env node
/**
 * CoDesign PRD MCP Server
 *
 * 读取腾讯 CoDesign 产品原型（Axure），分段截图 + VLM 解析，
 * 生成纯文本结构化需求文档，供 AI Coding Agent 使用。
 *
 * MCP 工具：
 *   - get_prototype_outline   获取原型页面大纲
 *   - get_page_content        获取单个页面结构化内容
 *   - get_requirement_doc     获取指定分组的完整需求文档（核心）
 *   - analyze_flowchart       单独分析流程图截图
 *   - cache_stats             查看 VLM 解析缓存占用
 *   - clear_cache             清空 VLM 解析缓存
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import { openShareLink, getPageOutline, getSinglePage, getGroupPages } from './crawler.js';
import {
  isVLMConfigured,
  analyzeSingleImage,
  flowchartToMermaid,
} from './vlm.js';
import { processPage, processPages } from './pipeline.js';
import { generateRequirementDoc, generateSinglePageDoc } from './doc-generator.js';
import { clearCache, cacheStats, cacheDir } from './cache.js';
import { closeBrowser, getPage } from './browser.js';
import { errorMessage, formatBytes, packageVersion, createProgressNotifier, withHeartbeat } from './utils.js';
import type { PageType } from './types.js';

/** 访问凭据（分享链接 + 访问密码） */
interface Access {
  url: string;
  password?: string;
}

/**
 * 记录浏览器当前所处的链接。不能用「曾经打开过」的集合，
 * 否则 A→B→A 的调用顺序会错误地跳过第二次 A 的导航，导致在 B 的页面上解析 A 的内容。
 */
let currentUrl: string | null = null;
let currentPassword: string | null = null;

/**
 * url/password 支持环境变量默认值：MCP 配置里设置一次 CODESIGN_URL / CODESIGN_PASSWORD，
 * Agent 后续调用只需传业务参数（如 groupName），不必每次重复带凭据。
 */
function resolveAccess(url?: string, password?: string): Access {
  const resolvedUrl = url || process.env.CODESIGN_URL || '';
  if (!resolvedUrl) {
    throw new Error('缺少 url 参数，且未设置环境变量 CODESIGN_URL');
  }
  return { url: resolvedUrl, password: password || process.env.CODESIGN_PASSWORD || undefined };
}

async function ensureOpened(url: string, password?: string): Promise<void> {
  const nextPassword = password ?? null;
  // 浏览器崩溃/被关闭后必须重新导航，否则同 URL 会永久跳过 openShareLink 卡死
  const page = getPage();
  const browserAlive =
    !!page?.context()?.browser()?.isConnected() && !page?.isClosed();
  if (currentUrl === url && currentPassword === nextPassword && browserAlive) return;

  // 先置空：openShareLink 失败时不会残留错误状态，下次调用必然重新导航
  currentUrl = null;
  currentPassword = null;
  await openShareLink(url, password);
  currentUrl = url;
  currentPassword = nextPassword;
}

/**
 * 串行化所有浏览器操作。浏览器 page 是进程内单例，
 * 并发调用会让导航互相打断，最终读到别的页面的内容。
 */
let lockChain: Promise<unknown> = Promise.resolve();

function withBrowserLock<T>(task: () => Promise<T>): Promise<T> {
  const result = lockChain.then(task, task);
  lockChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** 统一的工具返回体构造，避免每处手写 content 数组 */
function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const server = new McpServer(
  {
    name: 'codesign-prd-mcp',
    version: packageVersion(import.meta.url, '0.2.0'),
  },
  {
    // server 级工作流说明：宿主会注入 Agent 系统上下文（Agent 不读 README，只有这里稳定可见）
    instructions: [
      'CoDesign 原型（Axure）→ 结构化需求文档（PRD）工作流：',
      '1. get_prototype_outline 拿页面目录大纲（节点带完整路径；同名页面靠完整路径「父分组/页面名」消歧）。',
      '2. get_requirement_doc（核心）：一次取整个需求分组的完整 PRD，自动遍历页面 + 分段截图 + VLM 解析。',
      '   - 大分组会自动把文档写入 output/ 并只返回「文件路径 + 每页摘要」，按需读文件即可；要强制全文返回传 outputFile:false。',
      '   - 超时/中断后可用 pageNames 只重跑指定页：已完成的页有缓存（DOM 未变跳过截图、VLM 结果按内容缓存），重跑秒回。',
      '3. get_page_content 读取单页结构化内容（单页补充细节时用）。',
      '4. VLM 只用于 DOM 提取不到的内容：内嵌图（图内文字）始终单独定向解析；整页分段仅对 DOM 提取不到内容的页面运行（纯图片页、拓扑还原失败的流程图）。表格/规则文字/流程拓扑由 DOM 确定性提取，无需视觉模型。',
      '5. 未配置 VLM_API_KEY 时自动降级为纯 DOM 文字提取（流程图/表格解析不可用，其余正常）。',
      '6. url/password 可用环境变量 CODESIGN_URL / CODESIGN_PASSWORD 预置，调用时无需重复传。',
    ].join('\n'),
  }
);

// ─── 工具1：获取原型页面大纲 ───────────────────────────────────
server.registerTool(
  'get_prototype_outline',
  {
    description:
      '获取 CoDesign 产品原型的页面目录大纲（左侧导航树），用于了解原型结构和定位需求页面',
    inputSchema: {
      url: z.string().optional().describe('CoDesign 分享链接；不传时使用环境变量 CODESIGN_URL'),
      password: z
        .string()
        .optional()
        .describe('访问密码（4位）；不传时使用环境变量 CODESIGN_PASSWORD'),
    },
  },
  async ({ url, password }, extra) => {
    const notify = createProgressNotifier(extra);
    try {
      const text = await withBrowserLock(async () => {
        const access = resolveAccess(url, password);
        await withHeartbeat(notify, () => ensureOpened(access.url, access.password), { stage: '打开原型' });
        notify('提取页面目录…');
        const outline = await withHeartbeat(notify, () => getPageOutline(), { stage: '提取目录' });

        const lines = ['# 原型页面大纲\n'];
        outline.forEach((item) => {
          const indent = '  '.repeat(item.level);
          const icon = item.isGroup ? '📁' : '📄';
          const index = item.pageIndex !== undefined ? ` (第${item.pageIndex + 1}页)` : '';
          // 展示完整路径：同名页面靠它消歧，调用方按此传 pageName/groupName
          lines.push(`${indent}- ${icon} ${item.path}${index}`);
        });
        return lines.join('\n');
      });

      return textResult(text);
    } catch (err) {
      return errorResult(`获取大纲失败: ${errorMessage(err)}`);
    }
  }
);

// ─── 工具2：获取单个页面结构化内容 ─────────────────────────────
server.registerTool(
  'get_page_content',
  {
    description:
      '获取 CoDesign 原型中单个页面的结构化内容（VLM 解析后纯文本，含组件/交互/表格）。页面同名时传完整路径「父分组/页面名」',
    inputSchema: {
      url: z.string().optional().describe('CoDesign 分享链接；不传时使用环境变量 CODESIGN_URL'),
      password: z.string().optional().describe('访问密码；不传时使用环境变量 CODESIGN_PASSWORD'),
      pageName: z
        .string()
        .describe('页面名称（叶子名或完整路径「父分组/页面名」，同名页面须用路径区分）'),
      vlmEnabled: z.boolean().optional().describe('是否启用 VLM 解析，默认 true'),
      detailLevel: z
        .enum(['summary', 'standard', 'full'])
        .optional()
        .describe('文档详细程度：summary(精简)/standard(标准)/full(完整)，默认 standard'),
    },
  },
  async (
    { url, password, pageName, vlmEnabled = true, detailLevel = 'standard' },
    extra
  ) => {
    const notify = createProgressNotifier(extra);
    try {
      const access = resolveAccess(url, password);
      // 爬取需要独占浏览器；VLM 只依赖已落盘的截图，放在锁外避免长时间占用
      const pageData = await withBrowserLock(async () => {
        await withHeartbeat(notify, () => ensureOpened(access.url, access.password), { stage: '打开原型' });
        return await withHeartbeat(notify, () => getSinglePage(pageName, access.url), { stage: `定位页面「${pageName}」` });
      });
      notify(`页面截图完成（${pageData.segments?.length || 0} 段），开始解析…`);
      const merged = await withHeartbeat(
        notify,
        () =>
          processPage(pageData, access.url, {
            vlmEnabled,
            // 页面名作为业务背景注入 VLM prompt（仅供语义参考）
            context: `页面名称：${pageName}`,
            onProgress: (m) => notify(m),
          }),
        { stage: 'VLM 解析' }
      );

      const result = generateSinglePageDoc(merged, detailLevel);

      return textResult(result);
    } catch (err) {
      return errorResult(`获取页面内容失败: ${errorMessage(err)}`);
    }
  }
);

// ─── 工具3：获取完整需求文档（核心工具） ────────────────────────
server.registerTool(
  'get_requirement_doc',
  {
    description:
      '【核心】获取 CoDesign 原型中指定需求分组的完整结构化需求文档。自动遍历所有页面，分段截图 + VLM 解析，输出纯文本 PRD（无截图路径），AI Coding Agent 可直接使用',
    inputSchema: {
      url: z.string().optional().describe('CoDesign 分享链接；不传时使用环境变量 CODESIGN_URL'),
      password: z.string().optional().describe('访问密码；不传时使用环境变量 CODESIGN_PASSWORD'),
      groupName: z
        .string()
        .describe('需求分组名称（如 "新手引导"）；同名歧义时用完整路径。分组名不确定时可直接调用，失败会返回候选列表'),
      vlmEnabled: z.boolean().optional().describe('是否启用 VLM 解析，默认 true'),
      detailLevel: z
        .enum(['summary', 'standard', 'full'])
        .optional()
        .describe('文档详细程度：summary(精简)/standard(标准)/full(完整)，默认 standard'),
      outputFile: z
        .boolean()
        .optional()
        .describe('true 时文档写入 output/ 并返回路径+每页摘要；不传时文档超过 30KB 也自动落盘（Agent 按需读文件，避免撑爆上下文）；false 强制返回全文'),
      pageNames: z
        .array(z.string())
        .optional()
        .describe('只处理指定页面（叶子名或完整路径，来自大纲或上次返回的每页摘要）。大分组超时/中断后按页分块重跑——已完成的页有缓存，重跑秒回'),
    },
  },
  async (
    { url, password, groupName, vlmEnabled = true, detailLevel = 'standard', outputFile, pageNames },
    extra
  ) => {
    try {
      const access = resolveAccess(url, password);
      const notify = createProgressNotifier(extra);

      // 爬取阶段独占浏览器（单页顺序导航无法并行）
      const pagesData = await withBrowserLock(async () => {
        await withHeartbeat(notify, () => ensureOpened(access.url, access.password), { stage: '打开原型' });
        return await getGroupPages(groupName, access.url, {
          pageNames,
          onProgress: (m) => notify(m),
        });
      });

      // VLM 阶段不碰浏览器，放在锁外；所有页面的分段统一走一次全局并发
      const mergedPages = await withHeartbeat(
        notify,
        () =>
          processPages(pagesData, access.url, {
            vlmEnabled,
            onProgress: (m) => notify(m),
            // 需求分组/页面名作为业务背景注入 VLM prompt（仅供语义参考，见 contextHint 的防锚定声明）
            contextFor: (page) => `需求分组：${groupName}；页面：${page.pageName}`,
          }),
        { stage: 'VLM 解析' }
      );

      const doc = generateRequirementDoc({
        groupName,
        sourceUrl: access.url,
        pages: mergedPages,
        detailLevel,
      });

      // 大文档自动落盘：显式 outputFile:true 恒写文件；不传时超过 30KB 自动写；false 强制全文
      const AUTO_WRITE_BYTES = 30 * 1024;
      const docBytes = Buffer.byteLength(doc, 'utf8');
      const shouldWrite = outputFile === true || (outputFile === undefined && docBytes > AUTO_WRITE_BYTES);

      if (shouldWrite) {
        const outDir = path.join(process.cwd(), 'output');
        mkdirSync(outDir, { recursive: true });
        const filePath = path.join(outDir, `${safeGroupName(groupName)}_需求文档.md`);
        writeFileSync(filePath, doc, 'utf-8');

        // 机器可读的结构化数据（表格/流程/控件块/来源），供 Agent 直接消费或做二次处理，
        // 不必再反解 Markdown。Markdown 面向人读，JSON 面向程序读。
        const jsonPath = path.join(outDir, `${safeGroupName(groupName)}_结构化数据.json`);
        writeFileSync(
          jsonPath,
          JSON.stringify(
            {
              groupName,
              sourceUrl: access.url,
              generatedAt: new Date().toISOString(),
              pages: mergedPages.map((p) => ({
                pageName: p.pageName,
                type: p.type,
                tables: p.tables,
                blocks: p.blocks || [],
                flow: p.flow || null,
                images: p.images || [],
                vlm: p.vlmResult,
                warnings: p.warnings,
                _hasVLM: p._hasVLM,
                _segmentCount: p._segmentCount,
              })),
            },
            null,
            2
          ),
          'utf-8'
        );

        // 返回文件路径 + 每页一行的摘要，Agent 按需读取文件内容
        const lines = mergedPages.map((p) => {
          const warn = p.warnings?.length ? ` | ⚠️ ${p.warnings.join(';')}` : '';
          const extra = [
            p.tables?.length ? `${p.tables.length} 表` : '',
            p.blocks?.length ? `${p.blocks.length} 块` : '',
            p.flow ? `拓扑 ${p.flow.nodes.length}节点/${p.flow.edges.length}边` : '',
          ].filter(Boolean).join('、');
          return `- ${p.pageName}（${typeLabel(p.type)}${extra ? `，${extra}` : ''}，${p._segmentCount || 0} 段）${warn}`;
        });
        const header =
          outputFile === true
            ? []
            : [`文档 ${docBytes} 字节，超过自动落盘阈值（30KB），已写入文件；如需直接返回全文请传 outputFile:false`, ''];
        return textResult(
          [
            ...header,
            `文档已生成：${filePath}`,
            `结构化数据：${jsonPath}`,
            `共 ${mergedPages.length} 页，全文请按需读取该文件（可按章节偏移分段读取）。`,
            '',
            ...lines,
          ].join('\n')
        );
      }

      return textResult(doc);
    } catch (err) {
      return errorResult(`生成需求文档失败: ${errorMessage(err)}`);
    }
  }
);

// ─── 工具4：单独分析流程图图片 ─────────────────────────────────
server.registerTool(
  'analyze_flowchart',
  {
    description: '用 VLM 分析一张流程图截图，输出结构化的节点、连线、分支信息和 Mermaid 代码',
    inputSchema: {
      imagePath: z.string().describe('流程图图片的本地文件路径'),
    },
  },
  async ({ imagePath }, extra) => {
    const notify = createProgressNotifier(extra);
    try {
      if (!isVLMConfigured()) {
        return errorResult(
          'VLM_API_KEY 未配置，无法分析流程图。请设置环境变量后重试。'
        );
      }

      notify('提交 VLM 分析流程图…');
      const flowchart = await withHeartbeat(
        notify,
        () =>
          analyzeSingleImage(imagePath, 'flowchart', {
            segmentIndex: 1,
            totalSegments: 1,
          }),
        { stage: '流程图分析' }
      );
      const mermaid = flowchartToMermaid(flowchart);

      let result = `# 流程图分析结果\n\n`;
      result += `## 概述\n${flowchart.summary || ''}\n\n`;

      if (flowchart.nodes?.length) {
        result += `## 节点 (${flowchart.nodes.length})\n\n`;
        flowchart.nodes.forEach((n) => {
          result += `- **[${n.type}]** ${n.text} (ID: ${n.id})\n`;
        });
        result += '\n';
      }

      if (flowchart.edges?.length) {
        result += `## 连线 (${flowchart.edges.length})\n\n`;
        flowchart.edges.forEach((e) => {
          const fromText = flowchart.nodes?.find((n) => n.id === e.from)?.text || e.from;
          const toText = flowchart.nodes?.find((n) => n.id === e.to)?.text || e.to;
          result += `- ${fromText} ${e.condition ? `--[${e.condition}]-->` : '-->'} ${toText}\n`;
        });
        result += '\n';
      }

      result += `## Mermaid 代码\n\n${mermaid}\n`;
      return textResult(result);
    } catch (err) {
      return errorResult(`流程图分析失败: ${errorMessage(err)}`);
    }
  }
);

// ─── 工具5：查看缓存占用 ───────────────────────────────────────
server.registerTool(
  'cache_stats',
  {
    description: '查看 VLM 解析缓存的占用情况（条目数与体积），用于判断是否需要清理',
    inputSchema: {},
  },
  async () => {
    const stats = cacheStats();
    return textResult(
      [
        `VLM 解析缓存：${stats.total} 条，共 ${formatBytes(stats.size)}`,
        `缓存目录：${cacheDir()}`,
        '',
        '缓存键 = md5(分享链接 + 页面名 + 页面类型 + VLM 版本指纹 + 各截图内容哈希)',
        '原型内容变动或调整 Prompt / 更换模型后，旧缓存会自动失效。',
        '注意：解析失败的分段不会被写入缓存，因此失败后可直接重试。',
        '',
        '另有一级页面缓存（.codesign-mcp/pagecache）：DOM 文字未变化时直接复用截图，跳过重复截图；clear_cache 不影响它。',
      ].join('\n')
    );
  }
);

// ─── 工具6：清空缓存 ───────────────────────────────────────────
server.registerTool(
  'clear_cache',
  {
    description: '清空 VLM 解析缓存，下次调用将重新请求视觉模型。怀疑缓存内容过时时可执行',
    inputSchema: {},
  },
  async () => {
    const removed = clearCache();
    const text = removed.failed
      ? `清空缓存失败：缓存目录删除被系统拒绝，请检查是否有进程占用 ${cacheDir()} 后重试。`
      : `已清空 VLM 解析缓存：移除 ${removed.total} 条，释放 ${formatBytes(removed.size)}。\n下次调用将重新请求视觉模型。`;
    return { content: [{ type: 'text', text }], isError: !!removed.failed };
  }
);

// ─── 启动服务器 ────────────────────────────────────────────────

/** 页面类型中文名，工具输出与文档附录共用 */
function typeLabel(type: PageType): string {
  const labels: Record<PageType, string> = {
    flowchart: '流程图',
    table: '配置表',
    page: '普通页面',
    image: '内嵌图',
  };
  return labels[type] || type;
}

/** 分组名转安全文件名（保留中英文、数字、下划线、短横线） */
function safeGroupName(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await closeBrowser();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await closeBrowser();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error('MCP Server 启动失败:', err);
  process.exit(1);
});
