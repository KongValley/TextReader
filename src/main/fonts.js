/** 系统字体枚举（Windows 注册表 HKLM + HKCU 的 Fonts 键；结果按进程缓存）。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/* PowerShell 输出强制 UTF-8（reg.exe/PowerShell 默认 ANSI，中文会变乱码）。
 * Get-Item(...) 的 .Property 只回 value 名，不带 PSPath 等附加属性。 */
const PS_SCRIPT = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; @('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts','HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts') | ForEach-Object { try { (Get-Item $_).Property } catch {} }`;

/** 解析枚举输出：去 (TrueType)/(OpenType) 后缀、按 & 拆分、忽略空行，去重排序。 */
export function parseFontList(stdout) {
  const names = new Set();
  for (let line of String(stdout ?? '').split(/\r?\n/)) {
    const m = line.match(/^(.*?)\s{2,}REG_SZ\s+/i); // 疑似 reg.exe 行：只取 REG_SZ 前的名字段
    line = (m ? m[1] : line).replace(/\s*\((?:TrueType|OpenType)\)\s*$/i, '').trim();
    if (!line || !/\p{L}/u.test(line)) continue;
    for (const part of line.split('&')) {
      const name = part.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort(new Intl.Collator(['zh-Hans-CN', 'en'], { sensitivity: 'base' }).compare);
}

let cache = null;
/** 枚举系统已安装字体名；失败（无 powershell、超时）→ []（渲染端按空列表处理，输入仍可用）。 */
export async function listSystemFonts() {
  if (cache) return cache;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    cache = parseFontList(stdout);
  } catch {
    cache = [];
  }
  return cache;
}
