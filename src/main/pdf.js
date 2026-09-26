/**
 * PDF 打开路径：只负责「读字节 + 记录进度」，解析与渲染全部交给渲染进程里的 pdf.js。
 * 不在这里解码文本——PDF 是二进制格式，按编码猜测处理只会得到乱码。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 二进制整份走 IPC 结构化克隆，100MB 是实测可接受的上限（>256MB 的 TXT 上限不适用）。 */
export const PDF_MAX_BYTES = 100 * 1024 * 1024;

export const isPdfPath = (filePath) => /\.pdf$/i.test(String(filePath ?? ''));

/**
 * @param {string} filePath
 * @param {{ store: import('./store.js').Store, stat?: import('node:fs').Stats }} deps
 * @returns {Promise<object>} 渲染进程 payload（data 为精确切片的 ArrayBuffer）
 */
export async function readPdfFile(filePath, { store, stat }) {
  const st = stat ?? (await fsp.stat(filePath));
  if (!st.isFile()) throw new Error('目标不是文件');
  if (st.size > PDF_MAX_BYTES) throw new Error('PDF 过大（超过 100MB）');

  const buf = await fsp.readFile(filePath);
  const name = path.basename(filePath);
  // 与 TXT 一致：文件被移动/改名后按「同名同大小」沿用原进度与书签
  const inherited = store.inheritBook(filePath, { name, size: st.size });
  store.touchRecent({ path: filePath, name, size: st.size });
  const book = store.setBook(filePath, { encoding: 'pdf', name, size: st.size });

  return {
    kind: 'pdf',
    path: filePath,
    name,
    size: st.size,
    encoding: 'pdf',
    // Buffer 可能来自 Node 的共享内存池（byteOffset/byteLength 之外还有别的字节），
    // 只把这一段切出来，避免把无关字节一起序列化过去。
    data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    book,
    inherited: inherited ? { from: inherited.inheritedFrom, page: book.chapterIndex } : null,
  };
}
