#!/usr/bin/env node
/**
 * Generates the application icon with no third-party dependencies.
 *
 *     node scripts/make-icon.mjs
 *
 * Writes:
 *   build/icon.png  - 256x256 32-bit RGBA PNG (rounded amber tile, cream book)
 *   build/icon.ico  - single-entry ICO whose 256x256 image is exactly that PNG
 *
 * The artwork is rasterised per pixel from signed-distance style shape tests
 * and anti-aliased with a 4x4 supersampling grid, so the output is
 * deterministic and contains no timestamps.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';


const SIZE = 256;    // icon edge, px
const SS = 4;        // supersampling factor per axis (4x4 = 16 samples/px)

// ---------------------------------------------------------------- palette --
const BG_TOP = [255, 185, 79];      // warm amber, top of the tile
const BG_BOTTOM = [227, 122, 26];   // deeper orange, bottom of the tile
const PAGE_TOP = [255, 253, 248];   // cream page, near the top
const PAGE_BOTTOM = [241, 224, 195];
const SPINE = [154, 76, 16];        // dark gutter between the two pages
const COVER_TOP = [176, 86, 18];    // book cover board, top
const COVER_BOTTOM = [131, 55, 8];  // book cover board, bottom

// -------------------------------------------------------------- small math --
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const mixRGB = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (v) => Math.hypot(v[0], v[1]);
const unit = (v) => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Convex polygon hit test (winding agnostic) via consistent half planes. */
function convex(pts) {
  const turn = Math.sign(pts.reduce((s, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return s + (p[0] * q[1] - q[0] * p[1]);
  }, 0)) || 1;
  const edges = pts.map((a, i) => [a, pts[(i + 1) % pts.length]]);
  return (x, y) => edges.every(([a, b]) =>
    ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) * turn >= 0);
}

/**
 * Convex polygon with corners trimmed by a tangent arc of radius `r`.
 * Each corner is kept whole when the point lies past a tangent point or
 * inside the corner arc; otherwise it is cut away.
 */
function rounded(pts, r) {
  const inside = convex(pts);
  const corners = pts.map((v, i) => {
    const u1 = unit(sub(pts[(i - 1 + pts.length) % pts.length], v));
    const u2 = unit(sub(pts[(i + 1) % pts.length], v));
    const half = Math.acos(clamp(dot(u1, u2), -1, 1)) / 2;   // half interior angle
    const tangent = r / Math.tan(half);                      // distance along each edge
    const centre = r / Math.sin(half);
    const bisector = unit([u1[0] + u2[0], u1[1] + u2[1]]);
    return {
      u1, u2,
      t1: [v[0] + tangent * u1[0], v[1] + tangent * u1[1]],
      t2: [v[0] + tangent * u2[0], v[1] + tangent * u2[1]],
      c: [v[0] + centre * bisector[0], v[1] + centre * bisector[1]],
    };
  });
  return (x, y) => {
    if (!inside(x, y)) return false;
    for (const k of corners) {
      if (dot(sub([x, y], k.t1), k.u1) >= 0) continue;
      if (dot(sub([x, y], k.t2), k.u2) >= 0) continue;
      if (dist(x, y, k.c[0], k.c[1]) <= r) continue;
      return false;
    }
    return true;
  };
}

/** Rounded rectangle hit test. */
function roundRect(x0, y0, x1, y1, r) {
  return (x, y) => dist(x, y, clamp(x, x0 + r, x1 - r), clamp(y, y0 + r, y1 - r)) <= r;
}

// ------------------------------------------------------------------ artwork --
const tile = roundRect(0, 0, SIZE, SIZE, 48);

const CX = SIZE / 2;
const GAP = 3.5;                                      // half width of the spine gap
const COVER = 6;                                      // cover margin around the sheets
const BOARD = 8;                                      // extra cover depth under the sheets
const PAGE_R = 10;                                    // sheet corner radius
const PAGE_EDGE = [234, 210, 172];                    // stacked-sheet edge colour

/** Move every edge of a convex polygon `d` px along its outward normal. */
function expand(pts, d) {
  const n = pts.length;
  const centre = pts.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  const lines = pts.map((a, i) => {
    const dir = unit(sub(pts[(i + 1) % n], a));
    let nrm = [-dir[1], dir[0]];
    if (dot(sub(centre, a), nrm) > 0) nrm = [-nrm[0], -nrm[1]];
    return { p: [a[0] + d * nrm[0], a[1] + d * nrm[1]], dir };
  });
  return pts.map((_, i) => {                          // vertex i = edge i-1 x edge i
    const a = lines[(i - 1 + n) % n];
    const b = lines[i];
    const t = ((b.p[0] - a.p[0]) * b.dir[1] - (b.p[1] - a.p[1]) * b.dir[0]) /
              (a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]);
    return [a.p[0] + t * a.dir[0], a.p[1] + t * a.dir[1]];
  });
}

// Sheet corners in cyclic order: outer-top, inner-top, inner-bottom, outer-bottom.
// The top and bottom edges dip towards the gutter, so each sheet looks like it
// curves down into the spine. The right sheet mirrors the left one.
const LEFT_QUAD = [[42, 73], [CX - GAP, 87], [CX - GAP, 156], [42, 170]];
const RIGHT_QUAD = LEFT_QUAD.map(([x, y]) => [SIZE - x, y]);
// Cover: the same silhouette grown by COVER px, with a deeper bottom board so
// the book shows a visible cover/block under the sheets.
const coverQuad = (q) => expand(q, COVER).map(([x, y], i) => [x, i >= 2 ? y + BOARD : y]);
const LEFT = rounded(LEFT_QUAD, PAGE_R);
const RIGHT = rounded(RIGHT_QUAD, PAGE_R);
const COVER_L = rounded(coverQuad(LEFT_QUAD), 13);
const COVER_R = rounded(coverQuad(RIGHT_QUAD), 13);
const book = (x, y) => COVER_L(x, y) || COVER_R(x, y);

/** Inward distance from the line carrying edge `i` of a polygon (0 on the edge). */
function edgeLine(pts, i) {
  const a = pts[i];
  const b = pts[(i + 1) % pts.length];
  const d = unit(sub(b, a));
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const centre = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
  let n = [-d[1], d[0]];
  if (dot(sub(centre, mid), n) < 0) n = [-n[0], -n[1]];
  return (x, y) => (x - a[0]) * n[0] + (y - a[1]) * n[1];
}
const underEdge = edgeLine(LEFT_QUAD, 2);             // inner-bottom -> outer-bottom

const pageColor = (x, y) => {
  let c = mixRGB(PAGE_TOP, PAGE_BOTTOM, clamp((y - 70) / 104, 0, 1));
  const toGutter = Math.abs(x - CX) - GAP;            // 0 at the spine, grows outward
  if (toGutter < 18) c = mixRGB(c, SPINE, 0.20 * (1 - toGutter / 18) ** 2);
  const band = underEdge(x, y);                       // sheet stack along the bottom edge
  if (band < 6) c = mixRGB(c, PAGE_EDGE, 0.7 * clamp(1 - band / 6, 0, 1));
  return c;
};

const coverColor = (y) => mixRGB(COVER_TOP, COVER_BOTTOM, clamp((y - 64) / 118, 0, 1));

/**
 * Colour of one sample of the artwork. `u`, `v` are normalised 0..1 image
 * coordinates; the result is [r, g, b, a] with straight (non-premultiplied)
 * 0..255 channels.
 */
function sample(u, v) {
  const x = u * SIZE;
  const y = v * SIZE;
  if (!tile(x, y)) return [0, 0, 0, 0];

  if (book(x, y)) {
    if (LEFT(x, y)) return [...pageColor(x, y), 255];
    if (RIGHT(x, y)) return [...pageColor(SIZE - x, y), 255];
    return [...coverColor(y), 255];                   // cover board and spine
  }

  let bg = mixRGB(BG_TOP, BG_BOTTOM, clamp(y / (SIZE - 1), 0, 1));
  for (let k = 1; k <= 16; k++) {                     // soft shadow cast downward
    if (book(x, y - k)) {
      bg = mixRGB(bg, SPINE, 0.2 * (1 - (k - 1) / 16));
      break;
    }
  }
  return [...bg, 255];
}

// ---------------------------------------------------------------- rasterise --
const rgba = Buffer.alloc(SIZE * SIZE * 4);
const N = SS * SS;
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [cr, cg, cb, ca] = sample((px + (sx + 0.5) / SS) / SIZE, (py + (sy + 0.5) / SS) / SIZE);
        const w = ca / 255;
        r += cr * w; g += cg * w; b += cb * w; a += ca;
      }
    }
    const o = (py * SIZE + px) * 4;
    if (a > 0) {
      rgba[o] = Math.round(r / (a / 255));
      rgba[o + 1] = Math.round(g / (a / 255));
      rgba[o + 2] = Math.round(b / (a / 255));
      rgba[o + 3] = Math.round(a / N);
    }
  }
}

// ---------------------------------------------------------------- containers --
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePNG(pixels) {
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0;                        // filter type: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;                                        // bit depth
  ihdr[9] = 6;                                        // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeICO(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);                         // reserved
  header.writeUInt16LE(1, 2);                         // type: icon
  header.writeUInt16LE(1, 4);                         // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0;                                       // width  (0 = 256)
  entry[1] = 0;                                       // height (0 = 256)
  entry[2] = 0;                                       // palette size
  entry[3] = 0;                                       // reserved
  entry.writeUInt16LE(1, 4);                          // colour planes
  entry.writeUInt16LE(32, 6);                         // bits per pixel
  entry.writeUInt32LE(png.length, 8);                 // bytes in resource
  entry.writeUInt32LE(22, 12);                        // offset of image data
  return Buffer.concat([header, entry, png]);
}

const root = join(import.meta.dirname, '..');
const outDir = join(root, 'build');
const png = encodePNG(rgba);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'icon.png'), png);
writeFileSync(join(outDir, 'icon.ico'), encodeICO(png));
console.log(`icon.png ${png.length} bytes, icon.ico ${png.length + 22} bytes`);
