/** 测试用 EPUB 样本生成器（纯 Node，无第三方依赖）。
 * - buildZip(entries): 手工拼 ZIP（本地头 + 中央目录 + EOCD），CRC32 写 0（本仓库解析器不校验）
 * - buildOutlineEpub(): EPUB3 nav 目录 + 3 个 spine 文件 + 一个不被 TOC 引用的 nav 页（测排除规则）
 * - buildNcxEpub(): 同内容，目录走 NCX（回退链）
 * - buildAnchoredEpub(): 单文件多锚点 + %编码 href + 同偏移去重
 * - buildNoTocEpub(): 无任何目录（测 splitChapters 全文兜底）
 * 供 scripts/gen-fixtures.mjs 写盘、test/epub.test.js 与 scripts/smoke.js 使用
 */
import zlib from 'node:zlib';

const crc32Table = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crc32Table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 日期 DosTime/DosDate 用一个固定值即可（2020-01-01 00:00:00） */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/**
 * 手工 ZIP：全部本地头 + 中央目录 + EOCD。
 * @param {{name:string, data:string|Buffer, deflate?:boolean}[]} entries
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [index, e] of entries.entries()) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const isStore = !e.deflate;
    const data = isStore ? raw : zlib.deflateRawSync(raw);
    const method = isStore ? 0 : 8;
    const crc = crc32(raw);
    const nameBytes = Buffer.from(e.name, 'utf8');

    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    nameBytes.copy(local, 30);
    data.copy(local, 30 + nameBytes.length);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

const XHTML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';

/** 正文内容：书名页、两章；nav 页进 spine 但不被 TOC 引用。 */
const BODY_FILES = [
  {
    name: 'OEBPS/t1.xhtml',
    data: `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>书名页</title></head><body><h1 id="t">测试书</h1><p>这里是简介页。</p></body></html>`,
  },
  {
    name: 'OEBPS/c1.xhtml',
    deflate: true, // 测 method 8
    data: `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1 id="c1">第一章 起点</h1><p>正文一 MARKER-ONE 出现。</p><p>第二段 &amp; 实体测试。</p><div>块内文字</div></body></html>`,
  },
  {
    name: 'OEBPS/c2.xhtml',
    data: `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1 id="c2">第二章 转折</h1><p>正文二 MARKER-TWO。</p><br/><p>换行后段落。</p></body></html>`,
  },
];

function containerXml() {
  return '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>';
}

function opf({ toc }) {
  const items = [
    `<item id="t1" href="t1.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>`,
    toc === 'none' ? null : toc === 'ncx'
      ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>`
      : `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    toc === 'ncx' ? `<item id="ncx" href="ncx.xhtml" media-type="application/x-dtbncx+xml"/>` : null,
  ]
    .filter(Boolean)
    .map((s) => `    ${s}`)
    .join('\n');
  const spineToc = toc === 'ncx' ? ' toc="ncx"' : '';
  const navRef = toc === 'none' ? '' : `\n    <itemref idref="nav"/>`;
  return `${XHTML_HEAD}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>EPUB 测试书</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="pub-id">urn:uuid:00000000-0000-0000-0000-000000000000</dc:identifier>
  </metadata>
  <manifest>
${items}
  </manifest>
  <spine${spineToc}>
    <itemref idref="t1"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>${navRef}
  </spine>
</package>`;
}

const NAV_DOC = `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><h2>目录导航页</h2><ol><li><a href="t1.xhtml">书名</a></li><li><a href="c1.xhtml">第一章 起点</a></li><li><a href="c2.xhtml">第二章 转折</a></li></ol></nav></body></html>`;

const NCX_DOC = `${XHTML_HEAD}<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:00000000-0000-0000-0000-000000000000"/></head><docTitle><text>EPUB 测试书</text></docTitle><navMap><navPoint id="np1" playOrder="1"><navLabel><text>书名</text></navLabel><content src="t1.xhtml"/></navPoint><navPoint id="np2" playOrder="2"><navLabel><text>第一章 起点</text></navLabel><content src="c1.xhtml"/></navPoint><navPoint id="np3" playOrder="3"><navLabel><text>第二章 转折</text></navLabel><content src="c2.xhtml"/></navPoint></navMap></ncx>`;

/** 样本构造核心：@param {{toc?:'nav'|'ncx'|'none'}} opts */
function buildEpub({ toc = 'nav' } = {}) {
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip', deflate: false },
    { name: 'META-INF/container.xml', data: containerXml() },
    { name: 'OEBPS/content.opf', data: opf({ toc }) },
    ...BODY_FILES.map((f) => ({ name: f.name, data: f.data, deflate: !!f.deflate })),
  ];
  if (toc !== 'none') entries.push({ name: 'OEBPS/nav.xhtml', data: NAV_DOC });
  if (toc === 'ncx') entries.push({ name: 'OEBPS/ncx.xhtml', data: NCX_DOC });
  return buildZip(entries);
}

/** 单文件多锚点：%编码 href + 同偏移去重 → 期望 3 章而不是 4 章 */
function buildAnchored() {
  const content = `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>锚点书</title></head><body>
<div id="s1"><h2>第一节 起点</h2><p>锚点一 ALPHA 段落。</p><p>再一段。</p></div>
<div id="s2"><h2>第二节 转折</h2><p>锚点二 BETA 段落。</p><p>再一段。</p></div>
<div id="s3"><h2>第三节 终局</h2><p>锚点三 GAMMA 段落。</p><p>再一段。</p></div>
</body></html>`;
  const nav = `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>
<li><a href="content.xhtml#s2">第二节 转折</a></li>
<li><a href="content.xhtml#s1">第一节 起点</a></li>
<li><a href="cont%65nt.xhtml#s1">第一节 起点（副本）</a></li>
<li><a href="content.xhtml#s3">第三节 终局</a></li>
</ol></nav></body></html>`;
  const opfSrc = `${XHTML_HEAD}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>锚点书</dc:title></metadata>
  <manifest>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="content"/><itemref idref="nav"/></spine>
</package>`;
  return buildZip([
    { name: 'mimetype', data: 'application/epub+zip', deflate: false },
    { name: 'META-INF/container.xml', data: containerXml() },
    { name: 'OEBPS/content.opf', data: opfSrc },
    { name: 'OEBPS/content.xhtml', data: content },
    { name: 'OEBPS/nav.xhtml', data: nav },
  ]);
}

/** EPUB3 nav 目录样本（含被 TOC 排除的导航页、实体、<br/>） */
export const buildOutlineEpub = () => buildEpub({ toc: 'nav' });

/** 目录退化为 NCX 的样本 */
export const buildNcxEpub = () => buildEpub({ toc: 'ncx' });

/** 锚点定位样本（单文件 + %编码 + 同偏移去重） */
export const buildAnchoredEpub = buildAnchored;

/** 无目录样本：全文走 splitChapters 兜底 */
export const buildNoTocEpub = () => buildEpub({ toc: 'none' });
