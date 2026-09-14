#!/usr/bin/env node
// index.ts — lanhu-design-mcp 入口（官方 SDK + stdio 传输）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

async function main(): Promise<void> {
  // 未捕获异常兜底：MCP SDK 默认不处理，任一工具异步逃逸会让进程猝死且无日志
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.stack ?? err.message);
    process.exit(1);
  });

  const server = new McpServer({
    name: 'lanhu-design-mcp',
    version: '2.0.0',
  }, {
    // server 级工作流说明：宿主会注入 Agent 系统上下文（README 里的提示词骨架住在这里，
    // Agent 不看 README，只有这里的内容它能稳定看到）
    instructions: [
      '蓝湖设计稿读取与验收工作流：',
      '1. 找稿（无链接时）：lanhu_list_teams 拿 teamId（多团队）→ lanhu_list_directory 按分组名定位 projectId → lanhu_read_sector 列分组内稿目录（稿名/尺寸/层数）→ 按稿名挑出目标。',
      '2. 读稿：lanhu_fetch_design 一次只读当前要实现的那 1 张；analyze 默认会调视觉模型理解语义，只要坐标数值时传 analyze:false；色值/字号等精确数值一律取自 layers 字段，禁止靠截图 OCR。',
      '3. 素材：lanhu_download_slices 下载切图（sliceNames 按名过滤），代码引用返回的 file 路径。',
      '4. 验收：lanhu_verify_spec 数值比对为主（客观可回归）；lanhu_verify_render / vision_defect_check 传截图的 imagePath 文件路径做视觉辅助。',
      '5. 报 401 或空数据时先 lanhu_check_auth：ok:true = 该资源无权限（找设计者开权限，重新登录无效）；cookie_expired = 真过期（跑 lanhu-login.bat 或 npm run login 续期后重试）。',
    ].join('\n'),
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 优雅关闭：收到宿主信号时释放 server/transport，避免上层报"管道断开"
  const shutdown = async (signal: string) => {
    console.error(`收到 ${signal}，正在关闭 lanhu-design-mcp…`);
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  console.error('lanhu-design-mcp 已启动，等待连接…');
}

main().catch((err) => {
  console.error('启动失败:', err?.message || err);
  process.exit(1);
});
