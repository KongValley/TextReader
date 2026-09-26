/**
 * 把 pdf.js 的大纲（可嵌套）拍平成可直接渲染的目录项，并把 dest 解析成 0 基页号。
 * 纯逻辑，不碰 DOM，便于单测。
 */

/** 目录缩进最多到第 4 层，更深的层不再区分。 */
export const MAX_OUTLINE_DEPTH = 4;

/**
 * @param {any} doc pdf.js 的 PDFDocumentProxy（或同形状的假对象）
 * @returns {Promise<Array<{ title: string, page: number, depth: number }>>}
 */
export async function buildOutline(doc, { max = 2000 } = {}) {
  let raw;
  try {
    raw = await doc.getOutline();
  } catch {
    return [];
  }
  if (!Array.isArray(raw) || !raw.length) return [];

  const out = [];
  const walk = async (items, depth) => {
    for (const item of items) {
      if (!item || out.length >= max) return;
      const title = String(item.title ?? '').trim();
      const page = await destToPage(doc, item.dest);
      if (title && page !== null) out.push({ title, page, depth: Math.min(depth, MAX_OUTLINE_DEPTH - 1) });
      if (Array.isArray(item.items) && item.items.length) await walk(item.items, depth + 1);
    }
  };
  await walk(raw, 0);
  return out;
}

/**
 * 大纲项的目标可能是：命名目标字符串、显式目标数组（首元素为页号或页对象引用）。
 * 解析不出来时返回 null（该项不进目录，但同级其它项照常显示）。
 */
export async function destToPage(doc, dest) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const ref = explicit[0];
    if (Number.isInteger(ref) && ref >= 0) return ref; // 已经是 0 基页号
    if (ref && typeof ref === 'object') return await doc.getPageIndex(ref);
  } catch {
    /* 坏目标：忽略该项 */
  }
  return null;
}
