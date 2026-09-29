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
import updaterPkg from 'electron-updater';
import { ENCODINGS, decodeBuffer } from './encoding.js';
import { listSystemFonts } from './fonts.js';
import { buildMenu } from './menu.js';
import { isPdfPath, readPdfFile } from './pdf.js';
import { Store } from './store.js';
import { checkForUpdates } from './updater.js';

const { autoUpdater } = updaterPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..');
const ROOT_DIR = path.join(SRC_DIR, '..');
const APP_SCHEME = 'app';
const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** pdf.js 的运行时资源（模块、worker、cmaps、标准字体、wasm）直接从 node_modules 里取。 */
const VENDOR_PREFIX = '/vendor/pdfjs/';
const PDFJS_DIR = path.join(ROOT_DIR, 'node_modules', 'pdfjs-dist');
const VENDOR_MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };

/** 检查更新（手动，帮助 > 检查更新…）：只读 GitHub Releases API；应用其余时间完全离线。 */
const RELEASES_URL = 'https://api.github.com/repos/KongValley/TextReader/releases/latest';
const updateLogMarkers = [];

let store = null;
let mainWindow = null;
let activeKind = null;

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

    const isVendor = relPath.startsWith(VENDOR_PREFIX);
    const base = isVendor ? PDFJS_DIR : SRC_DIR;
    const rel = isVendor ? relPath.slice(VENDOR_PREFIX.length) : relPath.replace(/^\/+/, '');
    const target = path.normalize(path.join(base, rel));
    if (target !== base && !target.startsWith(base + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    if (isVendor) return serveVendor(target);
    return net.fetch(pathToFileURL(target).toString());
  });
}

/** 显式给出 MIME：pdf.js 的 .mjs / .wasm 依赖正确的 Content-Type，不能靠系统文件类型推断。 */
async function serveVendor(target) {
  try {
    const body = await fsp.readFile(target);
    return new Response(body, {
      headers: {
        'content-type': VENDOR_MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      },
    });
  } catch (err) {
    return new Response(`not found: ${err?.code ?? err}`, { status: 404 });
  }
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
    autoHideMenuBar: true, // 隐藏标题栏后菜单栏改为 Alt 呼出
    alwaysOnTop: store.settings?.alwaysOnTop === true,
    title: 'TXT 阅读器',
    backgroundColor: '#f6ecd8',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f6ecd8', symbolColor: '#5b4636', height: 36 },
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
      getActiveKind: () => activeKind,
      send: sendCommand,
      checkUpdate: runUpdateCheck,
    }),
  );
}

async function fetchReleaseJson() {
  // 测试钩子：设定 TXT_UPDATE_FAKE 时直接用伪造响应（相同接口的另一实现），不发真实网络请求
  if (process.env.TXT_UPDATE_FAKE !== undefined) return JSON.parse(process.env.TXT_UPDATE_FAKE);
  const res = await net.fetch(RELEASES_URL, {
    headers: { 'User-Agent': 'TXT-Reader-Update-Check', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function runLegacyUpdateCheck() {
  updateLogMarkers.length = 0; // 每次检查只留本轮标记（手动触发，频率低）
  const smoke = Boolean(process.env.TXT_SMOKE);
  void checkForUpdates({
    currentVersion: app.getVersion(),
    fetchJson: fetchReleaseJson,
    showDialog: smoke
      ? async (opts) => {
          updateLogMarkers.push(`dialog-shown title=${opts.title} buttons=${(opts.buttons ?? []).join('|')}`);
          return 0;
        }
      : async (opts) => (await dialog.showMessageBox(mainWindow ?? undefined, opts)).response,
    openExternal: smoke ? (url) => updateLogMarkers.push(`open-external=${url}`) : (url) => shell.openExternal(url),
    log: (line) => {
      updateLogMarkers.push(line);
      console.log(line);
    },
  });
}

/** 统一的中文提示框（冒烟模式下只记标记，不弹真窗）。 */
function showUpdateDialog(title, message, detail = '') {
  if (process.env.TXT_SMOKE) {
    updateLogMarkers.push(`dialog-shown title=${title} buttons=好`);
    return Promise.resolve();
  }
  return dialog
    .showMessageBox(mainWindow ?? undefined, { type: 'info', title, message, detail, buttons: ['好'], defaultId: 0, cancelId: 0 })
    .then(() => {});
}

/** 更新检查失败提示（冒烟模式下只记标记，不弹真窗）。 */
function showUpdateError(err) {
  if (process.env.TXT_SMOKE) {
    updateLogMarkers.push('dialog-shown title=检查更新 buttons=好');
    return Promise.resolve();
  }
  return dialog
    .showMessageBox(mainWindow ?? undefined, {
      type: 'warning',
      title: '检查更新',
      message: '无法检查更新',
      detail: `原因：${String(err?.message ?? err)}\n\n可稍后重试，或手动访问 https://github.com/KongValley/TextReader/releases 查看。`,
      buttons: ['好'],
      defaultId: 0,
      cancelId: 0,
    })
    .then(() => {});
}

let packagedUpdaterInited = false;
let manualMode = false;

function initPackagedUpdater() {
  if (packagedUpdaterInited) return;
  packagedUpdaterInited = true;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', (info) => {
    updateLogMarkers.push(`[update] downloading version=${info.version}`);
    if (manualMode) void showUpdateDialog('发现新版本', `发现新版本 ${info.version}，正在后台下载…`);
  });
  autoUpdater.on('update-not-available', (info) => {
    updateLogMarkers.push(`[update] dialog=up-to-date latest=${info?.version ?? ''}`);
    if (manualMode) void showUpdateDialog('检查更新', `当前已是最新版本 v${app.getVersion()}`, `服务器最新版本 ${String(info?.version ?? '')}`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    void dialog
      .showMessageBox(mainWindow ?? undefined, {
        type: 'question',
        message: `${info.version} 已下载完成，是否重启应用完成安装？`,
        buttons: ['重启安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        updateLogMarkers.push(`[update] restart-choice=${response}`);
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });
  autoUpdater.on('error', (err) => {
    updateLogMarkers.push(`[update] dialog=error reason=${String(err?.message ?? err)}`);
    if (manualMode) void showUpdateError(err);
  });
}

async function runUpdateCheck(manual = true) {
  updateLogMarkers.length = 0;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    runLegacyUpdateCheck(); // 便携版：既有浏览器直链手动流程
    return;
  }
  manualMode = manual;
  initPackagedUpdater();
  try {
    const res = await autoUpdater.checkForUpdates();
    if (res === null) {
      // 应用未打包（开发环境）时 electron-updater 静默跳过，这里补提示与标记
      updateLogMarkers.push('[update] dialog=error reason=not-packaged');
      if (manual) void showUpdateError(new Error('应用未打包（开发环境），未执行更新检查'));
    }
  } catch (err) {
    updateLogMarkers.push(`[update] dialog=error reason=${String(err?.message ?? err)}`);
    if (manual) void showUpdateError(err);
  }
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
    kind: 'txt',
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
    const payload = isPdfPath(filePath) ? await readPdfFile(filePath, { store }) : await readBook(filePath, encoding);
    activeKind = payload.kind;
    refreshMenu();
    return payload;
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
      title: '打开 文本 / PDF',
      properties: ['openFile'],
      filters: [
        { name: '文本 / PDF', extensions: ['txt', 'text', 'log', 'md', 'pdf'] },
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

  ipcMain.handle('app:fonts', () => listSystemFonts());

  ipcMain.handle('state:get', () => ({
    settings: store.settings,
    recent: store.recent.map((r) => ({ ...r, percent: store.getBook(r.path)?.percent ?? 0 })),
    encodings: ENCODINGS,
  }));

  ipcMain.handle('state:settings', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      store.patchSettings(patch);
      if ('alwaysOnTop' in patch) mainWindow?.setAlwaysOnTop(patch.alwaysOnTop === true);
      refreshMenu();
    }
    return store.settings;
  });

  const saveProgress = (filePath, progress) => {
    if (typeof filePath !== 'string' || !filePath || !progress || typeof progress !== 'object') return;
    const { chapterIndex, ratio, percent, readMsDelta } = progress;
    store.setBook(filePath, {
      chapterIndex: Number.isFinite(chapterIndex) ? chapterIndex : 0,
      ratio: Number.isFinite(ratio) ? ratio : 0,
      percent: Number.isFinite(percent) ? percent : 0,
      readMs: (store.getBook(filePath)?.readMs ?? 0) + (Number(readMsDelta) || 0),
    });
  };
  ipcMain.on('state:progress', (_e, filePath, progress) => saveProgress(filePath, progress));
  ipcMain.handle('state:progress', (_e, filePath, progress) => saveProgress(filePath, progress));

  ipcMain.handle('state:bookmarks', (_e, filePath, list) => {
    if (typeof filePath !== 'string' || !filePath || !Array.isArray(list)) return null;
    return store.setBook(filePath, { bookmarks: list.slice(-200) });
  });

  ipcMain.handle('state:highlights', (_e, filePath, list) => {
    if (typeof filePath !== 'string' || !filePath || !Array.isArray(list)) return null;
    return store.setBook(filePath, { highlights: list.slice(-200) });
  });

  ipcMain.handle('shelf:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '添加文件夹到书架（可多选）',
      properties: ['openDirectory', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('shelf:scan', (_e, dir) => {
    if (typeof dir !== 'string' || !dir) return { error: '无效目录' };
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const dirs = [];
      const files = [];
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) dirs.push({ name: e.name, path: fp });
        else if (e.isFile() && /\.(txt|pdf)$/i.test(e.name)) {
          let size = 0;
          try {
            size = fs.statSync(fp).size;
          } catch {
            /* 竞态消失的文件按 0 计 */
          }
          const b = store.getBook(fp);
          files.push({ name: e.name, path: fp, size, percent: b.percent, updatedAt: b.updatedAt });
        }
      }
      const byName = (a, b) => a.name.localeCompare(b.name, 'zh');
      const byReading = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || byName(a, b);
      return { dir, dirs: dirs.sort(byName), files: files.sort(byReading) };
    } catch {
      return { error: '无法读取该目录' };
    }
  });

  // 根视图联查：每个书架文件夹的直接子文件里，读过(updatedAt>0)的按 updatedAt 取最大那本
  ipcMain.handle('shelf:stat', (_e, dirs) => {
    const out = {};
    if (!Array.isArray(dirs)) return out;
    for (const dir of dirs) {
      if (typeof dir !== 'string' || !dir) continue;
      let count = 0;
      let last = null; // { name, percent, updatedAt }
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && /\.(txt|pdf)$/i.test(e.name)) {
            count += 1;
            const b = store.getBook(path.join(dir, e.name));
            if (b.updatedAt > 0 && (!last || b.updatedAt > last.updatedAt))
              last = { name: e.name, percent: b.percent, updatedAt: b.updatedAt };
          }
        }
      } catch {
        /* 目录已被删除：不写入 out，渲染端按「文件夹失效」提示 */
        continue;
      }
      out[dir] = { count, last };
    }
    return out;
  });

  ipcMain.on('set-titlebar', (_e, c) => {
    if (!mainWindow || !c?.color) return;
    updateLogMarkers.push(`set-titlebar ${c.color}`); // 冒烟可观测：颜色同步链路
    try {
      mainWindow.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor ?? '#5b4636' });
    } catch {
      /* 旧系统不支持时保持默认 */
    }
  });

  ipcMain.on('context-menu', (_e, p) => {
    if (!mainWindow || !p || typeof p !== 'object') return;
    if (p.shelf) {
      // 书架行菜单：目标行由渲染端 .ctx 选中态定位，命令回推后由渲染端读 dataset 执行
      const tpl = [
        { label: '在资源管理器中显示', click: () => sendCommand('shelf-reveal') },
        { label: '刷新该目录', click: () => sendCommand('shelf-refresh') },
        { type: 'separator' },
        { label: '从书架移除', click: () => sendCommand('shelf-remove') },
      ];
      Menu.buildFromTemplate(tpl).popup({ window: mainWindow, x: Math.round(p.x), y: Math.round(p.y) });
      return;
    }
    const tpl = [];
    const hasSel = !!p.hasSelection;
    if (p.editable || hasSel) tpl.push({ role: 'copy', label: '复制', enabled: hasSel || !!p.editable });
    if (p.editable) {
      tpl.push({ role: 'cut', label: '剪切', enabled: hasSel }, { role: 'paste', label: '粘贴' });
    }
    if (p.mark) tpl.push({ label: '划线', click: () => sendCommand('mark-add') });
    if (p.hlId) tpl.push({ label: '取消划线', click: () => sendCommand('mark-remove', p.hlId) });
    if (tpl.length) tpl.push({ type: 'separator' });
    tpl.push({ role: 'selectAll', label: '全选' });
    Menu.buildFromTemplate(tpl).popup({ window: mainWindow, x: Math.round(p.x), y: Math.round(p.y) });
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

  if (!process.env.TXT_SMOKE && !process.env.PORTABLE_EXECUTABLE_DIR && app.isPackaged) {
    setTimeout(() => {
      void (async () => {
        manualMode = false; // 自动检查：不弹窗，失败静默
        initPackagedUpdater();
        try {
          await autoUpdater.checkForUpdates();
        } catch {
          /* 静默 */
        }
      })();
    }, 10000);
  }

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
    await mod.runSmoke({ app, win, store, openFile: (p, enc) => openPathInWindow(win, p, enc), updateMarkers: updateLogMarkers });
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
