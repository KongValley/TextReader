/** 启动真实 Electron 进程跑冒烟测试（独立 user-data-dir，避免污染真实配置），透传退出码。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_DATA = path.join(ROOT, 'shots', 'userdata');

fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });

const child = spawn(electron, ['.', `--user-data-dir=${USER_DATA}`], {
  cwd: ROOT,
  env: { ...process.env, TXT_SMOKE: '1' },
  stdio: 'inherit',
});

child.on('exit', (code) => {
  if (code === 0) console.log('冒烟测试通过 ✅');
  else console.error(`冒烟测试失败，退出码 ${code}`);
  process.exit(code ?? 1);
});
