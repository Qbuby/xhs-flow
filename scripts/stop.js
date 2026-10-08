/**
 * 停止正在运行的 xhsflow。
 *
 * 为什么需要：Ctrl+C 有时留不下干净的退出（终端被直接关掉、被强杀），
 * 于是端口还被占着，下次 npm start 直接 EADDRINUSE。
 * 这个脚本按**命令行特征**精准匹配，只杀本项目的进程，
 * 不会误伤你机器上别的 node 服务。
 */
import { execFileSync } from 'node:child_process';

const MARKERS = ['server/dist/index.js', 'scripts/start.js', 'server\\dist\\index.js', 'scripts\\start.js'];
const IS_WIN = process.platform === 'win32';

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function listOurPids() {
  if (IS_WIN) {
    const cond = MARKERS.map((m) => `$c -like '*${m}*'`).join(' -or ');
    const script = [
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
      `| Where-Object { $c = $_.CommandLine; $c -and (${cond}) }`,
      '| ForEach-Object { $_.ProcessId }',
    ].join(' ');
    return run('powershell.exe', ['-NoProfile', '-Command', script])
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  const out = run('sh', ['-c', `pgrep -f 'server/dist/index.js|scripts/start.js' || true`]);
  return out.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

function killPid(pid) {
  if (IS_WIN) {
    run('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
}

const pids = listOurPids();

if (pids.length === 0) {
  console.log('没有正在运行的 xhsflow 进程。');
  process.exit(0);
}

console.log(`发现 ${pids.length} 个 xhsflow 进程，正在停止…`);
for (const pid of pids) killPid(pid);

// 连带清掉它拉起的 Chromium —— 那些进程会一直占着 profile 锁，
// 导致下次启动报「已有浏览器会话打开」
if (IS_WIN) {
  run('powershell.exe', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*chrome-profile*' } | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ]);
}

console.log('已停止。');
