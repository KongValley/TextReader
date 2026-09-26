import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeBuffer, normalize } from '../src/main/encoding.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f) => fs.readFileSync(path.join(DIR, f));
const has = (f) => fs.existsSync(path.join(DIR, f));

test('UTF-8（无 BOM）识别为 utf-8', () => {
  const r = decodeBuffer(read('novel-utf8.txt'));
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.warning, false);
  assert.match(r.text, /回声实验室/);
  assert.match(r.text, /第一章 无人应答的信号/);
});

test('UTF-8（带 BOM）识别为 utf-8 且去掉 BOM 字符', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), read('novel-utf8.txt')]);
  const r = decodeBuffer(buf);
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.text[0], '《');
  assert.ok(!r.text.includes('\uFEFF'));
});

test('GBK/GB18030 识别为 gb18030 且中文正确', () => {
  const r = decodeBuffer(read('novel-gbk.txt'));
  assert.equal(r.encoding, 'gb18030');
  assert.equal(r.warning, false);
  assert.match(r.text, /回声实验室/);
  assert.match(r.text, /像一支被揉皱的箭/);
});

test('UTF-16LE（带 BOM）识别为 utf-16le', () => {
  const r = decodeBuffer(read('novel-utf16le.txt'));
  assert.equal(r.encoding, 'utf-16le');
  assert.match(r.text, /回声实验室/);
});

test('UTF-16BE（带 BOM）识别为 utf-16be', () => {
  if (!has('novel-utf16be.txt')) return;
  const r = decodeBuffer(read('novel-utf16be.txt'));
  assert.equal(r.encoding, 'utf-16be');
  assert.match(r.text, /回声实验室/);
});

test('无 BOM 的 UTF-16LE 通过 NUL 分布启发式识别', () => {
  const buf = Buffer.from('第一章 测试\n　　这是一段中文正文，用来验证无 BOM 的 UTF-16 检测。', 'utf16le');
  const r = decodeBuffer(buf);
  assert.equal(r.encoding, 'utf-16le');
  assert.match(r.text, /这是一段中文正文/);
});

test('无 BOM 的纯 ASCII UTF-16 也按字节位序正确识别', () => {
  const ascii = 'Chapter 1 The signal came from below.\nIt was three short, one long, two short.';
  const le = decodeBuffer(Buffer.from(ascii, 'utf16le'));
  assert.equal(le.encoding, 'utf-16le');
  assert.equal(le.text, ascii);

  const beBuf = Buffer.alloc(ascii.length * 2);
  for (let i = 0; i < ascii.length; i++) beBuf.writeUInt16BE(ascii.charCodeAt(i), i * 2);
  const be = decodeBuffer(beBuf);
  assert.equal(be.encoding, 'utf-16be');
  assert.equal(be.text, ascii);
});

test('Big5 繁体文本识别为 big5 而非 gb18030', { skip: !has('novel-big5.txt') }, () => {
  const r = decodeBuffer(read('novel-big5.txt'));
  assert.equal(r.encoding, 'big5', `实际识别为 ${r.encoding}`);
  assert.match(r.text, /回聲實驗室/);
  assert.match(r.text, /深潛/);
});

test('手动指定编码时按指定编码解码，乱码给出 warning', () => {
  const r = decodeBuffer(read('novel-gbk.txt'), 'utf-8');
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.warning, true);
  const ok = decodeBuffer(read('novel-gbk.txt'), 'gb18030');
  assert.equal(ok.warning, false);
  assert.match(ok.text, /回声实验室/);
});

test('空文件不报错', () => {
  const r = decodeBuffer(Buffer.alloc(0));
  assert.equal(r.text, '');
  assert.equal(r.warning, false);
});

test('normalize 统一换行、去掉 NUL 与首字符 BOM', () => {
  assert.equal(normalize('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(normalize('a\u0000b'), 'ab');
  assert.equal(normalize('\uFEFFabc'), 'abc');
});

test('真实样本的 CRLF 变体解码后没有残留 \\r', () => {
  const r = decodeBuffer(read('novel-noheading-crlf.txt'));
  assert.equal(r.encoding, 'utf-8');
  assert.ok(!r.text.includes('\r'));
});
