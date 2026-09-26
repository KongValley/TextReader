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

/**
 * 手写最小 PDF（PDF 1.4，ASCII 文本 + 嵌套大纲）：
 * 2 页、3 个目录项（其中 1 个是子项），正文里放了两个可查找的标记串。
 * 对象编号：1 Catalog / 2 Pages / 3,4 页1+内容 / 5 字体 / 6,7 页2+内容 / 8 Outlines / 9-11 目录项
 */
function buildOutlinePdf() {
  const stream = (body) => `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  const content1 =
    'BT /F1 18 Tf 72 780 Td (Chapter 1 - Start) Tj 0 -28 Td (Search term: MARKER-ALPHA) Tj 0 -28 Td ' +
    '(This is the first page of the outline fixture.) Tj ET';
  const content2 =
    'BT /F1 18 Tf 72 780 Td (Chapter 2 - Review) Tj 0 -28 Td (Search term: MARKER-BETA) Tj 0 -28 Td ' +
    '(Section 2.1 - Detail) Tj 0 -28 Td (This is the second page of the outline fixture.) Tj ET';

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /PageMode /UseOutlines >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream(content1),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    stream(content2),
    '<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 3 >>',
    '<< /Title (Chapter 1 - Start) /Parent 8 0 R /Next 10 0 R /Dest [3 0 R /Fit] >>',
    '<< /Title (Chapter 2 - Review) /Parent 8 0 R /Prev 9 0 R /First 11 0 R /Last 11 0 R /Count 1 /Dest [6 0 R /Fit] >>',
    '<< /Title (Section 2.1 - Detail) /Parent 10 0 R /Dest [6 0 R /Fit] >>',
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/** 同上，但加一个 Standard 安全处理器：pdf.js 会以 PasswordException 拒绝（用于验证加密 PDF 的提示） */
function buildLockedPdf() {
  const base = buildOutlinePdf();
  const encrypt = `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -1 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> >>`;
  const ids = `/ID [<${'11'.repeat(16)}> <${'22'.repeat(16)}>]`;

  // 在 xref 之前插入 /Encrypt 对象（编号 12），并在 xref 表里补上它，再改写 trailer
  const xrefAt = base.indexOf('xref\n');
  const head = base.slice(0, xrefAt);
  const encryptOffset = head.length;
  const withEncrypt = `${head}12 0 obj\n${encrypt}\nendobj\n`;

  const lines = base.slice(xrefAt).split('\n');
  const size = Number(lines[1].split(' ')[1]); // 原有条目数（含 free 项）
  const entries = lines.slice(2, 2 + size);
  entries.push(`${String(encryptOffset).padStart(10, '0')} 00000 n `);
  const tail = [
    'xref',
    `0 ${size + 1}`,
    ...entries,
    `trailer\n<< /Size ${size + 1} /Root 1 0 R /Encrypt 12 0 R ${ids} >>`,
    'startxref',
    String(withEncrypt.length),
    '%%EOF',
    '',
  ].join('\n');
  return withEncrypt + tail;
}

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
//    同名内容 + 加密字典：用于验证「加密 PDF 给出提示而不是白屏」这条错误路径
fs.writeFileSync(path.join(DIR, 'locked.pdf'), Buffer.from(buildLockedPdf(), 'latin1'));

const sizes = fs
  .readdirSync(DIR)
  .map((f) => `${f}: ${fs.statSync(path.join(DIR, f)).size} B`)
  .join('\n');
console.log(sizes);
