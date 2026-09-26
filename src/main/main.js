/**
 * 主进程入口。
 * - 自定义 app:// 协议加载渲染层（file:// 下 ES module 会被 CORS 拦截）
 * - 文件读取 + 编码探测 + 持久化（窗口状态、设置、最近打开、每本书的进度与书签）
 * - 菜单命令通过 IPC 下发给渲染进程
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENCODINGS, decodeBuffer } from './encoding.js';
import { buildMenu } from './menu.js';
import { Store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..');
const ROOT_DIR = path.join(SRC_DIR, '..');
const APP_SCHEME = 'app';
const MAX_FILE_BYTES = 256 * 1024 * 1024;

let store = null;
let mainWindow = null;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/* ---------- 渲染层资源协议 ---------- */

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, (request) => {
    let relPath;
    try {
      relPath = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const target = path.normalize(path.join(SRC_DIR, relPath.replace(/^\/+/, '')));
    if (target !== SRC_DIR && !target.startsWith(SRC_DIR + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

/* ---------- 窗口 ---------- */

function createWindow() {
  const w = store.data.window;
  const win = new BrowserWindow({
    width: w.width,
    height: w.height,
    x: w.x ?? undefined,
    y: w.y ?? undefined,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'TXT 阅读器',
    backgroundColor: '#f6ecd8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (w.maximized) win.maximize();
    win.show();
  });

  win.on('close', () => {
    try {
      const b = win.getNormalBounds();
      store.patchWindow({ ...b, maximized: win.isMaximized() });
    } catch {
      /* 忽略 */
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.loadURL(`${APP_SCHEME}://local/renderer/index.html`);
  return win;
}

function sendCommand(cmd, payload) {
  mainWindow?.webContents.send('command', cmd, payload);
}

function refreshMenu() {
  Menu.setApplicationMenu(
    buildMenu({
      getSettings: () => store.settings,
      getRecent: () => store.recent,
      getWindow: () => mainWindow ?? undefined,
      send: sendCommand,
    }),
  );
}

/* ---------- 打开文件 ---------- */

/** 读取 + 解码 + 记入最近打开，返回给渲染进程的完整 payload。 */
async function readBook(filePath, encoding) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('目标不是文件');
  if (stat.size > MAX_FILE_BYTES) throw new Error('文件过大（超过 256MB）');
  const buf = await fsp.readFile(filePath);
  const { text, encoding: enc, warning } = decodeBuffer(buf, encoding);
  const name = path.basename(filePath);
  // 文件被移动/改名后，按“同名同大小”沿用原阅读位置与书签
  const inherited = store.inheritBook(filePath, { name, size: stat.size });
  store.touchRecent({ path: filePath, name, size: stat.size });
  const book = store.setBook(filePath, { encoding: enc, name, size: stat.size });
  refreshMenu();
  return {
    path: filePath,
    name,
    size: stat.size,
    encoding: enc,
    warning,
    characters: text.length,
    text,
    book,
    inherited: inherited ? { from: inherited.inheritedFrom, chapterIndex: book.chapterIndex } : null,
  };
}

async function safeRead(filePath, encoding) {
  try {
    return await readBook(filePath, encoding);
  } catch (err) {
    const code = err?.code;
    const msg =
      code === 'ENOENT'
        ? '文件不存在或已被移动'
        : code === 'EACCES' || code === 'EPERM'
          ? '没有权限读取该文件'
          : code === 'EISDIR'
            ? '不能打开文件夹'
            : String(err?.message ?? err);
    return { error: msg };
  }
}

/** 让渲染进程按路径打开文件（CLI 参数 / 第二实例 / 冒烟测试走这里）。 */
export function openPathInWindow(win, filePath, encoding) {
  win?.webContents.send('open-path', { path: filePath, encoding: encoding ?? null });
}

function fileFromArgv(argv) {
  const args = argv.slice(process.defaultApp ? 2 : 1);
  for (const a of args) {
    if (!a || a.startsWith('--')) continue;
    try {
      if (fs.statSync(a).isFile()) return path.resolve(a);
    } catch {
      /* 不是文件 */
    }
  }
  return null;
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle('file:open-dialog', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '打开 TXT 小说',
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt', 'text', 'log', 'md'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths?.length) return null;
    return safeRead(res.filePaths[0]);
  });

  ipcMain.handle('file:open', (_e, filePath, encoding) => {
    if (typeof filePath !== 'string' || !filePath) return { error: '无效路径' };
    return safeRead(filePath, encoding ?? undefined);
  });

  ipcMain.handle('file:reveal', (_e, filePath) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('app:encodings', () => ENCODINGS);

  ipcMain.handle('state:get', () => ({
    settings: store.settings,
    recent: store.recent,
    encodings: ENCODINGS,
  }));

  ipcMain.handle('state:settings', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      store.patchSettings(patch);
      refreshMenu();
    }
    return store.settings;
  });

  const saveProgress = (filePath, progress) => {
    if (typeof filePath !== 'string' || !filePath || !progress || typeof progress !== 'object') return;
    const { chapterIndex, ratio, percent } = progress;
    store.setBook(filePath, {
      chapterIndex: Number.isFinite(chapterIndex) ? chapterIndex : 0,
      ratio: Number.isFinite(ratio) ? ratio : 0,
      percent: Number.isFinite(percent) ? percent : 0,
    });
  };
  ipcMain.on('state:progress', (_e, filePath, progress) => saveProgress(filePath, progress));
  ipcMain.handle('state:progress', (_e, filePath, progress) => saveProgress(filePath, progress));

  ipcMain.handle('state:bookmarks', (_e, filePath, list) => {
    if (typeof filePath !== 'string' || !filePath || !Array.isArray(list)) return null;
    return store.setBook(filePath, { bookmarks: list.slice(-200) });
  });

  ipcMain.handle('state:remove-recent', (_e, filePath) => {
    store.removeRecent(filePath);
    refreshMenu();
    return store.recent;
  });

  ipcMain.handle('state:clear-recent', () => {
    store.clearRecent();
    refreshMenu();
    return store.recent;
  });
}

/* ---------- 启动 ---------- */

export async function bootstrap() {
  store = new Store(path.join(app.getPath('userData'), 'state.json'));
  await app.whenReady();
  registerAppProtocol();
  registerIpc();

  mainWindow = createWindow();
  refreshMenu();

  const pending = fileFromArgv(process.argv);
  mainWindow.webContents.once('did-finish-load', () => {
    if (pending) openPathInWindow(mainWindow, pending);
    if (process.env.TXT_SMOKE) runSmokeHook(mainWindow);
  });

  app.on('second-instance', (_e, argv) => {
    const file = fileFromArgv(argv);
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (file) openPathInWindow(mainWindow, file);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => store.flush());

  return mainWindow;
}

async function runSmokeHook(win) {
  try {
    const mod = await import(pathToFileURL(path.join(ROOT_DIR, 'scripts', 'smoke.js')).href);
    await mod.runSmoke({ app, win, store, openFile: (p, enc) => openPathInWindow(win, p, enc) });
  } catch (err) {
    console.error('[smoke] 失败:', err);
    app.exit(3);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  bootstrap().catch((err) => {
    console.error('[main] 启动失败:', err);
    app.exit(1);
  });
}
