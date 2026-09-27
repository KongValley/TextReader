import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFontList } from '../src/main/fonts.js';

test('parseFontList：剥类型后缀、拆 & 复合项、去重', () => {
  const out = parseFontList('Arial (TrueType)\nMicrosoft YaHei & Microsoft YaHei UI (TrueType)\r\nKaiTi (OpenType)\n宋体 & 新宋体 (TrueType)\n\n');
  assert.equal(out.length, 6);
  for (const n of ['Arial', 'Microsoft YaHei', 'Microsoft YaHei UI', 'KaiTi', '宋体', '新宋体']) assert.ok(out.includes(n), n);
});

test('parseFontList：reg.exe 风格行只取名字段', () => {
  assert.deepEqual(parseFontList('    Arial (TrueType)    REG_SZ    arial.ttf\n'), ['Arial']);
});

test('parseFontList：空/乱输入不炸', () => {
  assert.deepEqual(parseFontList(undefined), []);
  assert.deepEqual(parseFontList(''), []);
  assert.deepEqual(parseFontList('   \n\t\n'), []);
  assert.deepEqual(parseFontList('123\n456'), []);
  assert.ok(Array.isArray(parseFontList('REG_SZ\tarial.ttf')));
});
