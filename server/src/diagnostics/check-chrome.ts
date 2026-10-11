import fs from 'node:fs';
import path from 'node:path';

const CHROME_PATHS = [
  process.env.XHSFLOW_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter((p): p is string => Boolean(p));

const found = CHROME_PATHS.find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});
console.log('found chrome:', found);

function chromeMajorVersion(chromePath: string): string | undefined {
  try {
    const dir = path.dirname(chromePath);
    const versions = fs
      .readdirSync(dir)
      .map((name) => /^(\d+)\.\d+\.\d+\.\d+$/.exec(name)?.[1])
      .filter((v): v is string => Boolean(v))
      .map(Number)
      .sort((a, b) => b - a);
    if (versions.length > 0) return String(versions[0]);
  } catch { /* ignore */ }
  return undefined;
}

if (found) {
  const v = chromeMajorVersion(found);
  console.log('major version:', v);
  console.log('UA:', `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v ?? 'FALLBACK'}.0.0.0 Safari/537.36`);
}
