import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/main/store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txtreader-store-'));
  const file = path.join(dir, 'state.json');
  return { file, store: new Store(file) };
}

const BIG = 14118027;

test('同名同大小的文件继承阅读进度与书签', () => {
  const { store } = tmpStore();
  store.setBook('D:/books/末世.txt', {
    name: '末世.txt',
    size: BIG,
    chapterIndex: 900,
    ratio: 0.42,
    percent: 0.55,
    bookmarks: [{ chapterIndex: 900, paraIndex: 3, preview: '抓大块头！', time: 1 }],
  });

  const got = store.inheritBook('F:/小说库/末世.txt', { name: '末世.txt', size: BIG });
  assert.ok(got, '应当继承');
  assert.equal(got.chapterIndex, 900);
  assert.equal(got.ratio, 0.42);
  assert.equal(got.bookmarks.length, 1);
  assert.equal(got.inheritedFrom, 'D:/books/末世.txt');
  assert.equal(store.getBook('F:/小说库/末世.txt').chapterIndex, 900);
  // 原记录保留（文件可能只是被复制）
  assert.equal(store.getBook('D:/books/末世.txt').chapterIndex, 900);
});

test('大小或文件名不同则不继承', () => {
  const { store } = tmpStore();
  store.setBook('D:/books/a.txt', { name: 'a.txt', size: 100, chapterIndex: 7 });
  assert.equal(store.inheritBook('D:/b/a.txt', { name: 'a.txt', size: 101 }), null);
  assert.equal(store.inheritBook('D:/b/other.txt', { name: 'other.txt', size: 100 }), null);
  assert.equal(store.getBook('D:/b/a.txt').chapterIndex, 0);
  assert.equal(store.getBook('D:/b/a.txt').updatedAt, 0);
});

test('目标路径已有记录时不覆盖', () => {
  const { store } = tmpStore();
  store.setBook('D:/books/a.txt', { name: 'a.txt', size: 100, chapterIndex: 7 });
  store.setBook('D:/other/a.txt', { name: 'a.txt', size: 100, chapterIndex: 2 });
  assert.equal(store.inheritBook('D:/other/a.txt', { name: 'a.txt', size: 100 }), null);
  assert.equal(store.getBook('D:/other/a.txt').chapterIndex, 2);
});

test('继承结果会落盘，重启后仍生效', () => {
  const { file, store } = tmpStore();
  store.setBook('D:/books/a.txt', { name: 'a.txt', size: 100, chapterIndex: 7 });
  store.inheritBook('E:/moved/a.txt', { name: 'a.txt', size: 100 });
  store.flush();

  const reopened = new Store(file);
  assert.equal(reopened.getBook('E:/moved/a.txt').chapterIndex, 7);
  assert.equal(reopened.getBook('E:/moved/a.txt').inheritedFrom, 'D:/books/a.txt');
});

test('找不到候选记录时返回 null，且不产生空记录', () => {
  const { store } = tmpStore();
  assert.equal(store.inheritBook('E:/x.txt', { name: 'x.txt', size: 10 }), null);
  assert.equal(store.getBook('E:/x.txt').updatedAt, 0);
  assert.equal(store.inheritBook('E:/y.txt', {}), null);
});

test('多本同名同大小的书时取第一条匹配', () => {
  const { store } = tmpStore();
  store.setBook('D:/1/shared.txt', { name: 'shared.txt', size: 50, chapterIndex: 3 });
  store.setBook('D:/2/shared.txt', { name: 'shared.txt', size: 50, chapterIndex: 8 });
  const got = store.inheritBook('E:/3/shared.txt', { name: 'shared.txt', size: 50 });
  assert.ok(got);
  assert.equal(got.chapterIndex, 3);
  assert.equal(got.inheritedFrom, 'D:/1/shared.txt');
});

test('进度与书签写入后能读回（含 name/size）', () => {
  const { store } = tmpStore();
  store.setBook('E:/book.txt', { name: 'book.txt', size: 999, chapterIndex: 12, ratio: 0.3, percent: 0.31 });
  const b = store.getBook('E:/book.txt');
  assert.equal(b.name, 'book.txt');
  assert.equal(b.size, 999);
  assert.equal(b.chapterIndex, 12);
  assert.ok(b.updatedAt > 0);
});
