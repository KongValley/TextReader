/**
 * PDF 渲染视图。
 * - canvas 按 devicePixelRatio 渲染，叠一层 pdf.js TextLayer 提供选中/复制
 * - 只渲染当前页前后 PRELOAD 页（其余保留占位尺寸，滚动条与页码计算保持稳定）
 * - 翻页模式用 transform 平移（等同 TXT 的列位移），滚动模式用原生纵向滚动
 * - 查找索引来自 getTextContent，命中处用覆盖层画高亮框
 */
import * as pdfjs from '/vendor/pdfjs/build/pdf.mjs';
import { buildOutline } from './outline.js';

const VENDOR = new URL('/vendor/pdfjs/', location.href).toString();
pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR}build/pdf.worker.min.mjs`;

const PRELOAD = 2; // 当前页前后各预渲染的页数
const PAGE_GAP = 24; // 页间距（px）
const MAX_SEARCH_HITS = 500;
const HIGHLIGHT_ASCENT = 0.92; // 高亮框上沿相对字号的近似比例（够覆盖汉字与西文主体）
const SKIP_HIGHLIGHT_ANGLE = 0.001;

const pageApi = (n) => n + 1; // 0 基页码 ↔ pdf.js 的 1 基页号

/** #pdf-pages 是所有文档共用的节点：用序号标记当前"占用者"，旧视图只清理自己挂上去的节点 */
let viewSeq = 0;

export class PdfView {
  #container;
  #strip;
  #task = null; // PDFDocumentLoadingTask（销毁 worker 用它，文档代理本身没有 destroy）
  #doc = null;
  #records = []; // [{ el, canvas, layer, hl, size, tops, lefts, rendered, rendering, task, page, text, viewport, items, offsets }]
  #scale = 1;
  #mode = 'paged';
  #current = 0;
  #onPageChange = null;
  #destroyed = false;
  #mounted = false; // 页面节点是否还挂在这个 #pdf-pages 上（后续文档会接管同一个节点）
  #id = 0; // 占用序号，见 viewSeq
  #search = { query: '', matches: [], cursor: -1, token: 0 };
  outline = [];

  constructor({ container, strip, scale = 1, mode = 'paged' }) {
    this.#container = container;
    this.#strip = strip;
    this.#scale = scale;
    this.#mode = mode;
  }

  get pageCount() {
    return this.#records.length;
  }

  get current() {
    return this.#current;
  }

  get scale() {
    return this.#scale;
  }

  /** 让指定页完整放进可用区域所需的比例（不放大，超过 100% 时按 100% 显示） */
  fitScale(viewW, viewH, page = this.#current) {
    const rec = this.#records[page];
    if (!rec || !(viewW > 0) || !(viewH > 0)) return 1;
    return Math.max(0.05, Math.min(1, viewW / rec.size.w, viewH / rec.size.h));
  }

  /** @param {ArrayBuffer|Uint8Array} data */
  async open(data) {
    // app:// 不是 http(s)，pdf.js 不会把资源取回交给 worker，必须由主线程取（CSP 里放行 connect-src）
    const task = pdfjs.getDocument({
      data: data instanceof Uint8Array ? data : new Uint8Array(data),
      cMapUrl: `${VENDOR}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${VENDOR}standard_fonts/`,
      wasmUrl: `${VENDOR}wasm/`,
      iccUrl: `${VENDOR}iccs/`,
      // CSP 无 unsafe-eval：显式关掉基于 new Function 的字体优化路径，避免控制台报 CSP 违规
      isEvalSupported: false,
    });
    const doc = await task.promise;
    if (this.#destroyed) {
      task.destroy();
      return;
    }
    this.#task = task;
    this.#doc = doc;

    // 先量出每页的原始尺寸，占位与缩放都不再依赖渲染结果
    const sizes = [];
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(pageApi(i));
      const vp = page.getViewport({ scale: 1 });
      sizes.push({ w: vp.width, h: vp.height });
    }

    const frag = document.createDocumentFragment();
    this.#records = sizes.map((size, i) => {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = String(i);
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      const hl = document.createElement('div');
      hl.className = 'pdf-hl';
      el.append(canvas, layer, hl);
      frag.append(el);
      return {
        index: i,
        el,
        canvas,
        layer,
        hl,
        size,
        rendered: false,
        rendering: false,
        task: null,
        pagePromise: null,
        textLayer: null,
        text: null,
        viewport: null,
        items: null,
        offsets: null,
      };
    });
    this.#id = ++viewSeq;
    this.#strip.dataset.pdfView = String(this.#id);
    this.#strip.replaceChildren(frag);
    this.#mounted = true;

    this.outline = await buildOutline(doc);
    this.#applyLayout();
    await this.#sync();
  }

  setScale(scale) {
    if (!this.#doc || scale === this.#scale) return;
    this.#scale = scale;
    // 内容按新比例重排，文本层与高亮随之更新
    for (const rec of this.#records) this.#release(rec);
    this.#applyLayout();
    this.#sync();
  }

  setMode(mode) {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#applyLayout();
    this.goToPage(this.#current, { silent: false });
  }

  onPageChange(cb) {
    this.#onPageChange = cb;
  }

  /** 视口尺寸变化：只影响居中/滚动对齐，不需要重渲染 */
  relayout() {
    if (!this.#doc) return;
    this.#applyLayout();
    this.#sync();
  }

  goToPage(page, { silent = false } = {}) {
    if (!this.#doc) return;
    const n = Math.max(0, Math.min(this.pageCount - 1, Math.round(page)));
    const changed = n !== this.#current;
    this.#current = n;
    if (this.#mode === 'paged') {
      this.#strip.style.transform = `translateX(${Math.round(this.#centering(n) - this.#recordOffsets()[0][n])}px)`;
    } else {
      this.#container.scrollTop = Math.round(this.#recordOffsets()[1][n]);
    }
    this.#updateVisibility();
    this.#sync();
    if (!silent && changed) this.#onPageChange?.(n);
  }

  next() {
    if (this.#current < this.pageCount - 1) this.goToPage(this.#current + 1);
    return this.#current;
  }

  prev() {
    if (this.#current > 0) this.goToPage(this.#current - 1);
    return this.#current;
  }

  /** 滚动模式：由容器滚动反推当前页 */
  syncFromScroll() {
    if (!this.#doc || this.#mode !== 'scroll') return;
    const [, tops] = this.#recordOffsets();
    const probe = this.#container.scrollTop + this.#container.clientHeight * 0.4;
    let n = 0;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] <= probe) n = i;
      else break;
    }
    if (n !== this.#current) {
      this.#current = n;
      this.#sync();
      this.#onPageChange?.(n);
    }
  }

  /** 某页的文字（按 pdf.js item 原样拼接，用于书签预览/查找） */
  async pageText(page) {
    const n = Math.max(0, Math.min(this.pageCount - 1, page));
    const rec = this.#records[n];
    if (!rec) return '';
    await this.#loadText(rec);
    return (rec.text?.items ?? []).map((it) => it.str).join('');
  }

  /* ---------- 查找 ---------- */

  /**
   * 全文档查找。逐页取文字，命中上限 MAX_SEARCH_HITS；
   * 期间若发起了新的查找（token 变化）则放弃本次结果。
   */
  async search(query) {
    const q = (query ?? '').trim();
    const token = ++this.#search.token;
    this.#search = { query: q, matches: [], cursor: -1, token };
    this.#paintHighlights();
    if (!q || !this.#doc) return { count: 0 };

    const needle = q.toLowerCase();
    const matches = [];
    for (let i = 0; i < this.#records.length; i++) {
      const rec = this.#records[i];
      await this.#loadText(rec);
      if (this.#search.token !== token) return { count: 0, stale: true };
      if (!rec.text) return { count: 0, stale: true };
      const text = rec.text.items.map((it) => it.str).join('');
      const hay = text.toLowerCase();
      let from = 0;
      while (matches.length < MAX_SEARCH_HITS) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        matches.push({ page: i, start: at, len: needle.length });
        from = at + Math.max(1, needle.length);
      }
      if (matches.length >= MAX_SEARCH_HITS) break;
    }
    if (this.#search.token !== token) return { count: 0, stale: true };
    this.#search.matches = matches;
    return { count: matches.length };
  }

  /** 跳到下一处/上一处命中；返回 { index, count } */
  async stepSearch(dir) {
    const m = this.#search.matches;
    if (!m.length) return { index: -1, count: 0 };
    this.#search.cursor = (this.#search.cursor + dir + m.length) % m.length;
    const hit = m[this.#search.cursor];
    if (hit.page !== this.#current) this.goToPage(hit.page);
    await this.#sync();
    this.#scrollHighlightIntoView();
    return { index: this.#search.cursor, count: m.length };
  }

  /* ---------- 布局 ---------- */

  #recordOffsets() {
    const lefts = new Array(this.#records.length);
    const tops = new Array(this.#records.length);
    for (let i = 0; i < this.#records.length; i++) {
      // transform 不参与布局，翻页模式下这两个值同样有效
      lefts[i] = this.#records[i].el.offsetLeft;
      tops[i] = this.#records[i].el.offsetTop;
    }
    return [lefts, tops];
  }

  #centering(n) {
    const rec = this.#records[n];
    return Math.max(0, (this.#container.clientWidth - (rec?.el.offsetWidth ?? 0)) / 2);
  }

  #applyLayout() {
    for (const rec of this.#records) {
      const w = Math.max(1, Math.round(rec.size.w * this.#scale));
      const h = Math.max(1, Math.round(rec.size.h * this.#scale));
      rec.el.style.width = `${w}px`;
      rec.el.style.height = `${h}px`;
      // TextLayer 用它算容器尺寸与字号（setLayerDimensions / --text-scale-factor）
      rec.el.style.setProperty('--total-scale-factor', String(this.#scale));
      rec.el.style.setProperty('--scale-round-x', '1px');
      rec.el.style.setProperty('--scale-round-y', '1px');
    }
    if (this.#mode === 'paged') {
      this.#strip.style.transform = `translateX(${Math.round(this.#centering(this.#current) - this.#recordOffsets()[0][this.#current])}px)`;
    } else {
      this.#strip.style.transform = '';
    }
    this.#updateVisibility();
  }

  /** 翻页模式只显示当前页：邻页露在边缘会看成"两页并排" */
  #updateVisibility() {
    const paged = this.#mode === 'paged';
    for (const rec of this.#records) {
      const next = paged && rec.index !== this.#current ? 'hidden' : '';
      if (rec.el.style.visibility !== next) rec.el.style.visibility = next;
    }
  }

  /* ---------- 渲染 ---------- */

  async #sync() {
    if (!this.#doc || this.#destroyed) return;
    const from = Math.max(0, this.#current - PRELOAD);
    const to = Math.min(this.pageCount - 1, this.#current + PRELOAD);
    for (let i = 0; i < this.#records.length; i++) {
      if (i < from || i > to) this.#release(this.#records[i]);
    }
    const jobs = [];
    for (let i = from; i <= to; i++) jobs.push(this.#ensureRendered(i));
    await Promise.all(jobs);
    if (this.#destroyed) return;
    this.#paintHighlights();
  }

  async #page(rec) {
    rec.pagePromise ??= this.#doc.getPage(pageApi(rec.index));
    return rec.pagePromise;
  }

  async #ensureRendered(i) {
    const rec = this.#records[i];
    if (!rec || rec.rendered || rec.rendering) return;
    rec.rendering = true;
    try {
      const page = await this.#page(rec);
      if (this.#destroyed) return;
      const viewport = page.getViewport({ scale: this.#scale });
      const out = new pdfjs.OutputScale();
      const canvas = rec.canvas;
      canvas.width = Math.max(1, Math.floor(viewport.width * out.sx));
      canvas.height = Math.max(1, Math.floor(viewport.height * out.sy));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: out.scaled ? [out.sx, 0, 0, out.sy, 0, 0] : null,
      });
      rec.task = task;
      await task.promise;
      rec.task = null;
      if (this.#destroyed) return;
      rec.viewport = viewport;

      const text = await this.#loadText(rec);
      if (this.#destroyed || !text) return;
      rec.layer.replaceChildren();
      const layer = new pdfjs.TextLayer({ textContentSource: text, container: rec.layer, viewport });
      rec.textLayer = layer;
      await layer.render();
      if (this.#destroyed) return;
      rec.rendered = true;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && err?.name !== 'AbortException') {
        console.error('[pdf] 页面渲染失败', i, err);
      }
    } finally {
      rec.rendering = false;
    }
  }

  /** 释放画布与文本层，保留占位与尺寸（缩放/滚动出视野时调用） */
  #release(rec) {
    if (!rec || (!rec.rendered && !rec.rendering && !rec.textLayer)) return;
    rec.task?.cancel();
    rec.task = null;
    rec.textLayer?.cancel();
    rec.textLayer = null;
    rec.layer.replaceChildren();
    rec.hl.replaceChildren();
    rec.canvas.width = 0;
    rec.canvas.height = 0;
    rec.rendered = false;
  }

  /** 取某页的文字层（缓存）。视图已销毁时返回 null。 */
  async #loadText(rec) {
    if (!rec.text) {
      const page = await this.#page(rec);
      const content = await page.getTextContent();
      if (this.#destroyed) return null;
      rec.text = content;
      rec.items = content.items.filter((it) => typeof it.str === 'string');
      // 每项的起始字符偏移（页内拼接串里的位置），用于把命中映射回具体 item
      const offsets = new Array(rec.items.length);
      let acc = 0;
      for (let i = 0; i < rec.items.length; i++) {
        offsets[i] = acc;
        acc += rec.items[i].str.length;
      }
      rec.offsets = offsets;
    }
    return rec.text;
  }

  /* ---------- 高亮 ---------- */

  #paintHighlights() {
    const { matches, cursor, query } = this.#search;
    const byPage = new Map();
    if (query) {
      for (const m of matches) {
        const list = byPage.get(m.page);
        if (list) list.push(m);
        else byPage.set(m.page, [m]);
      }
    }
    for (const rec of this.#records) {
      if (!rec.rendered || !rec.viewport) continue;
      const hits = byPage.get(rec.index) ?? [];
      rec.hl.replaceChildren();
      if (!hits.length) continue;
      const frag = document.createDocumentFragment();
      for (const hit of hits) {
        for (const box of this.#boxesFor(rec, hit)) {
          const div = document.createElement('div');
          div.className = 'pdf-hl-box';
          if (matches[cursor] === hit) div.classList.add('current');
          div.style.left = `${box.x.toFixed(2)}px`;
          div.style.top = `${box.y.toFixed(2)}px`;
          div.style.width = `${Math.max(2, box.w).toFixed(2)}px`;
          div.style.height = `${box.h.toFixed(2)}px`;
          frag.append(div);
        }
      }
      rec.hl.append(frag);
    }
  }

  /** 把「页内字符区间」拆成若干轴对齐矩形（跨 item 的命中会得到多个框） */
  #boxesFor(rec, hit) {
    const boxes = [];
    const scale = rec.viewport.scale;
    const items = rec.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const len = item.str.length;
      const start = rec.offsets[i];
      const end = start + len;
      const a = Math.max(hit.start, start);
      const b = Math.min(hit.start + hit.len, end);
      if (a >= b || len === 0) continue;
      const tx = pdfjs.Util.transform(rec.viewport.transform, item.transform);
      if (Math.abs(Math.atan2(tx[1], tx[0])) > SKIP_HIGHLIGHT_ANGLE) continue; // 旋转文字不画框（仍可定位跳转）
      const fontHeight = Math.hypot(tx[2], tx[3]);
      if (!(fontHeight > 0)) continue;
      const itemW = (item.width || 0) * scale;
      boxes.push({
        x: tx[4] + ((a - start) / len) * itemW,
        y: tx[5] - fontHeight * HIGHLIGHT_ASCENT,
        w: ((b - a) / len) * itemW,
        h: fontHeight,
      });
    }
    return boxes;
  }

  #scrollHighlightIntoView() {
    if (this.#mode !== 'scroll') return;
    const rec = this.#records[this.#current];
    const box = rec?.hl.querySelector('.pdf-hl-box.current') ?? null;
    if (box) box.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  destroy() {
    this.#destroyed = true;
    this.#search.token++;
    for (const rec of this.#records) {
      rec.task?.cancel();
      rec.textLayer?.cancel();
    }
    this.#records = [];
    // 同一个 #pdf-pages 会被后续文档接管：只清理仍然属于自己的那批节点
    if (this.#mounted && this.#strip.dataset.pdfView === String(this.#id)) {
      this.#strip.replaceChildren();
      delete this.#strip.dataset.pdfView;
    }
    this.#mounted = false;
    // 文档代理本身没有 destroy：终止 worker 要用 loadingTask
    this.#task?.destroy().catch(() => {});
    this.#task = null;
    this.#doc = null;
  }
}
