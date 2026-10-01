/**
 * 章节切分（纯函数，渲染进程与 node 测试共用）。
 *
 * 输入：已归一化换行的全文（仅 \n）。
 * 输出：[{ title, start, bodyStart, end }]
 *   start     标题行起始偏移（合成分段时等于 bodyStart）
 *   bodyStart 正文起始偏移（跳过标题行本身）
 *   end       本章结束偏移（即下一章 start）
 */
export const DEFAULT_CHUNK = 4000; // 无章节文件的强制分段长度
export const MAX_CHAPTER_CHARS = 60000; // 单章过长时的再切分阈值
const MAX_TITLE_LEN = 40;

const HEADING_RES = [
  /^第\s*[0-9０-９零一二三四五六七八九十百千万两〇壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}\s*[章节節回卷部篇集话話幕]/,
  /^(?:序章|序言|自序|楔子|引子|前言|后记|後記|尾声|尾聲|终章|終章|终篇|大结局|大結局|番外(?:篇)?|外传|外傳|正文|完本感言|作者的话|作者的話)/,
  /^[上中下]卷$/,
  /^卷[一二三四五六七八九十百0-9]{1,4}$/,
];

/** 纯编号标题：`001 一切都那么美好`（空格分隔，常见于网络小说导出）。 */
const NUMBERED_RE = /^0*(\d{1,4})[ \t\u3000]+(\S.*)$/;
/** 编号标题必须成“连续递增序列”才被采信，孤立数字开头的正文行不算。 */
const NUMBERED_RUN_MIN = 5;

/** 判断一行是否是章节标题行。 */
export function isHeadingLine(line) {
  const t = line.trim();
  if (!t || t.length > MAX_TITLE_LEN) return false;
  if (t.includes('。')) return false;
  if (!HEADING_RES.some((re) => re.test(t))) return false;
  // “第一章讲的是……”这类正文句子：长且带逗号/分号，排除
  if (t.length > 25 && /[，,；;]/.test(t)) return false;
  return true;
}

/** 从候选编号行里挑出长度 ≥ NUMBERED_RUN_MIN 的连续递增序列。 */
export function pickNumberedRuns(candidates) {
  const out = [];
  let runStart = 0;
  for (let i = 1; i <= candidates.length; i++) {
    const continues = i < candidates.length && candidates[i].num === candidates[i - 1].num + 1;
    if (!continues) {
      if (i - runStart >= NUMBERED_RUN_MIN) {
        for (let k = runStart; k < i; k++) out.push(candidates[k]);
      }
      runStart = i;
    }
  }
  return out;
}

/** 按长度把 [from,to) 切成若干段，尽量落在换行处。 */
function chunkRanges(text, from, to, size) {
  const ranges = [];
  let s = from;
  while (s < to) {
    let e = Math.min(s + size, to);
    if (e < to) {
      const nl = text.indexOf('\n', e);
      if (nl !== -1 && nl - e < 300) e = nl + 1;
    }
    ranges.push({ bodyStart: s, end: e });
    s = e;
  }
  return ranges;
}

/**
 * 把超长章按 maxChapter 再切分（TXT 标题章与 EPUB TOC 章共用）。
 * @param {string} text 归一化后的全文
 * @param {{title:string,start:number,bodyStart:number,end:number}[]} chapters
 * @param {{maxChapter?:number}} [opts]
 */
export function splitLongChapters(text, chapters, { maxChapter = MAX_CHAPTER_CHARS } = {}) {
  const out = [];
  for (const h of chapters) {
    if (h.end - h.bodyStart > maxChapter) {
      const ranges = chunkRanges(text, h.bodyStart, h.end, maxChapter);
      ranges.forEach((r, k) =>
        out.push({
          title: `${h.title}（${k + 1}/${ranges.length}）`,
          start: k === 0 ? h.start : r.bodyStart,
          bodyStart: r.bodyStart,
          end: r.end,
        }));
    } else out.push(h);
  }
  return out;
}

/**
 * @param {string} text 归一化后的全文
 * @param {{chunkSize?:number, maxChapter?:number}} [opts]
 */
export function splitChapters(text, { chunkSize = DEFAULT_CHUNK, maxChapter = MAX_CHAPTER_CHARS } = {}) {
  const len = text.length;
  if (!len) return [];

  // 1) 扫描标题行
  const heads = [];
  const numbered = [];
  let lineStart = 0;
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? len : nl;
    const line = text.slice(lineStart, lineEnd);
    const t = line.trim();
    if (isHeadingLine(line)) {
      heads.push({ title: t, start: lineStart, bodyStart: lineEnd + 1 });
    } else if (t && t.length <= MAX_TITLE_LEN && !t.includes('。')) {
      const m = t.match(NUMBERED_RE);
      if (m) numbered.push({ num: Number(m[1]), title: t, start: lineStart, bodyStart: lineEnd + 1 });
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  heads.push(...pickNumberedRuns(numbered));
  heads.sort((a, b) => a.start - b.start);

  // 2) 没有任何标题：整篇按长度分段
  if (heads.length === 0) {
    const ranges = chunkRanges(text, 0, len, chunkSize);
    return ranges.map((r, i) => ({
      title: ranges.length === 1 ? '正文' : `第 ${i + 1} 段`,
      start: r.bodyStart,
      bodyStart: r.bodyStart,
      end: r.end,
    }));
  }

  const chapters = [];

  // 3) 第一个标题之前的正文
  if (heads[0].start > 0 && text.slice(0, heads[0].start).trim()) {
    const ranges = chunkRanges(text, 0, heads[0].start, chunkSize);
    for (const r of ranges) {
      chapters.push({ title: '开篇', start: r.bodyStart, bodyStart: r.bodyStart, end: r.end });
    }
  }

  // 4) 每个标题到下一个标题之间为一章；过长的章统一走 splitLongChapters 再切分
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].start : len;
    chapters.push({ title: h.title, start: h.start, bodyStart: Math.min(h.bodyStart, end), end });
  }

  return splitLongChapters(text, chapters, { maxChapter });
}
