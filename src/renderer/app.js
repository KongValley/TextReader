/**
 * 渲染进程主逻辑：打开文件、章节渲染、翻页/滚动、目录、书签、查找、设置。
 * 文本一律用 textContent 注入，绝不使用 innerHTML。
 */
import { splitChapters } from '../shared/chapters.js';
import { CUSTOM_THEME_VARS, DEFAULT_SETTINGS, FALLBACK_FONT_STACK, MODE_LABEL, PDF_SCALE, THEMES, THEME_BASE_IDS, THEME_LABEL, isHexColor, migrateFontKeys, resolveCustomBase, restReminderDue, splitFontStack } from '../shared/settings.js';
import { PASSWORD_INCORRECT, PdfView } from './pdf/pdf-view.js';

const api = window.api;
const $ = (sel, root = document) => root.querySelector(sel);

const el = {
  body: document.body,
  viewport: $('#viewport'),
  flow: $('#flow'),
  pdfPages: $('#pdf-pages'),
  toc: $('#toc'),
  tocList: $('#toc-list'),
  tocCount: $('#toc-count'),
  settings: $('#settings'),
  bookmarks: $('#bookmarks'),
  bookmarkList: $('#bookmark-list'),
  marks: $('#marks'),
  markList: $('#mark-list'),
  recentList: $('#recent-list'),
  shelfList: $('#shelf-list'),
  shelfAdd: $('#btn-shelf-add'),
  shelfUp: $('#btn-shelf-up'),
  shelfRefresh: $('#btn-shelf-refresh'),
  backShelf: $('#btn-back-shelf'),
  fileName: $('#file-name'),
  encLabel: $('#enc-label'),
  statusChapter: $('#status-chapter'),
  statusProgress: $('#status-progress'),
  statusMeta: $('#status-meta'),
  progressFill: $('#progress-fill'),
  progressTrack: $('#progress-track'),
  toast: $('#toast'),
  pwModal: $('#pw-modal'),
  pwForm: $('#pw-form'),
  pwInput: $('#pw-input'),
  pwHint: $('#pw-hint'),
  pwCancel: $('#pw-cancel'),
  searchInput: $('#search-input'),
  searchCount: $('#search-count'),
  btnMode: $('#btn-mode'),
  btnTheme: $('#btn-theme'),
  fontCjkInput: $('#set-font-family'),
  fontLatinInput: $('#set-font-latin'),
  fontList: $('#font-list'),
  customThemeEditor: $('#custom-theme-editor'),
  customBaseSelect: $('#set-custom-base'),
  customColorInputs: document.querySelectorAll('#custom-theme-editor input[type="color"][data-var]'),
  customReset: $('#btn-custom-reset'),
  encSelect: $('#set-encoding'),
  fontSize: $('#set-font-size'),
  fontSizeVal: $('#font-size-val'),
  lineHeight: $('#set-line-height'),
  lineHeightVal: $('#line-height-val'),
  letterSpacing: $('#set-letter-spacing'),
  letterSpacingVal: $('#letter-spacing-val'),
  autoSpeed: $('#set-auto-speed'),
  autoSpeedVal: $('#auto-speed-val'),
  contentWidth: $('#set-content-width'),
  contentWidthVal: $('#content-width-val'),
  justify: $('#set-justify'),
  restToggle: $('#set-rest'),
  shortcuts: $('#shortcuts'),
  usage: $('#usage'),
};

const state = {
  kind: 'txt', // 'txt' | 'pdf'
  pdf: null, // PdfView 实例（kind === 'pdf' 时存在）
  page: 0, // PDF 当前页（0 基）
  pages: 0, // PDF 总页数
  file: null, // { path, name, size }
  text: '',
  chapters: [],
  index: 0,
  paras: [], // 当前章渲染出的段落 { text, rawStart, len }
  wordCount: 0,
  encoding: 'auto',
  settings: { ...DEFAULT_SETTINGS },
  book: { encoding: 'auto', chapterIndex: 0, ratio: 0, bookmarks: [] },
  recent: [],
  search: { query: '', matches: [], cursor: -1 },
  layout: { pageW: 0, pageH: 0, gap: 72, pageCount: 1, page: 0 },
};

let wheelLockUntil = 0;
let saveTimer = null;
let settingsTimer = null;
let resizeTimer = null;

const jumpHistory = []; // 大跳转（目录/书签/查找/进度条/Home/End）前的位置，Alt+← 回退

let lastActivityAt = Date.now(); // 久坐提醒：最近一次用户活动
let lastRestPromptAt = Date.now(); // 久坐提醒：上次提示时间

let autoReading = false;
let autoTimer = null;
let autoFlipAt = 0;

let readAccum = 0; // 阅读时长：待落盘的本轮累计毫秒
let lastReadTick = Date.now();

let shelfCurrent = ''; // 书架当前所在目录（'' = 书架根）
let shelfRootReq = 0; // 书架根视图异步 meta 的竞态序号

function stopAutoRead({ silent = false } = {}) {
  if (!autoReading) return;
  autoReading = false;
  clearInterval(autoTimer);
  autoTimer = null;
  if (!silent) toast('已停止自动阅读');
}

function toggleAutoRead() {
  if (autoReading) return stopAutoRead();
  if (!state.file) return toast('先打开一本书');
  autoReading = true;
  toast(`自动阅读 ${state.settings.autoScrollSpeed}px/s（+/- 调速，任意操作停止）`);
  if (state.settings.mode === 'paged') {
    autoFlipAt = 0;
    autoTimer = setInterval(() => {
      if (Date.now() < autoFlipAt) return;
      nextPage();
      autoFlipAt = Date.now() + Math.round((el.viewport.clientHeight / Math.max(20, state.settings.autoScrollSpeed)) * 1000);
    }, 200);
  } else {
    autoTimer = setInterval(() => {
      el.viewport.scrollBy({ top: Math.max(2, state.settings.autoScrollSpeed / 10) });
      if (state.kind === 'txt' && atBottom()) nextChapter();
    }, 100);
  }
}

function pushJumpHistory() {
  if (!state.file) return;
  jumpHistory.push(
    state.kind === 'pdf'
      ? { kind: 'pdf', page: state.page }
      : { kind: 'txt', index: state.index, ratio: currentRatio() },
  );
  if (jumpHistory.length > 20) jumpHistory.shift();
}

function goBackJump() {
  const ent = jumpHistory.pop();
  if (!ent) return toast('没有更早的跳转了');
  if (ent.kind === 'pdf') state.pdf?.goToPage(ent.page);
  else gotoChapter(ent.index, ent.ratio);
}

/* ================= 工具 ================= */

function toast(msg, isError = false) {
  if (!msg) {
    el.toast.hidden = true;
    return;
  }
  el.toast.textContent = msg;
  el.toast.dataset.kind = isError ? 'error' : 'info';
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.toast.hidden = true;
  }, isError ? 4200 : 2200);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtNum = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function relTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  const t = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

function fmtDuration(ms) {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
  return `${(ms / 3_600_000).toFixed(1)} 小时`;
}

/** 状态栏「已读」后缀：该书累计满 1 分钟才显示 */
function readMetaSuffix() {
  const total = (state.book.readMs ?? 0) + readAccum;
  return total >= 60_000 ? ` · 已读 ${fmtDuration(total)}` : '';
}

/* ================= 设置 ================= */

function applySettings() {
  const s = state.settings;
  const root = document.documentElement;
  if (s.theme === 'custom') {
    root.dataset.theme = resolveCustomBase(s.customThemeBase);
    for (const { var: v } of CUSTOM_THEME_VARS) {
      const c = s.customThemeColors?.[v];
      if (isHexColor(c)) root.style.setProperty(v, c);
      else root.style.removeProperty(v); /* 未覆盖 → 清除内联覆盖，跟随基座 CSS 块 */
    }
  } else {
    root.dataset.theme = s.theme;
    for (const { var: v } of CUSTOM_THEME_VARS) root.style.removeProperty(v);
  }
  root.style.setProperty('--font-size', `${s.fontSize}px`);
  root.style.setProperty('--line-height', String(s.lineHeight));
  root.style.setProperty('--letter-spacing', `${s.letterSpacing}em`);
  root.style.setProperty('--reading-font', splitFontStack({ latin: s.fontLatin, cjk: s.fontCjk }) ?? FALLBACK_FONT_STACK);
  root.style.setProperty('--content-width', `${s.contentWidth}px`);
  root.style.setProperty('--align', s.justify ? 'justify' : 'start');
  el.viewport.dataset.mode = s.mode;
  el.btnMode.textContent = MODE_LABEL[s.mode] ?? '翻页';
  el.btnTheme.textContent = THEME_LABEL[s.theme] ?? '护眼';
  // PDF 视图只认翻页方式与缩放：字号/行距/版心对页面本身没有意义
  state.pdf?.setMode(s.mode);
  if (state.pdf) state.pdf.setScale(resolvePdfScale());
  // 标题栏 overlay 跟随主题面板色（自定义配色输入实时变化也走 applySettings）
  const cs = getComputedStyle(document.documentElement);
  api.setTitleBar({ color: cs.getPropertyValue('--panel').trim() || '#f6ecd8', symbolColor: cs.getPropertyValue('--fg-soft').trim() || '#5b4636' });
}

/** 设置里的 0 表示「适应窗口」，其余按手动比例（并夹在允许范围内） */
function resolvePdfScale() {
  const v = Number(state.settings.pdfScale);
  if (!Number.isFinite(v) || v <= 0) return pdfFitScale();
  return clamp(v, PDF_SCALE.min, PDF_SCALE.max);
}

/** 当前页在可用区域内完整显示所需的比例 */
function pdfFitScale() {
  if (!state.pdf) return 1;
  const cs = getComputedStyle(el.viewport);
  const w = el.viewport.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = el.viewport.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  return state.pdf.fitScale(w, h, state.page);
}

function syncSettingsUI() {
  const s = state.settings;
  for (const b of el.settings.querySelectorAll('#set-theme button')) b.classList.toggle('active', b.dataset.theme === s.theme);
  for (const b of el.settings.querySelectorAll('#set-mode button')) b.classList.toggle('active', b.dataset.mode === s.mode);
  el.fontCjkInput.value = s.fontCjk ?? '';
  el.fontLatinInput.value = s.fontLatin ?? '';
  el.fontSize.value = String(s.fontSize);
  el.fontSizeVal.textContent = `${s.fontSize}px`;
  el.lineHeight.value = String(s.lineHeight);
  el.lineHeightVal.textContent = s.lineHeight.toFixed(2);
  el.letterSpacing.value = String(s.letterSpacing);
  el.letterSpacingVal.textContent = `${s.letterSpacing.toFixed(3)}em`;
  el.contentWidth.value = String(s.contentWidth);
  el.contentWidthVal.textContent = `${s.contentWidth}px`;
  el.justify.checked = !!s.justify;
  el.restToggle.checked = !!s.restReminder;
  el.autoSpeed.value = String(s.autoScrollSpeed);
  el.autoSpeedVal.textContent = `${s.autoScrollSpeed}px/s`;
  el.customThemeEditor.hidden = s.theme !== 'custom';
  if (s.theme === 'custom') {
    el.customBaseSelect.value = resolveCustomBase(s.customThemeBase);
    const cs = getComputedStyle(document.documentElement);
    for (const input of el.customColorInputs) {
      const v = input.dataset.var;
      const override = s.customThemeColors?.[v];
      const fromCss = cs.getPropertyValue(v).trim();
      input.value = (isHexColor(override) ? override : isHexColor(fromCss) ? fromCss : '#000000').toLowerCase();
    }
  }
}

function updateSettings(patch, { relayoutNow = true } = {}) {
  Object.assign(state.settings, patch);
  applySettings();
  syncSettingsUI();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => api.saveSettings({ ...state.settings }), 250);
  if (relayoutNow && state.file) relayout({ preserve: true });
}

/* ================= 打开文件 ================= */

async function openDialog() {
  const res = await api.openDialog();
  if (!res) return;
  await openPayload(res);
}

async function openPath(filePath, encoding) {
  if (!filePath) return;
  toast('正在打开…');
  const res = await api.openFile(filePath, encoding ?? 'auto');
  await openPayload(res);
}

async function openPayload(res) {
  if (!res || res.error) {
    toast(res?.error ?? '打开失败', true);
    return;
  }
  if (res.kind === 'pdf') return openPdf(res);
  closePdf();
  state.kind = 'txt';
  state.page = 0;
  state.pages = 0;
  el.body.dataset.kind = 'txt';
  el.flow.hidden = false;

  state.file = { path: res.path, name: res.name, size: res.size };
  state.text = res.text;
  jumpHistory.length = 0;
  state.chapters = splitChapters(res.text);
  state.book = res.book ?? { chapterIndex: 0, ratio: 0, bookmarks: [] };
  state.encoding = res.encoding;
  state.wordCount = countChars(res.text);
  state.search = { query: '', matches: [], cursor: -1 };
  el.searchInput.value = '';
  el.searchCount.textContent = '';
  clearHighlight();

  el.body.classList.add('has-file');
  el.fileName.textContent = res.name;
  el.encLabel.hidden = false;
  el.encLabel.textContent = res.encoding.toUpperCase();
  el.encLabel.dataset.warn = res.warning ? '1' : '0';
  el.encLabel.dataset.pdf = '0';
  el.encLabel.title = res.warning ? '存在无法解码的字符，可在“设置”里手动指定编码' : `编码：${res.encoding}`;
  el.encSelect.value = res.encoding;

  renderToc();
  renderBookmarks();
  renderMarks();
  gotoChapter(state.book.chapterIndex ?? 0, state.book.ratio ?? 0);
  updateStatus();
  if (res.warning) toast('部分字符无法解码，可在设置中切换编码', true);
  else if (res.inherited) toast(`已沿用原阅读记录（第 ${(state.book.chapterIndex ?? 0) + 1} 章）`);
  else if ((state.book.chapterIndex ?? 0) > 0 || (state.book.ratio ?? 0) > 0)
    toast(`已恢复到上次位置（第 ${(state.book.chapterIndex ?? 0) + 1} 章 ${Math.round((state.book.percent ?? 0) * 100)}%）`);
  else toast('');
}

/* ================= 打开 PDF ================= */

function closePdf() {
  // 切换文档时丢弃还在跑的 PDF 查找与未答完的密码框
  pdfSearchToken++;
  pdfSearchBusy = false;
  closePasswordDialog(null);
  if (!state.pdf) return;
  state.pdf.destroy();
  state.pdf = null;
  el.pdfPages.hidden = true;
}

function pdfErrorMessage(err) {
  const name = err?.name ?? '';
  const msg = String(err?.message ?? err);
  if (name === 'PasswordException' || /password/i.test(msg)) return 'PDF 已加密，密码校验未通过';
  if (name === 'InvalidPDFException') return 'PDF 无法解析（文件损坏或格式异常）';
  return `PDF 打开失败：${msg}`;
}

/* ---------- 加密 PDF 的密码输入 ---------- */

/** 本次运行内记住已经验证通过的密码（只在内存里，不写进 state.json） */
const pdfPasswords = new Map();
let pwResolve = null;

/** 弹框要密码；返回密码字符串，取消返回 null */
function askPdfPassword(filePath, fileName, reason) {
  const incorrect = reason === PASSWORD_INCORRECT;
  if (incorrect) pdfPasswords.delete(filePath); // 之前记的密码不对，丢掉
  const cached = pdfPasswords.get(filePath);
  if (cached && !incorrect) return Promise.resolve(cached);

  return new Promise((resolve) => {
    pwResolve = resolve;
    el.pwHint.textContent = incorrect
      ? '密码不正确，请重试。'
      : `${fileName ? `「${fileName}」` : '该 PDF'}已加密，需要密码才能打开。`;
    el.pwInput.value = '';
    el.pwInput.dataset.error = incorrect ? '1' : '0';
    el.pwModal.hidden = false;
    el.pwInput.focus();
  });
}

function closePasswordDialog(password) {
  if (!pwResolve) return;
  const resolve = pwResolve;
  pwResolve = null;
  el.pwModal.hidden = true;
  el.pwInput.value = '';
  el.pwInput.dataset.error = '0';
  resolve(password);
}

function bindPasswordDialog() {
  el.pwForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const password = el.pwInput.value;
    if (!password) return; // 无密码的 PDF 不会走到这里，空串没有意义
    closePasswordDialog(password);
  });
  el.pwCancel.addEventListener('click', () => closePasswordDialog(null));
}

async function openPdf(res) {
  closePasswordDialog(null); // 上一次没答完的密码框作废（它对应的加载会被中止）
  const view = new PdfView({
    container: el.viewport,
    strip: el.pdfPages,
    scale: 1, // 打开后按设置（可能为「适应窗口」）再定比例
    mode: state.settings.mode,
  });
  toast('正在打开 PDF…');
  let usedPassword = null;
  let cancelled = false;
  try {
    await view.open(res.data, {
      onPassword: async (reason) => {
        const password = await askPdfPassword(res.path, res.name, reason);
        if (password) usedPassword = password;
        else cancelled = true;
        return password;
      },
    });
  } catch (err) {
    view.destroy();
    // 用户点"取消"时 pdf.js 只会抛出 PasswordException("No password given")，得靠这个标记区分
    if (cancelled) {
      toast('已取消打开该 PDF（需要密码）');
      return;
    }
    console.error('[pdf] 打开失败', err?.name ?? '', err?.message ?? err);
    toast(pdfErrorMessage(err), true);
    return;
  }
  // 记住这次验证通过的密码：同一次运行里再打开这个文件就不再问
  if (usedPassword) pdfPasswords.set(res.path, usedPassword);

  closePdf();
  state.pdf = view;
  state.kind = 'pdf';
  state.file = { path: res.path, name: res.name, size: res.size };
  jumpHistory.length = 0;
  state.book = res.book ?? { chapterIndex: 0, ratio: 0, bookmarks: [] };
  state.pages = view.pageCount;
  state.page = clamp(state.book.chapterIndex ?? 0, 0, Math.max(0, view.pageCount - 1));
  state.encoding = 'pdf';
  state.text = '';
  state.chapters = [];
  state.paras = [];
  state.wordCount = 0;
  state.search = { query: '', matches: [], cursor: -1 };
  el.searchInput.value = '';
  el.searchCount.textContent = '';
  clearHighlight();

  el.body.classList.add('has-file');
  el.body.dataset.kind = 'pdf';
  el.fileName.textContent = res.name;
  el.encLabel.hidden = false;
  el.encLabel.textContent = 'PDF';
  el.encLabel.dataset.warn = '0';
  el.encLabel.dataset.pdf = '1';
  el.encLabel.title = `PDF · ${fmtBytes(res.size)}`;
  el.flow.hidden = true;
  el.pdfPages.hidden = false;

  view.onPageChange(onPdfPageChange);
  view.setScale(resolvePdfScale());
  view.goToPage(state.page, { silent: true });
  renderToc();
  renderBookmarks();
  renderMarks();
  updateStatus();
  if (res.inherited) toast(`已沿用原阅读记录（第 ${state.page + 1} 页）`);
  else if (state.page > 0) toast(`已恢复到上次位置（第 ${state.page + 1} 页）`);
  else toast('');
}

function onPdfPageChange(page) {
  state.page = page;
  updateStatus();
  scheduleSaveProgress();
  syncTocActive();
}

/** 当前页所属的大纲项（取页号不超过当前页的最后一项） */
function pdfTitleAt(page) {
  const outline = state.pdf?.outline ?? [];
  let title = '';
  for (const item of outline) {
    if (item.page <= page) title = item.title;
    else break;
  }
  return title || `第 ${page + 1} 页`;
}

function tocIndexForPage(page) {
  const outline = state.pdf?.outline ?? [];
  let idx = -1;
  for (let i = 0; i < outline.length; i++) {
    if (outline[i].page <= page) idx = i;
    else break;
  }
  return idx;
}

function zoomPdf(delta) {
  if (state.kind !== 'pdf' || !state.pdf) return;
  // 从当前生效的比例（可能是适应窗口算出来的）继续缩放
  const next = clamp(Number((state.pdf.scale + delta).toFixed(2)), PDF_SCALE.min, PDF_SCALE.max);
  if (Math.abs(next - state.pdf.scale) < 0.001) return;
  updateSettings({ pdfScale: next });
  toast(`缩放 ${Math.round(next * 100)}%`);
}

function resetPdfZoom() {
  if (state.kind !== 'pdf' || Number(state.settings.pdfScale) === PDF_SCALE.auto) return;
  updateSettings({ pdfScale: PDF_SCALE.auto });
  toast(`适应窗口 ${Math.round(state.pdf.scale * 100)}%`);
}

function countChars(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 32) n++;
  return n;
}

/* ================= 章节渲染 ================= */

function layoutParas(raw, base) {
  const out = [];
  let pos = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      const lead = line.length - line.trimStart().length;
      out.push({ text: trimmed, rawStart: base + pos + lead, len: trimmed.length });
    }
    pos += line.length + 1;
  }
  return out;
}

function renderChapter(index) {
  const ch = state.chapters[index];
  if (!ch) return;
  const raw = state.text.slice(ch.bodyStart, ch.end);
  state.paras = layoutParas(raw, ch.bodyStart);

  const frag = document.createDocumentFragment();
  const h2 = document.createElement('h2');
  h2.className = 'chapter-title';
  h2.textContent = ch.title;
  frag.append(h2);
  state.paras.forEach((p, i) => {
    const node = document.createElement('p');
    node.dataset.i = String(i);
    node.textContent = p.text;
    frag.append(node);
  });
  el.flow.replaceChildren(frag);
  renderHighlights();
}

/* ================= 版面测量 / 定位 ================= */

function measure() {
  const cs = getComputedStyle(el.viewport);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const availW = Math.max(200, Math.round(el.viewport.clientWidth - padX));
  const availH = Math.max(160, Math.round(el.viewport.clientHeight - padY));
  const gap = 72;
  const L = state.layout;

  if (state.settings.mode === 'paged') {
    // 版心宽度同样作用于翻页模式：列宽取“可用宽”与“版心宽”的较小值，并居中
    const w = Math.max(240, Math.min(availW, state.settings.contentWidth));
    L.pageW = w;
    L.pageH = availH;
    L.gap = gap;
    el.flow.style.width = `${w}px`;
    el.flow.style.height = `${availH}px`;
    el.flow.style.columnWidth = `${w}px`;
    el.flow.style.columnGap = `${gap}px`;
    el.flow.style.maxWidth = 'none';
    el.flow.style.margin = '0 auto';
    const sw = el.flow.scrollWidth;
    L.pageCount = Math.max(1, Math.round((sw + gap) / (w + gap)));
  } else {
    L.pageW = availW;
    L.pageH = availH;
    L.gap = gap;
    el.flow.style.width = '';
    el.flow.style.height = '';
    el.flow.style.columnWidth = '';
    el.flow.style.columnGap = '';
    el.flow.style.maxWidth = `${state.settings.contentWidth}px`;
    el.flow.style.margin = '0 auto';
    L.pageCount = 1;
  }
  el.viewport.dataset.pages = String(L.pageCount);
}

function setPage(page, { silent = false } = {}) {
  const L = state.layout;
  const p = clamp(page, 0, Math.max(0, L.pageCount - 1));
  L.page = p;
  el.flow.scrollLeft = p * (L.pageW + L.gap);
  el.viewport.dataset.page = String(p);
  if (!silent) {
    updateStatus();
    scheduleSaveProgress();
  }
}

function currentRatio() {
  if (!state.file) return 0;
  if (state.settings.mode === 'paged') {
    return state.layout.pageCount > 1 ? state.layout.page / (state.layout.pageCount - 1) : 0;
  }
  const max = el.viewport.scrollHeight - el.viewport.clientHeight;
  return max > 4 ? clamp(el.viewport.scrollTop / max, 0, 1) : 0;
}

function restoreScroll(ratio) {
  const max = el.viewport.scrollHeight - el.viewport.clientHeight;
  el.viewport.scrollTop = max > 0 ? clamp(ratio, 0, 1) * max : 0;
}

function relayout({ preserve = true } = {}) {
  if (!state.file) return;
  if (state.kind === 'pdf') {
    if (!Number(state.settings.pdfScale)) state.pdf?.setScale(resolvePdfScale());
    state.pdf?.relayout();
    updateStatus();
    return;
  }
  const ratio = preserve ? currentRatio() : 0;
  measure();
  if (state.settings.mode === 'paged') setPage(Math.round(ratio * Math.max(0, state.layout.pageCount - 1)), { silent: true });
  else restoreScroll(ratio);
  updateStatus();
}

function gotoChapter(index, ratio = 0, { save = true } = {}) {
  if (!state.chapters.length) return;
  const i = clamp(index, 0, state.chapters.length - 1);
  state.index = i;
  renderChapter(i);
  measure();
  if (state.settings.mode === 'paged') setPage(Math.round(ratio * Math.max(0, state.layout.pageCount - 1)), { silent: true });
  else restoreScroll(ratio);
  syncTocActive();
  updateStatus();
  if (save) saveProgressNow();
}

/* ================= 翻页 / 滚动 ================= */

function nextPage() {
  if (!state.file) return;
  if (state.kind === 'pdf') return state.pdf?.next();
  if (state.settings.mode === 'paged') {
    if (state.layout.page < state.layout.pageCount - 1) setPage(state.layout.page + 1);
    else nextChapter();
  } else if (atBottom()) {
    nextChapter();
  } else {
    el.viewport.scrollBy({ top: el.viewport.clientHeight * 0.92, behavior: 'smooth' });
    scheduleSaveProgress();
  }
}

function prevPage() {
  if (!state.file) return;
  if (state.kind === 'pdf') return state.pdf?.prev();
  if (state.settings.mode === 'paged') {
    if (state.layout.page > 0) setPage(state.layout.page - 1);
    else prevChapter();
  } else if (atTop()) {
    prevChapter();
  } else {
    el.viewport.scrollBy({ top: -el.viewport.clientHeight * 0.92, behavior: 'smooth' });
    scheduleSaveProgress();
  }
}

const atBottom = () => el.viewport.scrollTop + el.viewport.clientHeight >= el.viewport.scrollHeight - 4;
const atTop = () => el.viewport.scrollTop <= 4;

function nextChapter() {
  if (!state.file) return;
  if (state.kind === 'pdf') return state.pdf?.next();
  if (state.index >= state.chapters.length - 1) return toast('已经是最后一章');
  gotoChapter(state.index + 1, 0);
  toast(`已进入：${state.chapters[state.index].title}`);
}

function prevChapter() {
  if (!state.file) return;
  if (state.kind === 'pdf') return state.pdf?.prev();
  if (state.index <= 0) return toast('已经是第一章');
  gotoChapter(state.index - 1, 0);
  toast(`已进入：${state.chapters[state.index].title}`);
}

/* ================= 目录 ================= */

function renderToc() {
  const isPdf = state.kind === 'pdf';
  const items = isPdf ? (state.pdf?.outline ?? []) : state.chapters;
  const frag = document.createDocumentFragment();
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'toc-item';
    li.dataset.i = String(i);
    if (isPdf) {
      li.dataset.page = String(item.page);
      li.style.paddingLeft = `${14 + item.depth * 12}px`;
      li.title = `${item.title}（第 ${item.page + 1} 页）`;
    } else {
      li.title = item.title;
    }
    li.textContent = item.title;
    frag.append(li);
  });
  if (!items.length && isPdf) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.style.padding = '10px 14px';
    li.textContent = '暂无目录（该 PDF 没有大纲）';
    frag.append(li);
  }
  el.tocList.replaceChildren(frag);
  el.tocCount.textContent = isPdf ? `${items.length} 项` : `${state.chapters.length} 章`;
}

function syncTocActive() {
  const active = state.kind === 'pdf' ? tocIndexForPage(state.page) : state.index;
  const prev = el.tocList.querySelector('.toc-item.active');
  if (prev) prev.classList.remove('active');
  if (active < 0) return;
  const cur = el.tocList.querySelector(`.toc-item[data-i="${active}"]`);
  if (cur) {
    cur.classList.add('active');
    if (!el.toc.hidden) cur.scrollIntoView({ block: 'nearest' });
  }
}

/* ================= 书签 ================= */

function topParagraph() {
  const rect = el.viewport.getBoundingClientRect();
  const x = Math.round(rect.left + Math.min(120, rect.width / 2));
  const y = Math.round(rect.top + 10);
  let node = document.elementFromPoint(x, y)?.closest?.('p');
  if (!node) node = el.flow.querySelector('p');
  const idx = node ? Number(node.dataset.i) : 0;
  return { paraIndex: Number.isFinite(idx) ? idx : 0, preview: (node?.textContent ?? '').slice(0, 60) };
}

async function addBookmark() {
  if (!state.file) return toast('请先打开文件', true);
  if (state.kind === 'pdf') {
    const page = state.page;
    const text = await state.pdf.pageText(page);
    const list = [...(state.book.bookmarks ?? [])];
    list.push({
      page,
      title: pdfTitleAt(page),
      preview: text.replace(/\s+/g, ' ').trim().slice(0, 60),
      time: Date.now(),
    });
    state.book.bookmarks = list.slice(-200);
    api.saveBookmarks(state.file.path, state.book.bookmarks);
    renderBookmarks();
    toast(`已添加书签（第 ${page + 1} 页）`);
    return;
  }
  const { paraIndex, preview } = topParagraph();
  const ch = state.chapters[state.index];
  const list = [...(state.book.bookmarks ?? [])];
  list.push({
    chapterIndex: state.index,
    paraIndex,
    ratio: currentRatio(),
    title: ch?.title ?? '',
    preview,
    time: Date.now(),
  });
  state.book.bookmarks = list.slice(-200);
  api.saveBookmarks(state.file.path, state.book.bookmarks);
  renderBookmarks();
  toast('已添加书签');
}

function removeBookmark(i) {
  const list = [...(state.book.bookmarks ?? [])];
  list.splice(i, 1);
  state.book.bookmarks = list;
  api.saveBookmarks(state.file.path, list);
  renderBookmarks();
}

/** 行内重命名书签（Electron 不支持 window.prompt）：Enter/失焦提交，Esc 取消，空值视为取消 */
function startBookmarkRename(i, titleEl) {
  const list = state.book.bookmarks ?? [];
  const bm = list[i];
  if (!bm || !titleEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = bm.title ?? '';
  input.maxLength = 60;
  input.className = 'bm-rename';
  titleEl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && v !== bm.title) {
      bm.title = v;
      api.saveBookmarks(state.file.path, list);
    }
    renderBookmarks();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      done = true;
      renderBookmarks();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

function renderBookmarks() {
  const list = state.book.bookmarks ?? [];
  el.bookmarkList.replaceChildren();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.style.padding = '8px 4px';
    p.textContent = '暂无书签。阅读时按 Ctrl+B 或点“书签”按钮添加。';
    el.bookmarkList.append(p);
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach((bm, i) => {
    const row = document.createElement('div');
    row.className = 'bm-row';

    const main = document.createElement('button');
    main.className = 'bm-main';
    const title = document.createElement('div');
    title.className = 'bm-title';
    title.textContent = bm.title;
    const preview = document.createElement('div');
    preview.className = 'bm-preview';
    preview.textContent = bm.preview;
    const time = document.createElement('div');
    time.className = 'bm-time';
    time.textContent = fmtTime(bm.time);
    main.append(title, preview, time);
    main.addEventListener('click', () => jumpToBookmark(bm));

    const edit = document.createElement('button');
    edit.className = 'btn tiny';
    edit.textContent = '✎';
    edit.title = '重命名书签';
    edit.addEventListener('click', () => startBookmarkRename(i, title));

    const del = document.createElement('button');
    del.className = 'btn tiny';
    del.textContent = '×';
    del.title = '删除书签';
    del.addEventListener('click', () => removeBookmark(i));

    row.append(main, edit, del);
    frag.append(row);
  });
  el.bookmarkList.append(frag);
}

/* ================= 划线 ================= */

/** 选区 → 全局字符偏移；标题或选空返回 null（每段 p 只有单一文本子节点，startContainer 必是它） */
function selectionToOffsets() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const ps = r.startContainer.parentElement?.closest('p[data-i]');
  const pe = r.endContainer.parentElement?.closest('p[data-i]');
  if (!ps || !pe) return null;
  const a = state.paras[Number(ps.dataset.i)];
  const b = state.paras[Number(pe.dataset.i)];
  if (!a || !b) return null;
  const start = a.rawStart + Math.min(r.startOffset, a.len);
  const end = b.rawStart + Math.min(r.endOffset, b.len);
  return end > start ? { start, end: Math.min(end, state.text.length) } : null;
}

/** (x,y) 处的划线（右键「取消划线」用）；Chromium 的 caretRangeFromPoint 与新标准都兜上 */
function highlightIdAtPoint(x, y) {
  if (state.kind !== 'txt' || !state.text.length) return null;
  const pos = document.caretRangeFromPoint?.(x, y) ?? document.caretPositionFromPoint?.(x, y);
  const node = pos?.startContainer ?? pos?.offsetNode;
  if (!node) return null;
  const p = node.parentElement?.closest('p[data-i]');
  const para = p && state.paras[Number(p.dataset.i)];
  if (!para) return null;
  const off = para.rawStart + (pos.startOffset ?? pos.offset ?? 0);
  return (state.book.highlights ?? []).find((h) => off >= h.start && off < h.end) ?? null;
}

function markAddFromSelection() {
  if (state.kind === 'pdf') return toast('PDF 原样渲染，暂不支持划线');
  const r = selectionToOffsets();
  if (!r) return toast('请先选中正文文字');
  const list = [...(state.book.highlights ?? []), { id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, start: r.start, end: r.end, time: Date.now() }];
  state.book.highlights = list.slice(-200);
  api.saveHighlights(state.file.path, state.book.highlights);
  renderHighlights();
  renderMarks();
  toast('已划线');
}

function markRemove(id) {
  state.book.highlights = (state.book.highlights ?? []).filter((h) => h.id !== id);
  api.saveHighlights(state.file.path, state.book.highlights);
  renderHighlights();
  renderMarks();
}

/** 重建 CSS Highlight：把与当前章相交的每条划线按段落拆成 Range（复用 locate 正向映射） */
function renderHighlights() {
  try {
    window.CSS?.highlights?.delete('marks');
    if (state.kind !== 'txt') return;
    const ranges = [];
    for (const h of state.book.highlights ?? []) {
      for (const p of state.paras) {
        const s = Math.max(h.start, p.rawStart);
        const e = Math.min(h.end, p.rawStart + p.len);
        if (e <= s) continue;
        const hit = locate(s, e - s);
        if (hit?.range) ranges.push(hit.range);
      }
    }
    if (ranges.length) window.CSS.highlights.set('marks', new Highlight(...ranges));
  } catch {
    /* 高亮 API 不可用时静默降级 */
  }
}

function renderMarks() {
  const list = state.kind === 'txt' ? state.book.highlights ?? [] : [];
  el.markList.replaceChildren();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.style.padding = '8px 4px';
    p.textContent = '暂无划线。选中正文后按 Ctrl+H 或右键「划线」。';
    el.markList.append(p);
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach((h) => {
    const row = document.createElement('div');
    row.className = 'bm-row'; // 复用书签行样式
    const main = document.createElement('button');
    main.className = 'bm-main';
    const preview = document.createElement('div');
    preview.className = 'bm-preview';
    preview.textContent = state.text.slice(h.start, h.end).slice(0, 60);
    const time = document.createElement('div');
    time.className = 'bm-time';
    time.textContent = fmtTime(h.time);
    main.append(preview, time);
    main.addEventListener('click', () => jumpToOffset(h.start, h.end - h.start)); // 自带 Alt+← 历史
    const del = document.createElement('button');
    del.className = 'btn tiny';
    del.textContent = '×';
    del.title = '删除划线';
    del.addEventListener('click', () => markRemove(h.id));
    row.append(main, del);
    frag.append(row);
  });
  el.markList.append(frag);
}

function jumpToBookmark(bm) {
  pushJumpHistory();
  if (state.kind === 'pdf') {
    state.pdf?.goToPage(bm.page ?? 0);
    return;
  }
  gotoChapter(bm.chapterIndex ?? 0, bm.ratio ?? 0, { save: false });
  const node = el.flow.querySelector(`p[data-i="${bm.paraIndex ?? 0}"]`);
  if (!node) return;
  if (state.settings.mode === 'paged') setPage(pageOf(node));
  else node.scrollIntoView({ block: 'center' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1600);
}

/* ================= 查找 ================= */

function clearHighlight() {
  try {
    window.CSS?.highlights?.delete('search');
  } catch {
    /* 忽略 */
  }
}

/** PDF 全文查找是异步逐页扫描的：token 丢弃过期结果，busy 区分「还在扫」与「真的没命中」 */
let pdfSearchToken = 0;
let pdfSearchBusy = false;

async function computePdfMatches(query, firstDir) {
  const q = (query ?? '').trim();
  state.search = { query: q, matches: [], cursor: -1 };
  if (!state.pdf || !q) {
    el.searchCount.textContent = '';
    return;
  }
  const token = ++pdfSearchToken;
  pdfSearchBusy = true;
  el.searchCount.textContent = '查找中…';
  try {
    const { count } = await state.pdf.search(q);
    if (token !== pdfSearchToken) return;
    if (!count) {
      el.searchCount.textContent = '无结果';
      return;
    }
    await pdfSearchStep(firstDir);
  } finally {
    if (token === pdfSearchToken) pdfSearchBusy = false;
  }
}

async function pdfSearchStep(dir) {
  if (!state.pdf) return;
  const token = ++pdfSearchToken;
  const { index, count } = await state.pdf.stepSearch(dir);
  if (token !== pdfSearchToken) return;
  if (!count) {
    // 扫描还没结束就先按了 Enter：不要谎报"无结果"
    el.searchCount.textContent = pdfSearchBusy ? '查找中…' : state.search.query ? '无结果' : '';
    return;
  }
  el.searchCount.textContent = `${index + 1}/${count} 处`;
}

function computeMatches(query, firstDir = 1) {
  const q = (query ?? '').trim();
  if (state.kind === 'pdf') return computePdfMatches(q, firstDir);
  state.search.query = q;
  state.search.matches = [];
  state.search.cursor = -1;
  clearHighlight();
  if (!q || !state.text) {
    el.searchCount.textContent = '';
    return;
  }
  const hay = state.text.toLowerCase();
  const needle = q.toLowerCase();
  const matches = [];
  let from = 0;
  while (matches.length < 2000) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    matches.push(at);
    from = at + Math.max(1, needle.length);
  }
  state.search.matches = matches;
  el.searchCount.textContent = matches.length ? `${matches.length} 处` : '无结果';
  if (matches.length) searchStep(firstDir);
}

function searchStep(dir) {
  if (state.kind === 'pdf') return pdfSearchStep(dir);
  const m = state.search.matches;
  if (!m.length) {
    if (state.search.query) el.searchCount.textContent = '无结果';
    return;
  }
  state.search.cursor = (state.search.cursor + dir + m.length) % m.length;
  jumpToOffset(m[state.search.cursor], state.search.query.length);
  el.searchCount.textContent = `${state.search.cursor + 1}/${m.length} 处`;
}

function chapterIndexAt(abs) {
  let lo = 0;
  let hi = state.chapters.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.chapters[mid].bodyStart <= abs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 返回 { el, range } —— range 可能为 null（命中的字符落在被裁掉的首尾空白里）。 */
function locate(abs, len) {
  const paras = state.paras;
  let lo = 0;
  let hi = paras.length - 1;
  let pi = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (paras[mid].rawStart <= abs) {
      pi = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (pi < 0) return null;
  const p = paras[pi];
  const node = el.flow.querySelector(`p[data-i="${pi}"]`);
  if (!node?.firstChild) return null;
  const local = abs - p.rawStart;
  if (local < 0 || local >= p.len) return { el: node, range: null };
  const range = document.createRange();
  range.setStart(node.firstChild, local);
  range.setEnd(node.firstChild, Math.min(p.len, local + len));
  return { el: node, range };
}

function pageOf(node) {
  const rect = node.getBoundingClientRect();
  const flowRect = el.flow.getBoundingClientRect();
  const contentX = rect.left - flowRect.left + el.flow.scrollLeft;
  return Math.round(contentX / (state.layout.pageW + state.layout.gap));
}

function jumpToOffset(abs, len) {
  pushJumpHistory();
  const ci = chapterIndexAt(abs);
  if (ci !== state.index) gotoChapter(ci, 0, { save: false });
  const hit = locate(abs, len);
  if (hit?.range) {
    try {
      window.CSS?.highlights?.set('search', new Highlight(hit.range));
    } catch {
      /* 忽略 */
    }
  }
  if (state.settings.mode === 'paged') {
    if (hit?.el) setPage(pageOf(hit.el));
  } else if (hit?.el) {
    hit.el.scrollIntoView({ block: 'center' });
    el.viewport.scrollTop -= Math.round(el.viewport.clientHeight * 0.12);
  }
  updateStatus();
  scheduleSaveProgress();
}

/* ================= 状态栏 / 进度 ================= */

/** 按全书比例跳转：TXT 换算成章内偏移复用 gotoChapter，PDF 等比跳页 */
function seekByRatio(pct) {
  const p = clamp(pct, 0, 1);
  if (state.kind === 'pdf') {
    state.pdf?.goToPage(Math.round(p * (Math.max(1, state.pages) - 1)));
    return;
  }
  if (!state.text.length) return;
  const abs = Math.round(p * state.text.length);
  const ci = chapterIndexAt(abs);
  const ch = state.chapters[ci];
  const ratio = ch && ch.end > ch.bodyStart ? clamp((abs - ch.bodyStart) / (ch.end - ch.bodyStart), 0, 1) : 0;
  gotoChapter(ci, ratio);
}

/** 窗口标题跟随内容：文件名 · 章节（PDF 为页码） */
function updateWindowTitle() {
  if (!state.file) {
    document.title = 'TXT 阅读器';
    return;
  }
  if (state.kind === 'pdf') {
    const pages = Math.max(1, state.pages);
    document.title = `${state.file.name} · 第 ${clamp(state.page, 0, pages - 1) + 1}/${pages} 页`;
    return;
  }
  const ch = state.chapters[state.index];
  document.title = ch ? `${state.file.name} · ${ch.title}` : state.file.name;
}

function updateStatus() {
  if (!state.file) return updateWindowTitle();
  if (state.kind === 'pdf') return updatePdfStatus();
  const ch = state.chapters[state.index];
  el.statusChapter.textContent = ch ? ch.title : '';
  const pct = state.text.length && ch ? (ch.bodyStart + currentRatio() * (ch.end - ch.bodyStart)) / state.text.length : 0;
  const shown = clamp(pct, 0, 1);
  el.statusProgress.textContent = `${(shown * 100).toFixed(1)}%`;
  el.progressFill.style.width = `${(shown * 100).toFixed(2)}%`;
  el.statusMeta.textContent = state.file
    ? `第 ${state.index + 1}/${state.chapters.length} 章 · ${fmtNum(state.wordCount)}字 · ${state.encoding.toUpperCase()}${readMetaSuffix()}`
    : '';
  updateWindowTitle();
}

function updatePdfStatus() {
  const pages = Math.max(1, state.pages);
  const page = clamp(state.page, 0, pages - 1);
  const pct = ((page + 1) / pages) * 100;
  el.statusChapter.textContent = pdfTitleAt(page);
  el.statusProgress.textContent = `${pct.toFixed(1)}%`;
  el.progressFill.style.width = `${pct.toFixed(2)}%`;
  el.statusMeta.textContent = `PDF ${pages} 页 · ${fmtBytes(state.file?.size ?? 0)} · 第 ${page + 1} 页 · ${Math.round((state.pdf?.scale ?? 1) * 100)}%${readMetaSuffix()}`;
  el.viewport.dataset.page = String(page);
  el.viewport.dataset.pages = String(pages);
  updateWindowTitle();
}

function progressSnapshot() {
  if (state.kind === 'pdf') {
    const pages = Math.max(1, state.pages);
    // 复用同一套持久化字段：chapterIndex 存页号，percent 存全书进度
    return {
      chapterIndex: state.page,
      ratio: 0,
      percent: Number(((state.page + 1) / pages).toFixed(4)),
      readMsDelta: readAccum,
    };
  }
  const ch = state.chapters[state.index];
  const ratio = currentRatio();
  const abs = ch ? ch.bodyStart + ratio * (ch.end - ch.bodyStart) : 0;
  return {
    chapterIndex: state.index,
    ratio: Number(ratio.toFixed(4)),
    percent: Number((state.text.length ? abs / state.text.length : 0).toFixed(4)),
    readMsDelta: readAccum,
  };
}

function scheduleSaveProgress() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgressNow, 900);
}

function saveProgressNow() {
  if (!state.file) return;
  api.saveProgress(state.file.path, progressSnapshot());
  state.book.readMs = (state.book.readMs ?? 0) + readAccum; // 显示用：内存镜像已落盘的时长
  readAccum = 0;
}

/* ================= 抽屉 / 欢迎页 ================= */

function toggleDrawer(name) {
  const target = name === 'toc' ? el.toc : name === 'bookmarks' ? el.bookmarks : name === 'marks' ? el.marks : el.settings;
  const willShow = target.hidden;
  for (const d of [el.toc, el.settings, el.bookmarks, el.marks]) d.hidden = true;
  target.hidden = !willShow;
  if (name === 'toc') syncTocActive();
}

function closeAllDrawers() {
  let any = false;
  for (const d of [el.toc, el.settings, el.bookmarks, el.marks]) {
    if (!d.hidden) any = true;
    d.hidden = true;
  }
  return any;
}

/** 关闭当前书返回欢迎页/书架；进度与阅读时长先落盘 */
function closeBook() {
  if (!el.body.classList.contains('has-file')) return;
  saveProgressNow(); // 必须在清 state.file 之前（其内部 guard !state.file）
  clearTimeout(saveTimer);
  stopAutoRead({ silent: true });
  closePdf(); // PDF：销毁视图+中止查找+关密码框；TXT：只关残留密码框，no-op
  jumpHistory.length = 0;
  Object.assign(state, {
    kind: 'txt', pdf: null, page: 0, pages: 0, file: null, text: '',
    chapters: [], index: 0, paras: [], wordCount: 0, encoding: 'auto',
    search: { query: '', matches: [], cursor: -1 },
  });
  state.book = { encoding: 'auto', chapterIndex: 0, ratio: 0, bookmarks: [] };
  el.searchInput.value = '';
  el.searchCount.textContent = '';
  el.flow.replaceChildren();
  el.flow.hidden = false;
  el.viewport.scrollTop = 0;
  delete el.viewport.dataset.page;
  delete el.viewport.dataset.pages;
  el.fileName.textContent = '';
  el.encLabel.hidden = true;
  closeAllDrawers();
  el.body.classList.remove('has-file');
  el.body.dataset.kind = 'txt';
  // 状态栏清空到与启动时一致（updateStatus 对无文件是 no-op）
  el.statusChapter.textContent = '';
  el.statusProgress.textContent = '';
  el.statusMeta.textContent = '';
  el.progressFill.style.width = '0%';
  updateWindowTitle(); // state.file 为 null → document.title = 'TXT 阅读器'
  renderShelfRoot();   // 书架重置到根视图（进度百分比由下次进入目录时重扫）
  api.getState().then((st) => {
    state.recent = st?.recent ?? [];
    renderRecent();
  });
}

function renderRecent() {
  el.recentList.replaceChildren();
  if (!state.recent.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = '还没有阅读记录';
    el.recentList.append(p);
    return;
  }
  const frag = document.createDocumentFragment();
  state.recent.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'recent-item';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = r.name;
    name.title = r.path;
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    const rel = relTime(r.at);
    const pct = `${Math.round((r.percent ?? 0) * 100)}%`;
    meta.textContent = `${pct} · ${fmtNum(r.size ?? 0)} 字节${rel ? ` · ${rel}` : ''}`;
    const del = document.createElement('button');
    del.className = 'btn tiny recent-remove';
    del.textContent = '×';
    del.title = '从列表移除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.recent = await api.removeRecent(r.path);
      renderRecent();
    });
    row.append(name, meta, del);
    row.addEventListener('click', () => openPath(r.path));
    frag.append(row);
  });
  el.recentList.append(frag);
}

/* ================= 书架（多文件夹，逐层懒扫描） ================= */

/** 书架右键选中的行（主进程菜单命令回推时定位目标） */
function ctxTarget() {
  const r = document.querySelector('.shelf-row.ctx');
  return r ? { path: r.dataset.path, type: r.dataset.type } : null;
}

function clearCtx() {
  document.querySelector('.shelf-row.ctx')?.classList.remove('ctx');
}

/** 书架根视图：已添加的文件夹列表（📁 行 + 移除 ×），meta 由 shelf:stat 异步补齐 */
async function renderShelfRoot() {
  shelfCurrent = '';
  el.shelfUp.hidden = true;
  el.shelfRefresh.hidden = true;
  const list = state.settings.shelfDirs ?? [];
  const frag = document.createDocumentFragment();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = '书架空空如也，点「添加文件夹」把小说目录加进来（TXT / PDF）。';
    el.shelfList.replaceChildren(p);
    return;
  }
  for (const dir of list) {
    const r = document.createElement('div');
    r.className = 'shelf-row';
    r.dataset.path = dir;
    r.dataset.type = 'dir-root';
    const n = document.createElement('span');
    n.className = 'shelf-name';
    n.textContent = `📁 ${dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}`;
    const m = document.createElement('span');
    m.className = 'shelf-meta';
    m.textContent = '…';
    r.title = dir;
    const del = document.createElement('button');
    del.className = 'btn tiny';
    del.textContent = '×';
    del.title = '从书架移除（不删除磁盘文件）';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      updateSettings({ shelfDirs: (state.settings.shelfDirs ?? []).filter((d) => d !== dir) });
      renderShelfRoot();
    });
    r.append(n, m, del);
    r.addEventListener('click', () => scanShelfInto(dir));
    frag.append(r);
  }
  el.shelfList.replaceChildren(frag);
  // meta 异步补齐；期间若已切走视图或又重渲染，丢弃本次结果
  const req = ++shelfRootReq;
  const stats = await api.shelfStat(list);
  if (req !== shelfRootReq || shelfCurrent !== '') return;
  for (const r of el.shelfList.querySelectorAll('.shelf-row')) {
    const m = r.querySelector('.shelf-meta');
    if (!m) continue;
    const info = stats?.[r.dataset.path];
    if (!info) {
      m.textContent = '文件夹已不存在';
      r.title = `${r.dataset.path}（目录已不存在，右键可移除）`;
      continue;
    }
    m.textContent = !info.count
      ? '空文件夹'
      : info.last
        ? `${info.count} 本 · 最近在读 ${info.last.name} ${Math.round((info.last.percent ?? 0) * 100)}%`
        : `${info.count} 本`;
  }
}

/** 把目录加入书架（去重；已在书架时提示） */
function addToShelf(dir) {
  const cur = new Set(state.settings.shelfDirs ?? []);
  if (cur.has(dir)) return toast('该文件夹已在书架中');
  updateSettings({ shelfDirs: [...(state.settings.shelfDirs ?? []), dir] });
  renderShelfRoot();
  toast(`已加入书架：${dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}`);
}

async function scanShelfInto(dir) {
  const res = await api.scanShelf(dir);
  if (res?.error) return toast(res.error, true);
  shelfCurrent = res.dir; // ponytail: 不虚拟化，全量渲染；书库过万条再做虚拟列表
  renderShelf(res);
}

function renderShelf(res) {
  el.shelfUp.hidden = false;
  el.shelfRefresh.hidden = false;
  const frag = document.createDocumentFragment();
  if (!res.dirs.length && !res.files.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = '此目录没有 TXT / PDF 文件';
    el.shelfList.replaceChildren(p);
    return;
  }
  const row = (label, name, meta, target, onClick) => {
    const r = document.createElement('div');
    r.className = 'shelf-row';
    r.dataset.path = target.path;
    r.dataset.type = target.type;
    const n = document.createElement('span');
    n.className = 'shelf-name';
    n.textContent = `${label} ${name}`;
    const m = document.createElement('span');
    m.className = 'shelf-meta';
    m.textContent = meta;
    r.append(n, m);
    r.addEventListener('click', onClick);
    frag.append(r);
  };
  for (const d of res.dirs) row('📁', d.name, '', { path: d.path, type: 'dir' }, () => scanShelfInto(d.path));
  for (const f of res.files) row('📄', f.name, `${fmtBytes(f.size)}${f.percent > 0 ? ` · ${Math.round(f.percent * 100)}%` : ''}`, { path: f.path, type: 'file' }, () => openPath(f.path));
  el.shelfList.replaceChildren(frag);
}

/* ================= 命令 / 事件 ================= */

function handleCommand(cmd, payload) {
  switch (cmd) {
    case 'open':
      openDialog();
      break;
    case 'open-recent':
      openPath(payload);
      break;
    case 'clear-recent':
      api.clearRecent().then((list) => {
        state.recent = list;
        renderRecent();
      });
      break;
    case 'reload':
      if (state.kind === 'pdf') {
        toast('PDF 原样渲染，无需按编码重新加载');
        break;
      }
      if (state.file) openPath(state.file.path, el.encSelect.value);
      break;
    case 'reveal':
      if (state.file) api.reveal(state.file.path);
      break;
    case 'toc':
      toggleDrawer('toc');
      break;
    case 'bookmark':
      addBookmark();
      break;
    case 'bookmarks':
      toggleDrawer('bookmarks');
      break;
    case 'marks':
      toggleDrawer('marks');
      break;
    case 'mark-add':
      markAddFromSelection();
      break;
    case 'mark-remove':
      if (payload) markRemove(String(payload));
      break;
    case 'auto-read':
      toggleAutoRead();
      break;
    case 'always-on-top':
      updateSettings({ alwaysOnTop: !state.settings.alwaysOnTop });
      toast(state.settings.alwaysOnTop ? '已取消置顶' : '已置顶');
      break;
    case 'settings':
      toggleDrawer('settings');
      break;
    case 'find':
      el.searchInput.focus();
      el.searchInput.select();
      break;
    case 'next-chapter':
      nextChapter();
      break;
    case 'prev-chapter':
      prevChapter();
      break;
    case 'mode':
      updateSettings({ mode: payload === 'scroll' ? 'scroll' : 'paged' });
      break;
    case 'theme': {
      const next = THEMES.some((t) => t.id === payload) ? payload : cycleTheme(state.settings.theme);
      updateSettings({ theme: next });
      break;
    }
    case 'font':
      if (state.kind === 'pdf') zoomPdf((payload > 0 ? 1 : -1) * PDF_SCALE.step);
      else updateSettings({ fontSize: clamp(state.settings.fontSize + (payload > 0 ? 1 : -1), 12, 40) });
      break;
    case 'help':
      el.settings.hidden = false;
      el.shortcuts.hidden = false;
      el.usage.hidden = true;
      break;
    case 'usage':
      el.settings.hidden = false;
      el.usage.hidden = false;
      el.shortcuts.hidden = true; // 两个帮助块互斥，一次只看一种
      break;
    case 'shelf-reveal': {
      const t = ctxTarget();
      if (t?.path) api.reveal(t.path);
      clearCtx();
      break;
    }
    case 'shelf-refresh': {
      const t = ctxTarget();
      if (t?.path) {
        if (t.type === 'dir-root') renderShelfRoot();
        else if (t.type === 'dir') scanShelfInto(t.path);
        else scanShelfInto(shelfCurrent || t.path); // file 行：刷新其所在目录
      }
      clearCtx();
      break;
    }
    case 'shelf-remove': {
      const t = ctxTarget();
      if (t?.path) {
        if (t.type === 'dir-root') {
          updateSettings({ shelfDirs: (state.settings.shelfDirs ?? []).filter((d) => d !== t.path) });
          renderShelfRoot();
        } else {
          toast('只有书架根的文件夹可以移除');
        }
      }
      clearCtx();
      break;
    }
    default:
      break;
  }
}

function cycleTheme(current) {
  const i = THEMES.findIndex((t) => t.id === current);
  return THEMES[(i + 1) % THEMES.length].id;
}

function isTypingTarget(t) {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function bindUI() {
  $('#btn-open').addEventListener('click', openDialog);
  $('#btn-open-2').addEventListener('click', openDialog);
  $('#btn-toc').addEventListener('click', () => toggleDrawer('toc'));
  $('#btn-marks').addEventListener('click', () => toggleDrawer('marks'));
  $('#btn-bookmarks').addEventListener('click', () => toggleDrawer('bookmarks'));
  $('#btn-add-bookmark').addEventListener('click', addBookmark);
  $('#btn-settings').addEventListener('click', () => toggleDrawer('settings'));
  el.btnMode.addEventListener('click', () => updateSettings({ mode: state.settings.mode === 'paged' ? 'scroll' : 'paged' }));
  el.btnTheme.addEventListener('click', () => updateSettings({ theme: cycleTheme(state.settings.theme) }));
  $('#btn-clear-bookmarks').addEventListener('click', () => {
    if (!state.file) return;
    state.book.bookmarks = [];
    api.saveBookmarks(state.file.path, []);
    renderBookmarks();
  });

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => {
      const name = btn.dataset.close;
      (name === 'toc' ? el.toc : name === 'bookmarks' ? el.bookmarks : name === 'marks' ? el.marks : el.settings).hidden = true;
    });
  }

  el.tocList.addEventListener('click', (e) => {
    const li = e.target.closest('.toc-item');
    if (!li) return;
    pushJumpHistory();
    if (state.kind === 'pdf') state.pdf?.goToPage(Number(li.dataset.page));
    else gotoChapter(Number(li.dataset.i), 0);
    el.toc.hidden = true;
  });

  el.settings.querySelector('#set-theme').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    if (b.dataset.theme === 'custom' && !THEME_BASE_IDS.includes(state.settings.customThemeBase)) {
      // 首次切入自定义：拿当前主题做基座复制一版
      updateSettings({ theme: 'custom', customThemeBase: THEME_BASE_IDS.includes(state.settings.theme) ? state.settings.theme : 'sepia' });
    } else {
      updateSettings({ theme: b.dataset.theme });
    }
  });
  el.settings.querySelector('#set-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) updateSettings({ mode: b.dataset.mode });
  });
  el.fontCjkInput.addEventListener('change', () => updateSettings({ fontCjk: el.fontCjkInput.value }));
  el.fontLatinInput.addEventListener('change', () => updateSettings({ fontLatin: el.fontLatinInput.value }));
  el.customBaseSelect.addEventListener('change', () => updateSettings({ customThemeBase: el.customBaseSelect.value }, { relayoutNow: false }));
  for (const input of el.customColorInputs) {
    input.addEventListener('input', () =>
      updateSettings({ customThemeColors: { ...state.settings.customThemeColors, [input.dataset.var]: input.value } }, { relayoutNow: false }),
    );
  }
  el.customReset.addEventListener('click', () => updateSettings({ customThemeColors: {} }, { relayoutNow: false }));
  el.fontSize.addEventListener('input', () => updateSettings({ fontSize: Number(el.fontSize.value) }, { relayoutNow: false }));
  el.fontSize.addEventListener('change', () => relayout({ preserve: true }));
  el.lineHeight.addEventListener('input', () => updateSettings({ lineHeight: Number(el.lineHeight.value) }, { relayoutNow: false }));
  el.lineHeight.addEventListener('change', () => relayout({ preserve: true }));
  el.letterSpacing.addEventListener('input', () => updateSettings({ letterSpacing: Number(el.letterSpacing.value) }, { relayoutNow: false }));
  el.letterSpacing.addEventListener('change', () => relayout({ preserve: true }));
  el.contentWidth.addEventListener('input', () => updateSettings({ contentWidth: Number(el.contentWidth.value) }, { relayoutNow: false }));
  el.contentWidth.addEventListener('change', () => relayout({ preserve: true }));
  el.justify.addEventListener('change', () => updateSettings({ justify: el.justify.checked }, { relayoutNow: false }));
  el.restToggle.addEventListener('change', () => updateSettings({ restReminder: el.restToggle.checked }));
  el.autoSpeed.addEventListener('input', () => updateSettings({ autoScrollSpeed: Number(el.autoSpeed.value) }, { relayoutNow: false }));
  el.shelfRefresh.addEventListener('click', () => (shelfCurrent ? scanShelfInto(shelfCurrent) : renderShelfRoot()));
  el.backShelf.addEventListener('click', () => closeBook());
  el.shelfAdd.addEventListener('click', async () => {
    const picked = await api.pickShelfDirs();
    if (!picked?.length) return;
    picked.forEach(addToShelf);
  });
  el.shelfUp.addEventListener('click', () => {
    const roots = state.settings.shelfDirs ?? [];
    if (!shelfCurrent || roots.includes(shelfCurrent)) return renderShelfRoot(); // 已在某个书架文件夹：返回书架根
    const parent = shelfCurrent.replace(/[\\/][^\\/]+$/, '');
    if (parent && parent !== shelfCurrent) scanShelfInto(parent);
    else renderShelfRoot();
  });
  $('#btn-reload').addEventListener('click', () => {
    if (state.file) openPath(state.file.path, el.encSelect.value);
  });
  $('#btn-reset-settings').addEventListener('click', () => updateSettings({ ...DEFAULT_SETTINGS }));

  el.searchInput.addEventListener('input', () => {
    clearTimeout(el.searchInput._t);
    el.searchInput._t = setTimeout(() => computeMatches(el.searchInput.value), 350);
  });
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = el.searchInput.value;
      if (q !== state.search.query) computeMatches(q, e.shiftKey ? -1 : 1);
      else searchStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      el.searchInput.blur();
      clearHighlight();
      el.searchCount.textContent = '';
      if (state.kind === 'pdf') state.pdf?.search('');
    }
  });
  $('#search-next').addEventListener('click', () => searchStep(1));
  $('#search-prev').addEventListener('click', () => searchStep(-1));

  // 进度条：按下即跳，拖动只预览填充条，松手按最终位置再跳
  let scrubbing = false;
  el.progressTrack.addEventListener('pointerdown', (e) => {
    if (autoReading) stopAutoRead();
    if (!state.file) return;
    e.preventDefault();
    try {
      el.progressTrack.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件无活动指针 */
    }
    scrubbing = true;
    const r = el.progressTrack.getBoundingClientRect();
    el.progressFill.style.width = `${(clamp((e.clientX - r.left) / r.width, 0, 1) * 100).toFixed(2)}%`;
    pushJumpHistory();
    seekByRatio((e.clientX - r.left) / r.width);
  });
  el.progressTrack.addEventListener('pointermove', (e) => {
    const r = el.progressTrack.getBoundingClientRect();
    const pct = clamp((e.clientX - r.left) / r.width, 0, 1);
    if (scrubbing) {
      el.progressFill.style.width = `${(pct * 100).toFixed(2)}%`;
      return;
    }
    if (!state.file) return;
    el.progressTrack.title = state.kind === 'pdf'
      ? `第 ${Math.round(pct * (Math.max(1, state.pages) - 1)) + 1} / ${Math.max(1, state.pages)} 页`
      : state.text.length
        ? `${state.chapters[chapterIndexAt(Math.round(pct * state.text.length))]?.title ?? ''} · ${Math.round(pct * 100)}%`
        : '';
  });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    const r = el.progressTrack.getBoundingClientRect();
    seekByRatio((e.clientX - r.left) / r.width);
  };
  el.progressTrack.addEventListener('pointerup', endScrub);
  el.progressTrack.addEventListener('pointercancel', () => {
    scrubbing = false;
    updateStatus(); // 拖动只预览填充条，取消后按真实位置恢复
  });

  // 全屏沉浸：顶部/底部 36px 触发、72px 释放（滞回防闪烁），不做定时器
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) el.body.classList.remove('fs-reveal-top', 'fs-reveal-bottom');
    // 全屏切换显式重排：Windows + 无框标题栏下 ResizeObserver 可能漏报尺寸变化（TXT 走 measure，PDF 走 pdf.relayout）
    setTimeout(() => relayout({ preserve: true }), 60);
    setTimeout(() => relayout({ preserve: true }), 350);
  });
  window.addEventListener('mousemove', (e) => {
    lastActivityAt = Date.now();
    if (!document.fullscreenElement) return;
    const y = e.clientY;
    const h = window.innerHeight;
    if (y <= 36) el.body.classList.add('fs-reveal-top');
    else if (y > 72) el.body.classList.remove('fs-reveal-top');
    if (y >= h - 36) el.body.classList.add('fs-reveal-bottom');
    else if (y < h - 72) el.body.classList.remove('fs-reveal-bottom');
  });

  // 翻页模式：点击左右两侧翻页（不影响选中文字）
  el.viewport.addEventListener('click', (e) => {
    lastActivityAt = Date.now();
    if (autoReading) stopAutoRead();
    if (state.settings.mode !== 'paged' || !state.file) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const rect = el.viewport.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x > 0.68) nextPage();
    else if (x < 0.32) prevPage();
  });

  // 鼠标侧键：XButton1(3)=后退=上一页，XButton2(4)=前进=下一页（浏览器惯例）
  el.viewport.addEventListener('mouseup', (e) => {
    if (autoReading) stopAutoRead();
    if (!state.file) return;
    if (e.button === 3) prevPage();
    else if (e.button === 4) nextPage();
  });

  // 右键菜单：选区/划线命中在渲染侧算好，菜单由主进程弹出
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const shelfRow = e.target.closest?.('.shelf-row');
    if (shelfRow && !el.body.classList.contains('has-file')) {
      clearCtx();
      shelfRow.classList.add('ctx');
      api.showContextMenu({ x: e.clientX, y: e.clientY, shelf: true });
      return;
    }
    const sel = window.getSelection();
    const hasSelection = !!sel && !sel.isCollapsed;
    const editable = !!e.target.closest('input, textarea');
    const mark = state.kind === 'txt' && hasSelection ? selectionToOffsets() : null;
    const hit = state.kind === 'txt' ? highlightIdAtPoint(e.clientX, e.clientY) : null;
    api.showContextMenu({ x: e.clientX, y: e.clientY, hasSelection, editable, mark, hlId: hit?.id ?? null });
  });

  el.viewport.addEventListener('wheel', (e) => {
    lastActivityAt = Date.now();
    if (autoReading) stopAutoRead();
    if (!state.file) return;
    if (e.ctrlKey) {
      e.preventDefault();
      if (Date.now() < wheelLockUntil) return;
      wheelLockUntil = Date.now() + 80;
      const dir = (e.deltaY || e.deltaX) < 0 ? 1 : -1;
      if (state.kind === 'pdf') {
        zoomPdf(0.1 * dir); // 含边界夹取与 toast
      } else {
        const next = clamp(state.settings.fontSize + dir, 12, 40);
        if (next === state.settings.fontSize) toast(dir > 0 ? '已到最大字号' : '已到最小字号');
        else {
          updateSettings({ fontSize: next });
          toast(`字号 ${next}px`);
        }
      }
      return;
    }
    if (state.settings.mode === 'paged') {
      e.preventDefault();
      const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (Math.abs(d) < 10 || Date.now() < wheelLockUntil) return;
      wheelLockUntil = Date.now() + 180;
      if (d > 0) nextPage();
      else prevPage();
    } else if (e.deltaY > 0 && atBottom()) {
      if (Date.now() < wheelLockUntil) return;
      wheelLockUntil = Date.now() + 400;
      nextChapter();
    }
  }, { passive: false });

  el.viewport.addEventListener('scroll', () => {
    if (state.kind === 'pdf') {
      state.pdf?.syncFromScroll();
      return;
    }
    if (state.settings.mode === 'scroll') {
      updateStatus();
      scheduleSaveProgress();
    }
  });

  window.addEventListener('keydown', (e) => {
    lastActivityAt = Date.now();
    if (e.key === 'Escape' && !el.pwModal.hidden) {
      e.preventDefault();
      closePasswordDialog(null);
      return;
    }
    if (e.key === 'Escape') {
      const hadDrawer = closeAllDrawers();
      if (isTypingTarget(e.target)) {
        e.target.blur();
        return;
      }
      if (hadDrawer || document.fullscreenElement) return; // 全屏时 Esc 只退全屏（原生），面板照旧关
      if (el.body.classList.contains('has-file')) closeBook();
      return;
    }
    if (isTypingTarget(e.target) || !state.file) return;
    if (autoReading && (e.key === '+' || e.key === '=' || e.key === '-')) {
      e.preventDefault();
      const d = e.key === '-' ? -10 : 10;
      updateSettings({ autoScrollSpeed: clamp(state.settings.autoScrollSpeed + d, 20, 200) });
      toast(`自动阅读 ${state.settings.autoScrollSpeed}px/s`);
      return;
    }
    if (e.key !== 'F5') stopAutoRead({ silent: true }); // F5 走菜单 accelerator，不进 keydown
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      goBackJump();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      markAddFromSelection();
      return;
    }
    if (state.kind === 'pdf' && (e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      resetPdfZoom();
      return;
    }
    const paged = state.settings.mode === 'paged';
    switch (e.key) {
      case 'ArrowRight':
        if (paged) {
          e.preventDefault();
          nextPage();
        }
        break;
      case 'ArrowLeft':
        if (paged) {
          e.preventDefault();
          prevPage();
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (paged) nextPage();
        else if (atBottom()) nextChapter();
        else el.viewport.scrollBy({ top: 80 });
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (paged) prevPage();
        else if (atTop()) prevChapter();
        else el.viewport.scrollBy({ top: -80 });
        break;
      case 'PageDown':
      case ' ':
        e.preventDefault();
        nextPage();
        break;
      case 'PageUp':
        e.preventDefault();
        prevPage();
        break;
      case 'Home':
        e.preventDefault();
        pushJumpHistory();
        if (state.kind === 'pdf') state.pdf?.goToPage(0);
        else gotoChapter(0, 0);
        break;
      case 'End':
        e.preventDefault();
        pushJumpHistory();
        if (state.kind === 'pdf') state.pdf?.goToPage(state.pages - 1);
        else gotoChapter(state.chapters.length - 1, 0);
        break;
      default:
        break;
    }
  });

  // 拖拽打开
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) el.body.classList.remove('dragging');
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.body.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const p = api.droppedPath(file);
    if (!p) return toast('无法识别拖入的文件', true);
    const res = await api.scanShelf(p); // 能当目录读 → 加入书架；否则按文件打开
    if (!res?.error) return addToShelf(p);
    openPath(p);
  });

  // 久坐提醒 + 阅读时长：每 30s 检查（判定逻辑在 shared/settings.js 的 restReminderDue，可单测）
  setInterval(() => {
    const now = Date.now();
    const active = now - lastActivityAt <= 5 * 60_000;
    if (active) readAccum += Math.min(now - lastReadTick, 60_000);
    lastReadTick = now;
    if (!active) {
      lastRestPromptAt = now; // 暂停阅读不累积计时
      return;
    }
    if (restReminderDue({ now, lastActivity: lastActivityAt, lastPrompt: lastRestPromptAt, enabled: state.settings.restReminder })) {
      lastRestPromptAt = now;
      toast('已连续阅读 45 分钟，建议休息一下眼睛', true);
    }
    if (readAccum >= 60_000) saveProgressNow(); // 静止阅读也要落盘时长
    updateStatus(); // 落盘后刷新「已读」显示
  }, 30_000);

  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayout({ preserve: true }), 140);
  });
  ro.observe(el.viewport);

  window.addEventListener('beforeunload', saveProgressNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgressNow();
  });
}

/* ================= 启动 ================= */

async function init() {
  // onCommand/onOpenPath 必须在模块加载即绑定（CLI 参数、第二实例的早期「打开」
  // 否则会静默丢失），但真正处理要等 init 完成（设置/编码表/bindUI 就绪）。
  // init 完成前先排队，完成后回放；preload 的 ipcRenderer.on 是叠加式，禁止二次绑定。
  let ready = false;
  const earlyEvents = [];
  api.onCommand((cmd, payload) => {
    if (ready) handleCommand(cmd, payload);
    else earlyEvents.push({ type: 'command', cmd, payload });
  });
  api.onOpenPath((payload) => {
    if (!payload?.path) return;
    if (ready) openPath(payload.path, payload.encoding ?? undefined);
    else earlyEvents.push({ type: 'open-path', payload });
  });

  const st = await api.getState();
  if (st?.settings) Object.assign(state.settings, st.settings);
  state.recent = st?.recent ?? [];

  // 旧存档一次性迁移 fontFamily/customFontName → fontCjk/fontLatin
  const mig = migrateFontKeys(st?.settings);
  if (mig) {
    Object.assign(state.settings, mig);
    await api.saveSettings(mig);
  }
  // 系统字体枚举 → 共享 datalist（失败则空列表，输入仍可用）
  try {
    const fonts = await api.listFonts();
    for (const f of fonts) {
      const opt = document.createElement('option');
      opt.value = f;
      el.fontList.append(opt);
    }
  } catch {
    /* 枚举失败仅损失候选列表 */
  }
  const encs = st?.encodings ?? (await api.encodings());
  for (const e of encs) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.label;
    el.encSelect.append(opt);
  }

  applySettings();
  syncSettingsUI();
  renderRecent();
  renderShelfRoot();
  bindPasswordDialog();
  bindUI();

  ready = true;
  for (const ev of earlyEvents.splice(0)) {
    if (ev.type === 'command') handleCommand(ev.cmd, ev.payload);
    else openPath(ev.payload.path, ev.payload.encoding ?? undefined);
  }

  await document.fonts?.ready?.catch?.(() => {});
  document.documentElement.dataset.ready = '1';
}

init().catch((err) => {
  console.error('[renderer] 初始化失败', err);
  toast(`初始化失败：${err?.message ?? err}`, true);
});
