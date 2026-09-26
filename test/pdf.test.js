/**
 * PDF 打开链路单测：主进程读字节 + pdf.js 解析契约 + 大纲页号映射。
 * 渲染层（canvas/TextLayer）由 scripts/smoke.js 在真实 Electron 窗口里验证。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDF_MAX_BYTES, isPdfPath, readPdfFile } from '../src/main/pdf.js';
import { Store } from '../src/main/store.js';
import { buildOutline, destToPage } from '../src/renderer/pdf/outline.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const OUTLINE_PDF = path.join(FIXTURES, 'outline.pdf');
/** 本地真实 PDF 样本（.gitignore 里排除，只在开发机上存在） */
const SAMPLE_PDF = path.join(FIXTURES, 'sample.pdf');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txtreader-pdf-'));
  return new Store(path.join(dir, 'state.json'));
}

/** 用渲染进程同一套参数打开字节，验证主进程交出去的东西真的能被 pdf.js 解析。 */
async function openWithPdfjs(bytes) {
  // pdf.js 拒收 Node Buffer，只接受纯 Uint8Array（渲染进程走 IPC 拿到的就是后者）
  const data = bytes instanceof Uint8Array && !Buffer.isBuffer(bytes) ? bytes : new Uint8Array(bytes);
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;
  return { doc, task };
}

test('isPdfPath 只认 .pdf 扩展名（大小写不敏感）', () => {
  assert.equal(isPdfPath('D:/书/报告.pdf'), true);
  assert.equal(isPdfPath('D:/书/报告.PDF'), true);
  assert.equal(isPdfPath('D:/书/报告.pdf.txt'), false);
  assert.equal(isPdfPath('D:/书/小说.txt'), false);
  assert.equal(isPdfPath(''), false);
  assert.equal(isPdfPath(null), false);
  assert.equal(isPdfPath(undefined), false);
});

test('readPdfFile 交出可被 pdf.js 解析的字节，并按 PDF 记账', async () => {
  const store = tmpStore();
  const res = await readPdfFile(OUTLINE_PDF, { store });

  assert.equal(res.kind, 'pdf');
  assert.equal(res.encoding, 'pdf');
  assert.equal(res.name, 'outline.pdf');
  assert.equal(res.size, fs.statSync(OUTLINE_PDF).size);
  assert.ok(res.data instanceof ArrayBuffer, 'data 必须是 ArrayBuffer');
  assert.equal(res.data.byteLength, res.size);
  assert.equal(res.text, undefined, 'PDF 不做文本解码');

  const { doc, task } = await openWithPdfjs(res.data);
  assert.equal(doc.numPages, 2);
  const text = (await (await doc.getPage(1)).getTextContent()).items.map((it) => it.str).join('');
  assert.match(text, /MARKER-ALPHA/);
  await task.destroy();

  // 记录：最近打开 + 每本书（编码标记为 pdf，供菜单判断「重新加载」是否可用）
  assert.equal(store.recent[0].path, OUTLINE_PDF);
  assert.equal(store.getBook(OUTLINE_PDF).encoding, 'pdf');
  assert.equal(store.getBook(OUTLINE_PDF).size, res.size);
  assert.equal(store.getBook(OUTLINE_PDF).chapterIndex, 0);
});

test('readPdfFile 超过 100MB 直接拒绝，且不写任何记录', async () => {
  const store = tmpStore();
  await assert.rejects(
    () => readPdfFile(OUTLINE_PDF, { store, stat: { isFile: () => true, size: PDF_MAX_BYTES + 1 } }),
    /过大/,
  );
  assert.equal(store.recent.length, 0);
  assert.equal(store.getBook(OUTLINE_PDF).updatedAt, 0);
});

test('同名同大小的 PDF 继承阅读进度与书签', async () => {
  const store = tmpStore();
  const size = fs.statSync(OUTLINE_PDF).size;
  store.setBook('D:/旧目录/outline.pdf', {
    name: 'outline.pdf',
    size,
    encoding: 'pdf',
    chapterIndex: 1,
    bookmarks: [{ page: 1, title: 'Chapter 2 - Review', preview: 'MARKER-BETA', time: 1 }],
  });

  const res = await readPdfFile(OUTLINE_PDF, { store });
  assert.equal(res.book.chapterIndex, 1);
  assert.equal(res.book.bookmarks.length, 1);
  assert.equal(res.inherited?.page, 1);
  assert.equal(res.inherited?.from, 'D:/旧目录/outline.pdf');
});

test('大纲解析：标题、页号（0 基）与层级', async () => {
  const { doc, task } = await openWithPdfjs(fs.readFileSync(OUTLINE_PDF));
  const outline = await buildOutline(doc);
  assert.deepEqual(
    outline.map((o) => [o.title, o.page, o.depth]),
    [
      ['Chapter 1 - Start', 0, 0],
      ['Chapter 2 - Review', 1, 0],
      ['Section 2.1 - Detail', 1, 1],
    ],
  );
  await task.destroy();
});

test('没有大纲的文档返回空目录', async () => {
  const outline = await buildOutline({ getOutline: async () => null });
  assert.deepEqual(outline, []);
  assert.deepEqual(await buildOutline({ getOutline: async () => [] }), []);
  assert.deepEqual(await buildOutline({ getOutline: async () => { throw new Error('坏了'); } }), []);
});

test('destToPage：命名目标、页号、页引用与坏目标', async () => {
  const doc = {
    getDestination: async (name) => (name === 'ok' ? [1] : null),
    getPageIndex: async (ref) => {
      if (ref?.num === 7) return 3;
      throw new Error('bad ref');
    },
  };
  assert.equal(await destToPage(doc, 'ok'), 1);
  assert.equal(await destToPage(doc, [2]), 2);
  assert.equal(await destToPage(doc, [{ num: 7 }]), 3);
  assert.equal(await destToPage(doc, 'missing'), null);
  assert.equal(await destToPage(doc, [{ num: 9 }]), null);
  assert.equal(await destToPage(doc, null), null);
  assert.equal(await destToPage(doc, []), null);
});

test('加密 PDF：主进程照常交出字节，pdf.js 以 PasswordException 拒绝', async () => {
  const locked = path.join(FIXTURES, 'locked.pdf');
  const store = tmpStore();
  const res = await readPdfFile(locked, { store });
  assert.equal(res.kind, 'pdf');

  await assert.rejects(async () => {
    const { task } = await openWithPdfjs(res.data);
    await task.destroy();
  }, (err) => err.name === 'PasswordException');
});

test('损坏的 PDF：pdf.js 以 InvalidPDFException 拒绝', async () => {
  await assert.rejects(
    async () => {
      const { task } = await openWithPdfjs(Buffer.from('%PDF-1.4\nnot really a pdf\n'));
      await task.destroy();
    },
    (err) => err.name === 'InvalidPDFException',
  );
});

test('本地真实 PDF 样本（存在时才跑）', { skip: fs.existsSync(SAMPLE_PDF) ? false : 'test/fixtures/sample.pdf 不在本地（不入库）' }, async () => {
  const store = tmpStore();
  const res = await readPdfFile(SAMPLE_PDF, { store });
  const { doc, task } = await openWithPdfjs(res.data);

  assert.ok(doc.numPages > 0, `页数 ${doc.numPages}`);
  const first = (await (await doc.getPage(1)).getTextContent()).items.map((it) => it.str).join('');
  assert.ok(first.trim().length > 0, '首页文字非空');
  // 该样本没有大纲：目录应回落为空（界面显示“暂无目录”）
  assert.deepEqual(await buildOutline(doc), []);
  await task.destroy();
});
