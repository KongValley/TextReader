/**
 * EPUB 打开路径：在主进程把 ZIP 包拆开、按 spine/TOC 提取成「纯文本 + 显式章节表」，
 * 再交给渲染进程复用 TXT 的重排阅读链路（分页/滚动、主题、书签、划线、查找）。
 *
 * 零新依赖：ZIP 用 node:zlib.inflateRawSync 手工解包，XML 用单遍 tokenizer。
 * 主进程没有 DOMParser，且 tokenizer 的行为可以在 node --test 里精确断言。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { splitChapters, splitLongChapters } from '../shared/chapters.js';

/** 二进制整份进内存解析，与 PDF 同量级的上限。 */
export const EPUB_MAX_BYTES = 100 * 1024 * 1024;

/** 防 zip 炸弹：单条目解压上限（按中央目录 uncompSize 预判 + inflate maxOutputLength 双保险）。 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export const isEpubPath = (filePath) => /\.epub$/i.test(String(filePath ?? ''));

// ---------- ZIP 层 ----------

/** 从文件尾向前找 EOCD 记录（0x06054b50），带注释时最多回溯 65557 字节。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return {
        cdOffset: buf.readUInt32LE(i + 16),
        cdSize: buf.readUInt32LE(i + 12),
        entriesTotal: buf.readUInt16LE(i + 10),
      };
    }
  }
  return null;
}

/** 解析中央目录 → Map<条目名, {method, compSize, uncompSize, localOffset, name}>；目录项跳过。 */
function readCentralDirectory(buf, eocd) {
  const map = new Map();
  let p = eocd.cdOffset;
  for (let n = 0; n < eocd.entriesTotal; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name && !name.endsWith('/')) map.set(name, { method, compSize, uncompSize, localOffset, name });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return map;
}

/** 条目名按规范大小写敏感，但真实文件偶有全小写/大小写漂移，miss 时兜底忽略大小写。 */
function lookupEntry(cd, name) {
  const hit = cd.get(name);
  if (hit) return hit;
  const lower = String(name).toLowerCase();
  for (const e of cd.values()) if (e.name.toLowerCase() === lower) return e;
  return undefined;
}

/** 取一个条目的解压后字节。本地头的 extra 长度可能与中央目录不同，按本地头算数据起点。 */
function entryData(buf, entry) {
  const { localOffset, compSize, method, uncompSize } = entry;
  if (uncompSize > MAX_ENTRY_BYTES) throw new Error('EPUB 条目异常（单文件解压超过 64MB）');
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error('EPUB 无法解析（ZIP 本地头损坏）');
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  if (start + compSize > buf.length) throw new Error('EPUB 无法解析（ZIP 条目数据越界）');
  const raw = buf.subarray(start, start + compSize);
  if (method === 0) return raw;
  if (method !== 8) throw new Error('EPUB 内部条目使用了不支持的压缩方式');
  return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES + 1 });
}

// ---------- XML tokenizer ----------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', dagger: '†', sect: '§',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±',
  times: '×', cent: '¢', pound: '£', euro: '€', yen: '¥', middot: '·',
};

/** 命名实体 + 十进制/十六进制数字实体；未知实体原样保留（不抛错，脏数据也要读完）。 */
export function decodeEntities(s) {
  if (!s || !s.includes('&')) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      return String.fromCodePoint(cp);
    }
    return ENTITIES[body] ?? m;
  });
}

/** 解析一段 `<tag a="b"/>` 里的属性（属性名小写，`:` 保留以便识别 epub:type）。 */
function parseAttrs(str) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(str))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

/**
 * 单遍 XML tokenizer：跳过注释/PI/DOCTYPE，CDATA 原文当文本发（不解实体）。
 * 畸形输入（找不到 `>`/`-->`）安全终止，不抛错。
 */
export function xmlTokenize(src, { onOpen, onClose, onText }) {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (onText && i < n) onText(src.slice(i));
      break;
    }
    if (lt > i && onText) onText(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (onText) onText(src.slice(lt + 9, end === -1 ? n : end));
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j < n ? j + 1 : n;
      continue;
    }
    const gt = src.indexOf('>', lt);
    if (gt === -1) break;
    let body = src.slice(lt + 1, gt);
    let selfClose = false;
    if (body.endsWith('/')) {
      selfClose = true;
      body = body.slice(0, -1);
    }
    if (body[0] === '/') {
      if (onClose) onClose(body.slice(1).trim().toLowerCase());
    } else {
      const m = /^([^\s/>]+)/.exec(body);
      if (m && onOpen) onOpen(m[1].toLowerCase(), parseAttrs(body.slice(m[1].length)), selfClose);
    }
    i = gt + 1;
  }
}

// ---------- 编码嗅探 ----------

/** BOM 嗅探：FF FE→utf-16le、FE FF→utf-16be、其余 utf-8；解码后去掉开头的 BOM 字符。 */
export function decodeUtf(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8').slice(1);
  }
  if (buf.length >= 2 && buf[1] === 0xfe) {
    const b = buf.subarray(2, buf.length - (buf.length % 2));
    return b.toString('utf16le').replace(/^\uFEFF/, '');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = buf.subarray(2, buf.length - (buf.length % 2)).swap16();
    return b.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

// ---------- EPUB 元数据解析 ----------

/** OPF → { manifest: Map<id,{href,mediaType,properties}>, spine: [idref], tocId } */
export function parseOpf(src) {
  const manifest = new Map();
  const spine = [];
  let tocId = null;
  xmlTokenize(src, {
    onOpen(tag, attrs) {
      if (tag === 'item' && attrs.id) {
        manifest.set(attrs.id, {
          href: attrs.href || '',
          mediaType: (attrs['media-type'] || '').toLowerCase(),
          properties: (attrs.properties || '').split(/\s+/).filter(Boolean),
        });
      } else if (tag === 'itemref' && attrs.idref) {
        spine.push(attrs.idref);
      } else if (tag === 'spine' && attrs.toc) {
        tocId = attrs.toc;
      }
    },
    onClose() {},
    onText() {},
  });
  return { manifest, spine, tocId };
}

/** EPUB3 导航文档 → [{href, title}]；取 epub:type="toc" 的 nav，无标记但唯一 nav 时用它。 */
export function parseNav(src) {
  const navs = [];
  const stack = [];
  xmlTokenize(src, {
    onOpen(tag, attrs, selfClose) {
      if (tag === 'nav') {
        const nav = { isToc: (attrs['epub:type'] || attrs.type || '').split(/\s+/).includes('toc'), items: [] };
        navs.push(nav);
        if (!selfClose) stack.push({ nav });
        return;
      }
      if (tag === 'a' && stack.length && attrs.href) {
        const item = { href: attrs.href, parts: [] };
        const top = stack[stack.length - 1];
        if (top.nav) top.nav.items.push(item);
        if (!selfClose) stack.push({ a: item });
      }
    },
    onClose(tag) {
      const top = stack[stack.length - 1];
      if (!top) return;
      if ((tag === 'nav') === !!top.nav) stack.pop();
    },
    onText(s) {
      const top = stack[stack.length - 1];
      if (top && top.a) top.a.parts.push(s);
    },
  });
  const tocNavs = navs.filter((nv) => nv.isToc);
  const chosen = tocNavs.length ? tocNavs : navs.length === 1 ? navs : [];
  return chosen
    .flatMap((nv) => nv.items)
    .map((it) => ({ href: it.href, title: it.parts.join('').replace(/\s+/g, ' ').trim() }))
    .filter((it) => it.href);
}

/** NCX（EPUB2 目录）→ [{href, title}]，按文档序输出。 */
export function parseNcx(src) {
  const out = [];
  const stack = [];
  const label = [];
  let labelDepth = 0;
  xmlTokenize(src, {
    onOpen(tag, attrs) {
      if (tag === 'navpoint') stack.push({ src: '', title: '' });
      else if (tag === 'navlabel') labelDepth++;
      else if (tag === 'content' && stack.length) stack[stack.length - 1].src = attrs.src || '';
    },
    onClose(tag) {
      if (tag === 'navlabel') {
        if (labelDepth > 0) labelDepth--;
        if (stack.length && label.length) stack[stack.length - 1].title = label.join('').replace(/\s+/g, ' ').trim();
        label.length = 0;
      } else if (tag === 'navpoint' && stack.length) {
        const np = stack.pop();
        out.push({ href: np.src, title: np.title });
      }
    },
    onText(s) { if (labelDepth) label.push(s); },
  });
  return out.filter((it) => it.href);
}

// ---------- 正文抽取 ----------

/** 开/关都追加换行的块级标签。 */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
/** HTML 里常见但 XHTML 里可能没写自闭合的 void 标签。 */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'wbr', 'area', 'base', 'col', 'embed', 'source', 'track']);
/** 整棵子树丢弃：防 <title>/CSS/JS/SVG 泄漏进正文。 */
const SKIP_TAGS = new Set(['head', 'script', 'style', 'svg']);

/**
 * XHTML → { text, idOffsets: Map<id, 偏移> }。
 * 偏移 = 该元素内容起点在 text 中的位置；块级开/关都补 \n（连续 \n 折叠成一条）。
 */
export function extractText(src) {
  const chunks = [];
  const idOffsets = new Map();
  let len = 0;
  let endsBreak = false;
  let skipDepth = 0;

  const push = (s) => {
    if (!s) return;
    chunks.push(s);
    len += s.length;
    endsBreak = s.charCodeAt(s.length - 1) === 10;
  };
  const appendBreak = () => { if (!endsBreak) push('\n'); };

  xmlTokenize(src, {
    onOpen(tag, attrs, selfClose) {
      if (SKIP_TAGS.has(tag)) {
        if (!selfClose) skipDepth++;
        return;
      }
      if (VOID_TAGS.has(tag)) {
        if (tag === 'br' || tag === 'hr') appendBreak();
        if (attrs.id) idOffsets.set(attrs.id, len);
        return;
      }
      if (BLOCK_TAGS.has(tag)) appendBreak();
      if (attrs.id) idOffsets.set(attrs.id, len);
    },
    onClose(tag) {
      if (SKIP_TAGS.has(tag)) {
        if (skipDepth > 0) skipDepth--;
        return;
      }
      if (BLOCK_TAGS.has(tag)) appendBreak();
    },
    onText(s) {
      if (skipDepth > 0 || !s) return;
      push(decodeEntities(s).replace(/\r\n?/g, '\n'));
    },
  });

  return { text: chunks.join(''), idOffsets };
}

// ---------- 组装 ----------

/** 相对 OPF 目录解析 href；同时拆出 #frag。 */
function resolveHref(opfPath, href) {
  let h = String(href ?? '');
  let frag = null;
  const hash = h.indexOf('#');
  if (hash !== -1) {
    frag = h.slice(hash + 1);
    h = h.slice(0, hash);
  }
  if (!h) return { file: '', frag };
  try {
    h = decodeURIComponent(h);
  } catch {
    /* % 编码残缺时按原文走，尽力而为 */
  }
  const dir = path.posix.dirname(opfPath);
  const file = path.posix.normalize(dir === '.' || dir === '' ? h : path.posix.join(dir, h));
  return { file: file.replace(/^\.\//, ''), frag };
}

/** ZIP 字节 → { opfPath, text, files, toc }，任何一级缺失都给出明确错误。 */
function parseEpub(buf) {
  const eocd = findEocd(buf);
  if (!eocd) throw new Error('EPUB 无法解析（不是有效的 ZIP 文件）');
  const cd = readCentralDirectory(buf, eocd);
  if (cd.size === 0) throw new Error('EPUB 无法解析（不是有效的 ZIP 文件）');

  const container = lookupEntry(cd, 'META-INF/container.xml');
  const containerSrc = container ? decodeUtf(entryData(buf, container)) : '';
  const containerMatch = /full-path\s*=\s*"([^"]+)"/.exec(containerSrc);
  const opfPath = containerMatch ? containerMatch[1] : '';
  if (!opfPath) throw new Error('EPUB 无法解析（缺少 container.xml）');

  const opfEntry = lookupEntry(cd, opfPath);
  if (!opfEntry) throw new Error('EPUB 无法解析（缺少 OPF 骨架）');
  const opf = parseOpf(decodeUtf(entryData(buf, opfEntry)));
  if (opf.spine.length === 0 || opf.manifest.size === 0) throw new Error('EPUB 无法解析（缺少 OPF 骨架）');

  const spineFiles = [];
  for (const idref of opf.spine) {
    const item = opf.manifest.get(idref);
    if (!item || !item.href || item.mediaType.startsWith('image/')) continue;
    const { file } = resolveHref(opfPath, item.href);
    if (file) spineFiles.push(file);
  }
  if (spineFiles.length === 0) throw new Error('EPUB 无法解析（缺少 OPF 骨架）');

  // TOC 回退链：EPUB3 nav → NCX → 全文 splitChapters
  let toc = [];
  const navItem = [...opf.manifest.values()].find((it) => it.properties.includes('nav') && it.href);
  if (navItem) {
    const entry = lookupEntry(cd, resolveHref(opfPath, navItem.href).file);
    if (entry) toc = parseNav(decodeUtf(entryData(buf, entry)));
  }
  if (toc.length === 0 && opf.tocId) {
    const ncxItem = opf.manifest.get(opf.tocId);
    if (ncxItem) {
      const entry = lookupEntry(cd, resolveHref(opfPath, ncxItem.href).file);
      if (entry) toc = parseNcx(decodeUtf(entryData(buf, entry)));
    }
  }

  const full = buildTextWith(buf, cd, opfPath, spineFiles, toc);
  return { opfPath, text: full.text, files: full.files, toc };
}

function buildTextWith(buf, cd, opfPath, spineFiles, toc) {
  const tocFiles = new Set();
  for (const it of toc) {
    const { file } = resolveHref(opfPath, it.href);
    if (file) tocFiles.add(file);
  }
  const parts = [];
  const files = new Map();
  let fullLen = 0;
  for (const file of spineFiles) {
    if (tocFiles.size && !tocFiles.has(file)) continue;
    const entry = lookupEntry(cd, file);
    if (!entry) continue;
    const { text, idOffsets } = extractText(decodeUtf(entryData(buf, entry)));
    if (!text.trim()) continue;
    const textOffset = fullLen;
    if (fullLen > 0) {
      parts.push('\n');
      fullLen += 1;
    }
    parts.push(text);
    fullLen += text.length;
    files.set(file, { textOffset, idOffsets });
  }
  return { text: parts.join(''), files };
}

/** TOC 锚点 → 章节表；无 TOC（或锚点全无效）时回退 splitChapters 全文兜底。 */
function buildChapters(text, files, toc, opfPath) {
  const anchors = [];
  const seen = new Set();
  for (const it of toc) {
    const { file, frag } = resolveHref(opfPath, it.href);
    const info = files.get(file);
    if (!info) continue;
    let offset = info.textOffset;
    if (frag && info.idOffsets.has(frag)) offset = info.textOffset + info.idOffsets.get(frag);
    if (seen.has(offset)) continue;
    seen.add(offset);
    anchors.push({ offset, title: it.title || file });
  }
  anchors.sort((a, b) => a.offset - b.offset);
  if (anchors.length === 0) return splitChapters(text);

  const chapters = [];
  if (anchors[0].offset > 0 && text.slice(0, anchors[0].offset).trim()) {
    chapters.push({ title: '开篇', start: 0, bodyStart: 0, end: anchors[0].offset });
  }
  for (let i = 0; i < anchors.length; i++) {
    const end = i + 1 < anchors.length ? anchors[i + 1].offset : text.length;
    chapters.push({ title: anchors[i].title, start: anchors[i].offset, bodyStart: anchors[i].offset, end });
  }

  // 标题行去重：章正文第一条非空行若与标题相同（EPUB 内 h1 与 TOC 标题重复显示），越过该行。
  // 块级标签会在锚点后留下若干空行，所以要先跳过前导空行再取第一条非空行。
  for (const c of chapters) {
    let p = c.bodyStart;
    while (p < c.end && text[p] === '\n') p++;
    const rest = text.slice(p, c.end);
    const nl = rest.indexOf('\n');
    const firstLine = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    if (firstLine && firstLine.replace(/\s+/g, '') === c.title.replace(/\s+/g, '')) {
      c.bodyStart = Math.min(p + (nl === -1 ? rest.length : nl + 1), c.end);
    }
  }
  return chapters;
}

/**
 * @param {string} filePath
 * @param {{ store: import('./store.js').Store, stat?: import('node:fs').Stats }} deps
 * @returns {Promise<object>} 渲染进程 payload（text + 显式章节表，走 TXT 渲染链路）
 */
export async function readEpubFile(filePath, { store, stat }) {
  const st = stat ?? (await fsp.stat(filePath));
  if (!st.isFile()) throw new Error('目标不是文件');
  if (st.size > EPUB_MAX_BYTES) throw new Error('EPUB 过大（超过 100MB）');

  const buf = await fsp.readFile(filePath);
  const name = path.basename(filePath);

  let parsed;
  try {
    parsed = parseEpub(buf);
  } catch (err) {
    // zlib 等底层报错统一收口成用户可读的 EPUB 错误
    throw new Error(String(err.message).startsWith('EPUB') ? err.message : `EPUB 无法解析（${err.message}）`);
  }
  const { text } = parsed;
  if (!text.trim()) throw new Error('EPUB 内没有可读文本');

  const { opfPath } = parsed;
  const chapters = splitLongChapters(text, buildChapters(text, parsed.files, parsed.toc, opfPath));

  // 与 TXT/PDF 一致：文件被移动/改名后按「同名同大小」沿用原进度与书签
  const inherited = store.inheritBook(filePath, { name, size: st.size });
  store.touchRecent({ path: filePath, name, size: st.size });
  const book = store.setBook(filePath, { encoding: 'epub', name, size: st.size });

  return {
    kind: 'epub',
    path: filePath,
    name,
    size: st.size,
    encoding: 'epub',
    text,
    chapters,
    book,
    inherited: inherited ? { from: inherited.inheritedFrom, chapterIndex: book.chapterIndex } : null,
  };
}
