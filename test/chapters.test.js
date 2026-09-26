import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isHeadingLine, splitChapters } from '../src/shared/chapters.js';
import { normalize } from '../src/main/encoding.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const novel = normalize(fs.readFileSync(path.join(DIR, 'novel-utf8.txt'), 'utf8'));

test('isHeadingLine 只认真正的标题行', () => {
  assert.ok(isHeadingLine('第一章 无人应答的信号'));
  assert.ok(isHeadingLine('  第十二回 归零  '));
  assert.ok(isHeadingLine('序章 深潜'));
  assert.ok(isHeadingLine('番外 未寄出的信'));
  assert.ok(isHeadingLine('第123章：决战'));
  assert.ok(!isHeadingLine('他翻开第一章。'));
  assert.ok(!isHeadingLine('第一章讲的是一个人如何学会沉默，以及如何在沉默里活下去。'));
  assert.ok(!isHeadingLine('“第一章？”'));
  assert.ok(!isHeadingLine(''));
});

test('真实小说：开篇 + 全部章节都被解析', () => {
  const chapters = splitChapters(novel);
  const titles = chapters.map((c) => c.title);
  assert.equal(titles[0], '开篇');
  for (const t of ['序章 深潜', '第一章 无人应答的信号', '第七章 反向回声', '第八章 归零', '番外 未寄出的信']) {
    assert.ok(titles.includes(t), `缺少章节：${t}`);
  }
  assert.equal(titles.at(-1), '番外 未寄出的信');
  assert.ok(chapters.length >= 10, `章节数偏少：${chapters.length}`);
});

test('章节偏移连续且正文不含标题行本身', () => {
  const chapters = splitChapters(novel);
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    assert.ok(ch.end > ch.bodyStart, `章节为空：${ch.title}`);
    if (ch.start !== ch.bodyStart) {
      const headingLine = novel.slice(ch.start, ch.bodyStart);
      assert.ok(headingLine.trim().startsWith(ch.title.split('（')[0].trim()), `标题与偏移不匹配：${headingLine}`);
    }
    if (i + 1 < chapters.length) assert.equal(ch.end, chapters[i + 1].start, '章节之间存在空隙或重叠');
  }
  assert.equal(chapters.at(-1).end, novel.length);
});

test('章节正文能被切片取出', () => {
  const chapters = splitChapters(novel);
  const ch = chapters.find((c) => c.title === '第一章 无人应答的信号');
  const body = novel.slice(ch.bodyStart, ch.end);
  assert.match(body, /沈砚醒来时/);
  assert.ok(!body.includes('第一章 无人应答的信号'));
  assert.match(body, /“不是日志。”/);
});

test('没有章节标题的文件按长度强制分段', () => {
  const text = normalize(fs.readFileSync(path.join(DIR, 'novel-noheading-crlf.txt'), 'utf8'));
  const chapters = splitChapters(text);
  assert.ok(chapters.length >= 2, `分段数：${chapters.length}`);
  assert.match(chapters[0].title, /^第 1 段$/);
  assert.match(chapters[1].title, /^第 2 段$/);
  for (const ch of chapters) {
    assert.ok(ch.end - ch.bodyStart <= 4000 + 300, `分段过长：${ch.end - ch.bodyStart}`);
    assert.equal(ch.start, ch.bodyStart);
  }
  assert.equal(chapters.at(-1).end, text.length);
});

test('短篇无标题文件只有一段，标题为“正文”', () => {
  const chapters = splitChapters('　　这是一段很短、没有任何标题的文字。\n\n　　第二行。');
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, '正文');
});

test('超长章节按 maxChapter 再切分并标注序号', () => {
  const body = Array.from({ length: 4000 }, (_, i) => `　　这是第 ${i} 行的正文内容，用来把章节撑长。`).join('\n');
  const text = `第一章 很长的章节\n${body}`;
  const chapters = splitChapters(text, { maxChapter: 20000 });
  assert.ok(chapters.length >= 3, `切分数量：${chapters.length}`);
  assert.match(chapters[0].title, /^第一章 很长的章节（1\/\d+）$/);
  assert.match(chapters[1].title, /（2\/\d+）$/);
  assert.equal(chapters[0].start, 0);
  for (let i = 0; i + 1 < chapters.length; i++) assert.equal(chapters[i].end, chapters[i + 1].start);
});

test('编号式标题（001 标题）被识别为章节，干扰行被排除', () => {
  const text = normalize(fs.readFileSync(path.join(DIR, 'novel-numbered.txt'), 'utf8'));
  const chapters = splitChapters(text);
  const titles = chapters.map((c) => c.title);
  assert.equal(chapters.length, 31, `章节数：${chapters.length}（开篇 + 30 章）`);
  assert.equal(titles[0], '开篇');
  assert.equal(titles[1], '001 第1章的标题');
  assert.equal(titles[30], '030 第30章的标题');
  assert.ok(!titles.some((t) => t.includes('分钟后')), '正文里的“5 分钟后”被误判为标题');
  assert.ok(!titles.some((t) => t.includes('米外')), '正文里的“300 米外”被误判为标题');
  for (let i = 0; i + 1 < chapters.length; i++) assert.equal(chapters[i].end, chapters[i + 1].start);
  assert.equal(chapters.at(-1).end, text.length);
});

test('编号重新开始（分卷）时两段序列都被识别', () => {
  const part = (from, to) =>
    Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(3, '0')} 标题${from + i}\n　　正文一行。`).join('\n');
  const text = `${part(1, 10)}\n第二卷 新的开始\n${part(1, 8)}`;
  const titles = splitChapters(text).map((c) => c.title);
  assert.ok(titles.includes('010 标题10'));
  assert.ok(titles.includes('001 标题1'));
  assert.equal(titles.filter((t) => /^\d{3} 标题/.test(t)).length, 18);
});

test('孤立的数字开头行不会成为章节', () => {
  const text = Array.from({ length: 40 }, (_, i) => `　　5 分钟后，第 ${i} 行正文。\n　　又一行正文。`).join('\n');
  const chapters = splitChapters(text);
  assert.equal(chapters[0].title, '正文', `实际：${chapters[0].title}`);
  assert.ok(!chapters.some((c) => c.title.startsWith('5 ')));
});

test('“2、陷阱系统……”这类带标点的正文行不算标题', () => {
  const text = ['2、陷阱系统，分为防范丧尸和防范人类入侵……', '3、安全出入口管理……', '4、自动化监控系统……', '5、应急疏散通道……', '6、备用电源……']
    .map((l) => `${l}\n　　正文内容。`)
    .join('\n');
  const titles = splitChapters(text).map((c) => c.title);
  assert.ok(!titles.some((t) => /^\d、/.test(t)), `误判：${titles.join(' | ')}`);
});

test('空文本返回空数组', () => {
  assert.deepEqual(splitChapters(''), []);
});
