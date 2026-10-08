import { spawn } from 'node:child_process';
import { config, describeMissingConfig } from './config.js';
import { logger } from './logger.js';
import { closeDb } from './db/index.js';
import { buildServer } from './http/server.js';
import { startScheduler, enqueue } from './scheduler/jobs.js';
import { browser } from './xhs/browser.js';

const isMain = process.argv[1]?.includes('index') || process.env.XHSFLOW_FORCE_START === '1';

async function main(): Promise<void> {
  logger.info('xhsflow 启动中…');

  const missing = describeMissingConfig();
  for (const m of missing) logger.warn(m);
  if (missing.length === 0) logger.info('配置检查通过');

  const app = await buildServer();
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      logger.error(
        { port: config.port },
        `端口 ${config.port} 已被占用。多半是上一个 xhsflow 还没退干净 —— 先关掉它，或改 .env 里的 XHSFLOW_PORT。`,
      );
      process.exit(1);
    }
    throw err;
  }

  const url = `http://${config.host}:${config.port}`;
  logger.info({ url }, `操作台已就绪 → ${url}`);

  startScheduler();

  // 启动时**不**主动拉浏览器：桌面弹窗是很打扰的，而且登录态本来就在
  // profile 里，用户点到「扫码登录」或「抓取」时自然会启动。
  logger.info('浏览器按需启动 —— 点「扫码登录」或发起抓取时才打开');

  if (config.openBrowser && isMain) openBrowser(url);

  /* ---------------- 优雅退出 ---------------- */

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, '正在关闭…');
    const timer = setTimeout(() => process.exit(1), 8000).unref();
    try {
      await browser.close();
      closeDb();
      await app.close();
    } catch {
      /* 尽力而为 */
    }
    clearTimeout(timer);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, '未处理的 Promise 拒绝');
  });
}

/** Windows 用 start，macOS/Linux 用 open。 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => logger.warn({ err }, '自动打开浏览器失败，请手动访问 ' + url));
    child.unref();
  } catch (err) {
    logger.warn({ err }, '自动打开浏览器失败，请手动访问 ' + url);
  }
}

main().catch((err) => {
  logger.error({ err }, '启动失败');
  process.exit(1);
});