/**
 * EPUB 打开链路单测：主进程 ZIP 解包 + XML tokenizer + OPF/nav/NCX 组装成文本流与章节表。
 * 渲染层（重排/翻页/查找/划线）由 scripts/smoke.js 在真实 Electron 窗口里验证。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EPUB_MAX_BYTES, isEpubPath, readEpubFile } from '../src/main/epub.js';
import { splitLongChapters } from '../src/shared/chapters.js';
import { Store } from '../src/main/store.js';
import { buildZip } from '../scripts/epub-fixtures.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const OUTLINE = path.join(FIXTURES, 'outline.epub');
const OUTLINE_NCX = path.join(FIXTURES, 'outline-ncx.epub');
const ANCHORED = path.join(FIXTURES, 'anchored.epub');
const NO_TOC = path.join(FIXTURES, 'no-toc.epub');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txtreader-epub-'));
  return new Store(path.join(dir, 'state.json'));
}

test('isEpubPath 只认 .epub 扩展名（大小写不敏感）', () => {
  assert.equal(isEpubPath('D:/书/测试.epub'), true);
  assert.equal(isEpubPath('D:/书/测试.EPUB'), true);
  assert.equal(isEpubPath('D:/书/测试.epub.txt'), false);
  assert.equal(isEpubPath('D:/书/小说.txt'), false);
  assert.equal(isEpubPath('D:/书/报告.pdf'), false);
  assert.equal(isEpubPath(''), false);
  assert.equal(isEpubPath(null), false);
  assert.equal(isEpubPath(undefined), false);
});

test('outline.epub：nav 目录 → 文本流 + 3 章，ncx 外的 nav 页不进正文', async () => {
  const store = tmpStore();
  const res = await readEpubFile(OUTLINE, { store });

  assert.equal(res.kind, 'epub');
  assert.equal(res.encoding, 'epub');
  assert.equal(res.name, 'outline.epub');
  assert.equal(res.size, fs.statSync(OUTLINE).size);

  // 实体解码：&amp; → &，且不留原始实体文本
  assert.match(res.text, /第二段 & 实体测试/);
  assert.ok(!res.text.includes('&amp;'), '命名实体必须已解码');
  // deflate 条目（method 8）内容完整
  assert.match(res.text, /MARKER-ONE/);
  assert.match(res.text, /MARKER-TWO/);
  assert.match(res.text, /块内文字/);
  // nav 页进 spine 但不被任何 TOC 条目引用 → 排除
  assert.ok(!res.text.includes('目录导航页'), '导航页文字不能混进正文');

  assert.deepEqual(res.chapters.map((c) => c.title), ['书名', '第一章 起点', '第二章 转折']);
  // 无开篇章：首个锚点之前只有块级换行，没有非空白文本
  assert.equal(res.chapters[0].title, '书名');
  for (let i = 1; i < res.chapters.length; i++) {
    assert.ok(res.chapters[i].bodyStart > res.chapters[i - 1].bodyStart, 'bodyStart 单调递增');
  }

  // 标题行去重：第一章正文切片不含标题行本身
  const c1 = res.chapters.find((c) => c.title === '第一章 起点');
  const body1 = res.text.slice(c1.bodyStart, c1.end);
  assert.ok(!body1.includes('第一章 起点'), '正文不应重复章标题行');
  assert.match(body1, /MARKER-ONE/);

  // 章节区间连续
  for (let i = 1; i < res.chapters.length; i++) {
    assert.equal(res.chapters[i].start, res.chapters[i - 1].end, '章节区间无缝隙');
  }
  assert.equal(res.chapters.at(-1).end, res.text.length);
});

test('outline-ncx.epub：nav 坏掉/无 nav 标记时回退 NCX，章节一致', async () => {
  const store = tmpStore();
  const res = await readEpubFile(OUTLINE_NCX, { store });
  assert.deepEqual(res.chapters.map((c) => c.title), ['书名', '第一章 起点', '第二章 转折']);
});

test('anchored.epub：%编码 href 解码成功，同偏移去重后 3 章', async () => {
  const store = tmpStore();
  const res = await readEpubFile(ANCHORED, { store });
  assert.deepEqual(res.chapters.map((c) => c.title), ['第一节 起点', '第二节 转折', '第三节 终局']);
  assert.equal(res.chapters.length, 3, '副本锚点必须按同偏移去重');
  // 各章 bodyStart 落在对应节的正文上（而不是节的标题行之前）
  assert.match(res.text.slice(res.chapters[0].bodyStart, res.chapters[0].end), /ALPHA|起点/);
  assert.match(res.text.slice(res.chapters[1].bodyStart, res.chapters[1].end), /BETA/);
  assert.match(res.text.slice(res.chapters[2].bodyStart, res.chapters[2].end), /GAMMA/);
});

test('no-toc.epub：无目录时 splitChapters 兜底（开篇 + 两章）', async () => {
  const store = tmpStore();
  const res = await readEpubFile(NO_TOC, { store });
  assert.deepEqual(res.chapters.map((c) => c.title), ['开篇', '第一章 起点', '第二章 转折']);
  assert.match(res.chapters[1] && res.text.slice(res.chapters[1].bodyStart, res.chapters[1].end), /MARKER-ONE/);
});

test('超过 100MB 直接拒绝，且不写入任何记录', async () => {
  const store = tmpStore();
  const file = path.join(os.tmpdir(), 'too-big.epub');
  fs.writeFileSync(file, Buffer.from('application/epub+zip'));
  await assert.rejects(readEpubFile(file, { store, stat: fakeStat(file, EPUB_MAX_BYTES + 1) }), (err) => {
    assert.match(err.message, /EPUB 过大（超过 100MB）/);
    return true;
  });
  assert.equal(store.recent.length, 0, '拒绝后不能留下最近打开记录');
  assert.equal(Object.keys(store.data.books ?? {}).length, 0, '拒绝后不能写下任何书籍记录');
  fs.rmSync(file, { force: true });
});

function fakeStat(filePath, size) {
  return { isFile: () => true, size };
}

test('同名同大小继承原阅读进度与书签', async () => {
  const store = tmpStore();
  // 先读一次，写入进度
  const first = await readEpubFile(OUTLINE, { store });
  store.setBook(OUTLINE, { chapterIndex: 2, percent: 0.5, bookmarks: [{ id: 'b1', index: 2 }] });

  // 模拟文件被移动/改名：同名同大小（复制到别的目录，文件名不变）→ 继承
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'txtreader-epub-moved-'));
  const moved = path.join(otherDir, 'outline.epub');
  fs.copyFileSync(OUTLINE, moved);
  const res = await readEpubFile(moved, { store });
  assert.equal(res.book.chapterIndex, 2, '继承后的进度应可用');
  assert.equal(res.inherited?.from, OUTLINE);
  assert.deepEqual(res.inherited, { from: OUTLINE, chapterIndex: 2 });
  assert.deepEqual(res.book.bookmarks, [{ id: 'b1', index: 2 }]);
  assert.equal(first.kind, 'epub');
  fs.rmSync(otherDir, { recursive: true, force: true });
});

test('损坏的 EPUB：随机字节 / 缺 container.xml 都有明确报错', async () => {
  const store = tmpStore();
  const junk = path.join(os.tmpdir(), 'junk.epub');
  fs.writeFileSync(junk, Buffer.from('not a zip at all, just bytes'));
  await assert.rejects(readEpubFile(junk, { store }), /EPUB 无法解析/);
  fs.rmSync(junk, { force: true });

  // 合法 ZIP 但缺 META-INF/container.xml
  const noContainer = path.join(os.tmpdir(), 'no-container.epub');
  fs.writeFileSync(noContainer, buildZip([{ name: 'OEBPS/content.opf', data: '<package/>' }]));
  await assert.rejects(readEpubFile(noContainer, { store }), /缺少 container\.xml/);
  fs.rmSync(noContainer, { force: true });
});

test('splitLongChapters：超长章按阈值切分，区间连续', () => {
  const text = '一'.repeat(61000);
  const out = splitLongChapters(text, [{ title: '长章', start: 0, bodyStart: 0, end: text.length }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '长章（1/2）');
  assert.equal(out[1].title, '长章（2/2）');
  assert.equal(out[0].end, out[1].start, '切分后区间必须连续无缝隙');
  assert.equal(out[1].end, text.length);
});

test('readEpubFile 记账：encoding=epub 且进入最近打开', async () => {
  const store = tmpStore();
  await readEpubFile(OUTLINE, { store });
  const book = store.getBook(OUTLINE);
  assert.equal(book.encoding, 'epub');
  assert.equal(book.name, 'outline.epub');
  assert.ok(store.recent.some((r) => r.path === OUTLINE), 'recent 必须包含该文件');
});
