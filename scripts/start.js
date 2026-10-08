/**
 * 启动器。
 *
 * 存在的唯一理由：Windows 控制台默认用 GBK 代码页渲染字节，
 * 而 Node 输出的是 UTF-8，于是中文日志全变成「鍚€鍔婁槸」这种乱码。
 *
 * `chcp 65001` 必须在 Node 启动**之前**切换控制台代码页，
 * 而且 npm 在 Windows 上是通过 cmd.exe 跑脚本的，所以在 package.json 里
 * 写 `chcp 65001 && node ...` 会把这段一起暴露给 Unix shell（那边没有 chcp）。
 * 干脆用一个跨平台的 Node 包装层来判断。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, '..', 'server', 'dist', 'index.js');

if (!fs.existsSync(serverEntry)) {
  console.error(
    `\n找不到 ${serverEntry}\n请先构建：npm run build\n`,
  );
  process.exit(1);
}

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore', shell: 'cmd.exe' });
  } catch {
    // 切不动就算了，不该因此拦住启动
  }
}

const child = spawn(process.execPath, [serverEntry], {
  stdio: 'inherit',
  env: process.env,
});

// 转发信号，保证 Ctrl+C 能干净退出而不是留下孤儿进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
