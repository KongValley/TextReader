/**
 * 文本编码探测与解码（主进程）。
 *
 * 顺序：BOM → 无 BOM 的 UTF-16 启发式 → 严格 UTF-8 → GB18030 / Big5 打分。
 * 解码后统一归一化：去掉 NUL、CRLF→LF、去掉行首 BOM 字符。
 */

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UTF8_LOOSE = new TextDecoder('utf-8', { ignoreBOM: true });
const cache = new Map();

function dec(label) {
  let d = cache.get(label);
  if (!d) {
    d = new TextDecoder(label, { ignoreBOM: true });
    cache.set(label, d);
  }
  return d;
}

export const ENCODINGS = [
  { id: 'auto', label: '自动检测' },
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'gb18030', label: 'GB18030 / GBK / GB2312' },
  { id: 'big5', label: 'Big5（繁体）' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
];

// 高频汉字，用于给“GB18030 解出来像不像中文”打分
const COMMON = new Set(
  '的一是不了在人有我他这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感',
);

/** 归一化：去掉 NUL、统一换行、去掉首字符 BOM、压缩连续替换符。 */
export function normalize(text) {
  return text
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .replace(/\uFFFD{3,}/g, '\uFFFD');
}

function nulStats(buf) {
  const n = Math.min(buf.length, 8192) & ~1;
  let even = 0;
  let odd = 0;
  let total = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) even++;
    if (buf[i + 1] === 0) odd++;
    total++;
  }
  return total ? { even: even / total, odd: odd / total } : { even: 0, odd: 0 };
}

/** 解码（已归一化）后的“像不像正常中文文本”打分。 */
function textScore(text) {
  const s = text.length > 60000 ? text.slice(0, 60000) : text;
  let common = 0;
  let fffd = 0;
  let ctrl = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\uFFFD') {
      fffd++;
      continue;
    }
    const c = s.charCodeAt(i);
    if (c < 0x20 && ch !== '\n' && ch !== '\t') {
      ctrl++;
    } else if (c >= 0x4e00 && c <= 0x9fff) {
      if (COMMON.has(ch)) common++;
    } else if (c >= 0xe000 && c <= 0xf8ff) {
      ctrl++; // 私有区：乱码的典型特征
    }
  }
  return { common, fffd, ctrl, ratio: s.length ? common / s.length : 0 };
}

const CANDIDATES = ['utf-16le', 'utf-16be', 'gb18030', 'big5'];

/**
 * 无 BOM 且非 UTF-8 时，在候选编码里挑“读起来最像中文”的那个。
 * 排序：无替换符 > NUL 位序信号 > 控制符更少 > 常用字比例更高 > 候选顺序。
 */
function pickCandidate(buf, nul) {
  const bonusLE = nul.odd > 0.2 && nul.odd > nul.even * 3;
  const bonusBE = nul.even > 0.2 && nul.even > nul.odd * 3;

  let best = null;
  for (let i = 0; i < CANDIDATES.length; i++) {
    const enc = CANDIDATES[i];
    const text = normalize(dec(enc).decode(buf));
    const s = textScore(text);
    const rank = [
      s.fffd > 0 ? 1 : 0,
      (enc === 'utf-16le' && bonusLE) || (enc === 'utf-16be' && bonusBE) ? 0 : 1,
      s.ctrl,
      -s.ratio,
      i,
    ];
    if (!best || less(rank, best.rank)) best = { enc, text, rank, score: s };
  }
  return best;
}

function less(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * @param {Buffer} buf
 * @param {string} [forced] 指定编码（'auto' 或 undefined 表示自动检测）
 * @returns {{text:string, encoding:string, warning:boolean}}
 */
export function decodeBuffer(buf, forced) {
  if (!buf || buf.length === 0) return { text: '', encoding: forced && forced !== 'auto' ? forced : 'utf-8', warning: false };

  if (forced && forced !== 'auto') {
    const text = normalize(dec(forced).decode(buf));
    return { text, encoding: forced, warning: text.includes('\uFFFD') };
  }

  // 1) BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: normalize(UTF8_LOOSE.decode(buf.subarray(3))), encoding: 'utf-8', warning: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: normalize(dec('utf-16le').decode(buf.subarray(2))), encoding: 'utf-16le', warning: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: normalize(dec('utf-16be').decode(buf.subarray(2))), encoding: 'utf-16be', warning: false };
  }

  // 2) 无 BOM 的 UTF-16：大量 NUL 且集中在同一字节位
  const nul = nulStats(buf);
  const strongUtf16 = (nul.odd > 0.2 && nul.odd > nul.even * 3) || (nul.even > 0.2 && nul.even > nul.odd * 3);
  if (!strongUtf16) {
    // 3) 严格 UTF-8（NUL 不会破坏它，所以有 UTF-16 信号时要跳过）
    try {
      return { text: normalize(UTF8_STRICT.decode(buf)), encoding: 'utf-8', warning: false };
    } catch {
      /* 不是 UTF-8 */
    }
  }

  // 4) 中文旧编码 / 无 BOM 的 UTF-16：按打分挑
  const best = pickCandidate(buf, nul);
  return { text: best.text, encoding: best.enc, warning: best.score.fffd > 0 };
}
