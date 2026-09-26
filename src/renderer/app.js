/**
 * 渲染进程主逻辑：打开文件、章节渲染、翻页/滚动、目录、书签、查找、设置。
 * 文本一律用 textContent 注入，绝不使用 innerHTML。
 */
import { splitChapters } from '../shared/chapters.js';
import { DEFAULT_SETTINGS, FONTS, FONT_STACK, MODE_LABEL, THEMES, THEME_LABEL } from '../shared/settings.js';

const api = window.api;
const $ = (sel, root = document) => root.querySelector(sel);

const el = {
  body: document.body,
  viewport: $('#viewport'),
  flow: $('#flow'),
  toc: $('#toc'),
  tocList: $('#toc-list'),
  tocCount: $('#toc-count'),
  settings: $('#settings'),
  bookmarks: $('#bookmarks'),
  bookmarkList: $('#bookmark-list'),
  recentList: $('#recent-list'),
  fileName: $('#file-name'),
  encLabel: $('#enc-label'),
  statusChapter: $('#status-chapter'),
  statusProgress: $('#status-progress'),
  statusMeta: $('#status-meta'),
  progressFill: $('#progress-fill'),
  toast: $('#toast'),
  searchInput: $('#search-input'),
  searchCount: $('#search-count'),
  btnMode: $('#btn-mode'),
  btnTheme: $('#btn-theme'),
  fontSelect: $('#set-font-family'),
  encSelect: $('#set-encoding'),
  fontSize: $('#set-font-size'),
  fontSizeVal: $('#font-size-val'),
  lineHeight: $('#set-line-height'),
  lineHeightVal: $('#line-height-val'),
  letterSpacing: $('#set-letter-spacing'),
  letterSpacingVal: $('#letter-spacing-val'),
  contentWidth: $('#set-content-width'),
  contentWidthVal: $('#content-width-val'),
  justify: $('#set-justify'),
  shortcuts: $('#shortcuts'),
};

const state = {
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

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ================= 设置 ================= */

function applySettings() {
  const s = state.settings;
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--font-size', `${s.fontSize}px`);
  root.style.setProperty('--line-height', String(s.lineHeight));
  root.style.setProperty('--letter-spacing', `${s.letterSpacing}em`);
  root.style.setProperty('--reading-font', FONT_STACK[s.fontFamily] ?? FONT_STACK.system);
  root.style.setProperty('--content-width', `${s.contentWidth}px`);
  root.style.setProperty('--align', s.justify ? 'justify' : 'start');
  el.viewport.dataset.mode = s.mode;
  el.btnMode.textContent = MODE_LABEL[s.mode] ?? '翻页';
  el.btnTheme.textContent = THEME_LABEL[s.theme] ?? '护眼';
}

function syncSettingsUI() {
  const s = state.settings;
  for (const b of el.settings.querySelectorAll('#set-theme button')) b.classList.toggle('active', b.dataset.theme === s.theme);
  for (const b of el.settings.querySelectorAll('#set-mode button')) b.classList.toggle('active', b.dataset.mode === s.mode);
  el.fontSelect.value = s.fontFamily;
  el.fontSize.value = String(s.fontSize);
  el.fontSizeVal.textContent = `${s.fontSize}px`;
  el.lineHeight.value = String(s.lineHeight);
  el.lineHeightVal.textContent = s.lineHeight.toFixed(2);
  el.letterSpacing.value = String(s.letterSpacing);
  el.letterSpacingVal.textContent = `${s.letterSpacing.toFixed(3)}em`;
  el.contentWidth.value = String(s.contentWidth);
  el.contentWidthVal.textContent = `${s.contentWidth}px`;
  el.justify.checked = !!s.justify;
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
  state.file = { path: res.path, name: res.name, size: res.size };
  state.text = res.text;
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
  el.encLabel.title = res.warning ? '存在无法解码的字符，可在“设置”里手动指定编码' : `编码：${res.encoding}`;
  el.encSelect.value = res.encoding;

  renderToc();
  renderBookmarks();
  gotoChapter(state.book.chapterIndex ?? 0, state.book.ratio ?? 0);
  updateStatus();
  if (res.warning) toast('部分字符无法解码，可在设置中切换编码', true);
  else if (res.inherited) toast(`已沿用原阅读记录（第 ${(state.book.chapterIndex ?? 0) + 1} 章）`);
  else toast('');
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
  if (state.index >= state.chapters.length - 1) return toast('已经是最后一章');
  gotoChapter(state.index + 1, 0);
}

function prevChapter() {
  if (!state.file) return;
  if (state.index <= 0) return toast('已经是第一章');
  gotoChapter(state.index - 1, 0);
}

/* ================= 目录 ================= */

function renderToc() {
  const frag = document.createDocumentFragment();
  state.chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    li.className = 'toc-item';
    li.dataset.i = String(i);
    li.textContent = ch.title;
    li.title = ch.title;
    frag.append(li);
  });
  el.tocList.replaceChildren(frag);
  el.tocCount.textContent = `${state.chapters.length} 章`;
}

function syncTocActive() {
  const prev = el.tocList.querySelector('.toc-item.active');
  if (prev) prev.classList.remove('active');
  const cur = el.tocList.querySelector(`.toc-item[data-i="${state.index}"]`);
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

function addBookmark() {
  if (!state.file) return toast('请先打开文件', true);
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

    const del = document.createElement('button');
    del.className = 'btn tiny';
    del.textContent = '×';
    del.title = '删除书签';
    del.addEventListener('click', () => removeBookmark(i));

    row.append(main, del);
    frag.append(row);
  });
  el.bookmarkList.append(frag);
}

function jumpToBookmark(bm) {
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

function computeMatches(query, firstDir = 1) {
  const q = (query ?? '').trim();
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

function updateStatus() {
  const ch = state.chapters[state.index];
  el.statusChapter.textContent = ch ? ch.title : '';
  const pct = state.text.length && ch ? (ch.bodyStart + currentRatio() * (ch.end - ch.bodyStart)) / state.text.length : 0;
  const shown = clamp(pct, 0, 1);
  el.statusProgress.textContent = `${(shown * 100).toFixed(1)}%`;
  el.progressFill.style.width = `${(shown * 100).toFixed(2)}%`;
  el.statusMeta.textContent = state.file
    ? `第 ${state.index + 1}/${state.chapters.length} 章 · ${fmtNum(state.wordCount)}字 · ${state.encoding.toUpperCase()}`
    : '';
}

function progressSnapshot() {
  const ch = state.chapters[state.index];
  const ratio = currentRatio();
  const abs = ch ? ch.bodyStart + ratio * (ch.end - ch.bodyStart) : 0;
  return {
    chapterIndex: state.index,
    ratio: Number(ratio.toFixed(4)),
    percent: Number((state.text.length ? abs / state.text.length : 0).toFixed(4)),
  };
}

function scheduleSaveProgress() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgressNow, 900);
}

function saveProgressNow() {
  if (!state.file) return;
  api.saveProgress(state.file.path, progressSnapshot());
}

/* ================= 抽屉 / 欢迎页 ================= */

function toggleDrawer(name) {
  const target = name === 'toc' ? el.toc : name === 'bookmarks' ? el.bookmarks : el.settings;
  const willShow = target.hidden;
  for (const d of [el.toc, el.settings, el.bookmarks]) d.hidden = true;
  target.hidden = !willShow;
  if (name === 'toc') syncTocActive();
}

function closeAllDrawers() {
  for (const d of [el.toc, el.settings, el.bookmarks]) d.hidden = true;
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
    meta.textContent = `${fmtNum(r.size ?? 0)} 字节`;
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
      updateSettings({ fontSize: clamp(state.settings.fontSize + (payload > 0 ? 1 : -1), 12, 40) });
      break;
    case 'help':
      el.settings.hidden = false;
      el.shortcuts.hidden = false;
      break;
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
      (name === 'toc' ? el.toc : name === 'bookmarks' ? el.bookmarks : el.settings).hidden = true;
    });
  }

  el.tocList.addEventListener('click', (e) => {
    const li = e.target.closest('.toc-item');
    if (!li) return;
    gotoChapter(Number(li.dataset.i), 0);
    el.toc.hidden = true;
  });

  el.settings.querySelector('#set-theme').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (b) updateSettings({ theme: b.dataset.theme });
  });
  el.settings.querySelector('#set-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) updateSettings({ mode: b.dataset.mode });
  });
  el.fontSelect.addEventListener('change', () => updateSettings({ fontFamily: el.fontSelect.value }));
  el.fontSize.addEventListener('input', () => updateSettings({ fontSize: Number(el.fontSize.value) }, { relayoutNow: false }));
  el.fontSize.addEventListener('change', () => relayout({ preserve: true }));
  el.lineHeight.addEventListener('input', () => updateSettings({ lineHeight: Number(el.lineHeight.value) }, { relayoutNow: false }));
  el.lineHeight.addEventListener('change', () => relayout({ preserve: true }));
  el.letterSpacing.addEventListener('input', () => updateSettings({ letterSpacing: Number(el.letterSpacing.value) }, { relayoutNow: false }));
  el.letterSpacing.addEventListener('change', () => relayout({ preserve: true }));
  el.contentWidth.addEventListener('input', () => updateSettings({ contentWidth: Number(el.contentWidth.value) }, { relayoutNow: false }));
  el.contentWidth.addEventListener('change', () => relayout({ preserve: true }));
  el.justify.addEventListener('change', () => updateSettings({ justify: el.justify.checked }, { relayoutNow: false }));
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
    }
  });
  $('#search-next').addEventListener('click', () => searchStep(1));
  $('#search-prev').addEventListener('click', () => searchStep(-1));

  // 翻页模式：点击左右两侧翻页（不影响选中文字）
  el.viewport.addEventListener('click', (e) => {
    if (state.settings.mode !== 'paged' || !state.file) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const rect = el.viewport.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x > 0.68) nextPage();
    else if (x < 0.32) prevPage();
  });

  el.viewport.addEventListener('wheel', (e) => {
    if (!state.file) return;
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
    if (state.settings.mode === 'scroll') {
      updateStatus();
      scheduleSaveProgress();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllDrawers();
      if (isTypingTarget(e.target)) e.target.blur();
      return;
    }
    if (isTypingTarget(e.target) || !state.file) return;
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
        gotoChapter(0, 0);
        break;
      case 'End':
        e.preventDefault();
        gotoChapter(state.chapters.length - 1, 0);
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
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    el.body.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const p = api.droppedPath(file);
    if (p) openPath(p);
    else toast('无法识别拖入的文件', true);
  });

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
  const st = await api.getState();
  if (st?.settings) Object.assign(state.settings, st.settings);
  state.recent = st?.recent ?? [];

  for (const f of FONTS) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    el.fontSelect.append(opt);
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
  bindUI();

  api.onCommand(handleCommand);
  api.onOpenPath((payload) => {
    if (payload?.path) openPath(payload.path, payload.encoding ?? undefined);
  });

  await document.fonts?.ready?.catch?.(() => {});
  document.documentElement.dataset.ready = '1';
}

init().catch((err) => {
  console.error('[renderer] 初始化失败', err);
  toast(`初始化失败：${err?.message ?? err}`, true);
});
