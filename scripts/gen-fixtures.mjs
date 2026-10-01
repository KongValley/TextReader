/**
 * 生成测试用的不同编码样本（依赖 Windows PowerShell 做 GBK/Big5/UTF-16 转码）。
 * 用法：node scripts/gen-fixtures.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHeadingLine } from '../src/shared/chapters.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'test', 'fixtures');
const BASE = path.join(DIR, 'novel-utf8.txt');

const base = fs.readFileSync(BASE, 'utf8');

import { LOCKED_PDF_PASSWORD, buildLockedPdf, buildOutlinePdf } from './pdf-fixtures.mjs';
import { buildAnchoredEpub, buildNcxEpub, buildNoTocEpub, buildOutlineEpub } from './epub-fixtures.mjs';

function ps(fromFile, toFile, encodingName) {
  const script =
    `$t=[IO.File]::ReadAllText('${fromFile.replace(/'/g, "''")}',[Text.Encoding]::UTF8);` +
    `[IO.File]::WriteAllText('${toFile.replace(/'/g, "''")}',$t,[Text.Encoding]::${encodingName});`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' });
}

// 1) GBK / GB18030
ps(BASE, path.join(DIR, 'novel-gbk.txt'), 'GetEncoding(936)');
// 2) UTF-16LE（带 BOM）
ps(BASE, path.join(DIR, 'novel-utf16le.txt'), 'Unicode');
// 3) Big5（用繁体样本，cp950 才能无损编码）
const HANT = path.join(DIR, 'novel-zh-hant.txt');
if (fs.existsSync(HANT)) {
  try {
    ps(HANT, path.join(DIR, 'novel-big5.txt'), 'GetEncoding(950)');
  } catch (err) {
    console.warn('Big5 样本生成失败（系统可能未安装 code page 950）：', err.message);
  }
}
// 3b) UTF-16BE（带 BOM）
ps(BASE, path.join(DIR, 'novel-utf16be.txt'), 'BigEndianUnicode');

// 4) 去掉全部章节标题 + 重复 4 遍 + CRLF + 无 BOM，用于测试强制分段
const noHeading = Array.from({ length: 4 }, () =>
  base
    .split('\n')
    .filter((line) => !isHeadingLine(line))
    .join('\n'),
)
  .join('\n')
  .replace(/\n/g, '\r\n');
fs.writeFileSync(path.join(DIR, 'novel-noheading-crlf.txt'), noHeading, 'utf8');

// 5) 编号式标题样本：`001 标题`（真实网络小说导出的常见格式，含干扰行）
const numbered = ['《编号格式示例》', '', '　　这是一段书籍简介，位于第一个编号标题之前。', ''];
for (let i = 1; i <= 30; i++) {
  numbered.push(`${String(i).padStart(3, '0')} 第${i}章的标题`, '');
  for (let k = 0; k < 6; k++) {
    numbered.push(`　　这是第 ${i} 章的第 ${k + 1} 段正文，用来撑出足够的长度以便分页测试。`, '');
  }
  if (i === 7) numbered.push('　　5 分钟后，他们才反应过来这句话的意思。', '');
  if (i === 12) numbered.push('　　300 米外传来一声枪响，随后是长久的沉默。', '');
}
fs.writeFileSync(path.join(DIR, 'novel-numbered.txt'), numbered.join('\n'), 'utf8');

// 6) PDF 样本：手写一个最小的两页 PDF（含嵌套大纲），用于 PDF 渲染/目录/查找测试。
//    真实 PDF 样本（test/fixtures/sample.pdf）不入库，本文件保证 PDF 相关测试始终有输入。
fs.writeFileSync(path.join(DIR, 'outline.pdf'), Buffer.from(buildOutlinePdf(), 'latin1'));
//    同一份内容 + Standard 安全处理器（RC4 40bit）：用于验证密码输入链路
//    密码：LOCKED_PDF_PASSWORD（scripts/pdf-fixtures.mjs）
fs.writeFileSync(path.join(DIR, 'locked.pdf'), Buffer.from(buildLockedPdf(), 'latin1'));

// 7) EPUB 样本（手写 ZIP + XHTML）：nav 目录 / NCX 回退 / 锚点去重 / 无目录兜底
fs.writeFileSync(path.join(DIR, 'outline.epub'), buildOutlineEpub());
fs.writeFileSync(path.join(DIR, 'outline-ncx.epub'), buildNcxEpub());
fs.writeFileSync(path.join(DIR, 'anchored.epub'), buildAnchoredEpub());
fs.writeFileSync(path.join(DIR, 'no-toc.epub'), buildNoTocEpub());

const sizes = fs
  .readdirSync(DIR)
  .map((f) => `${f}: ${fs.statSync(path.join(DIR, f)).size} B`)
  .join('\n');
console.log(sizes);
