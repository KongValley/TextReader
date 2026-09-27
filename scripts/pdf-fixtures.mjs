/** 测试用 PDF 样本生成器（纯 Node，无第三方依赖）。
 * - buildOutlinePdf(): 2 页 + 3 级嵌套大纲 + 可查找标记串的明文 PDF
 * - buildLockedPdf(): 同一份内容，但按 PDF 规范 Standard 安全处理器（V1/R2，RC4 40bit）真加密，
 *   密码见 LOCKED_PDF_PASSWORD；字符串与流都用「文件密钥 + 对象号」派生密钥 RC4 一遍
 * - 供 scripts/gen-fixtures.mjs 写盘、test/pdf.test.js 与 scripts/smoke.js 取密码
 */
import { createHash } from 'node:crypto';

/**
 * 手写最小 PDF（PDF 1.4，ASCII 文本 + 嵌套大纲）：
 * 2 页、3 个目录项（其中 1 个是子项），正文里放了两个可查找的标记串。
 * 对象编号：1 Catalog / 2 Pages / 3,4 页1+内容 / 5 字体 / 6,7 页2+内容 / 8 Outlines
 *           9-11 目录项 / 12 Encrypt（仅加密样本）
 *
 * 传 encrypt 时按 PDF 规范的 Standard 安全处理器（V1/R2，RC4 40bit）真加密：
 * 字符串与流都用「文件密钥 + 对象号」派生的密钥 RC4 一遍，所以用正确密码能完整还原文档。
 */
function buildPdfDoc({ encrypt = null } = {}) {
  const KEY_BYTES = 5; // 40bit
  const FILE_ID = Buffer.from('5f3c1a2b4d6e7f8091a2b3c4d5e6f708', 'hex');
  const P_FLAGS = -1;

  let fileKey = null;
  let ownerEntry = null;
  let userEntry = null;
  if (encrypt) {
    ownerEntry = computeOwnerEntry(encrypt.user, encrypt.owner, KEY_BYTES);
    fileKey = computeFileKey(encrypt.user, ownerEntry, P_FLAGS, FILE_ID, KEY_BYTES);
    userEntry = rc4(fileKey, PAD);
  }

  const hexString = (bytes) => `<${Buffer.from(bytes).toString('hex')}>`;
  /** 字符串：加密后写成十六进制串，省掉字面量转义 */
  const S = (num, text) => (encrypt ? hexString(rc4(objectKey(fileKey, num), Buffer.from(text, 'latin1'))) : `(${text})`);
  const STREAM = (num, body) => {
    const bytes = encrypt ? rc4(objectKey(fileKey, num), Buffer.from(body, 'latin1')) : Buffer.from(body, 'latin1');
    return `<< /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`;
  };

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
    STREAM(4, content1),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    STREAM(7, content2),
    '<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 3 >>',
    `<< /Title ${S(9, 'Chapter 1 - Start')} /Parent 8 0 R /Next 10 0 R /Dest [3 0 R /Fit] >>`,
    `<< /Title ${S(10, 'Chapter 2 - Review')} /Parent 8 0 R /Prev 9 0 R /First 11 0 R /Last 11 0 R /Count 1 /Dest [6 0 R /Fit] >>`,
    `<< /Title ${S(11, 'Section 2.1 - Detail')} /Parent 10 0 R /Dest [6 0 R /Fit] >>`,
  ];
  if (encrypt) {
    objs.push(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${P_FLAGS} ` +
        `/O ${hexString(ownerEntry)} /U ${hexString(userEntry)} >>`,
    );
  }
  const trailerExtra = encrypt ? ` /Encrypt 12 0 R /ID [${hexString(FILE_ID)} ${hexString(FILE_ID)}]` : '';

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/* ---------- RC4 / Standard 安全处理器（对应 PDF 规范 Algorithm 1-4，R2） ---------- */

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6,
  0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(...chunks) {
  const h = createHash('md5');
  for (const c of chunks) h.update(c);
  return new Uint8Array(h.digest());
}

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length); // Buffer：后面要按 latin1 原样写回文件（Uint8Array.toString 会变成十进制串）
  for (let i = 0, j = 0, k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/** 密码补/截到 32 字节（Algorithm 2 第 1 步） */
function padPassword(password) {
  const raw = Buffer.from(password, 'latin1').subarray(0, 32);
  const out = new Uint8Array(32);
  out.set(raw, 0);
  out.set(PAD.subarray(0, 32 - raw.length), raw.length);
  return out;
}

/** /O 条目：用 owner 密码派生的密钥 RC4 一遍补位后的 user 密码（Algorithm 3，R2） */
function computeOwnerEntry(userPassword, ownerPassword, keyBytes) {
  const ownerKey = md5(padPassword(ownerPassword)).subarray(0, keyBytes);
  return rc4(ownerKey, padPassword(userPassword));
}

/** 文件密钥：MD5(补位密码 ‖ /O ‖ /P(4 字节小端) ‖ /ID[0]) 取前 keyBytes 字节（Algorithm 2） */
function computeFileKey(userPassword, ownerEntry, flags, fileId, keyBytes) {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, flags, true);
  return md5(padPassword(userPassword), ownerEntry, p, fileId).subarray(0, keyBytes);
}

/** 单个对象用的密钥：MD5(文件密钥 ‖ 对象号(3) ‖ 代数(2)) 取前 min(n+5,16) 字节（Algorithm 1） */
function objectKey(fileKey, num, gen = 0) {
  const tail = Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
  return md5(fileKey, tail).subarray(0, Math.min(fileKey.length + 5, 16));
}

/** 测试用加密样本的密码（gen-fixtures 写盘、测试与冒烟都用它） */
export const LOCKED_PDF_PASSWORD = 'reader-1234';

/** 明文样本 */
export const buildOutlinePdf = () => buildPdfDoc();

/** 与明文样本内容相同、但用 LOCKED_PDF_PASSWORD 加密的样本 */
export const buildLockedPdf = () =>
  buildPdfDoc({ encrypt: { user: LOCKED_PDF_PASSWORD, owner: LOCKED_PDF_PASSWORD } });

