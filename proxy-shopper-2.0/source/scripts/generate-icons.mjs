// Generates the extension's PNG icons (a price tag on a violet gradient)
// without any image-library dependency: pixels are computed directly and
// encoded as PNG via zlib.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Icon drawing -----------------------------------------------------------
// Unit space: (u, v) in [-0.5, 0.5]. Background: rounded square with a
// violet→indigo gradient. Foreground: white price tag (rotated rounded
// rectangle with a punched hole).

const lerp = (a, b, t) => a + (b - a) * t;
// Vault theme: brushed-steel dark background, gold mark.
const TOP = [37, 45, 58]; // steel
const BOT = [14, 16, 20]; // vault charcoal
const MARK = [230, 180, 80]; // gold

function roundedSquare(u, v) {
  const half = 0.46;
  const r = 0.12;
  const qx = Math.abs(u) - (half - r);
  const qy = Math.abs(v) - (half - r);
  const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return dist <= 0;
}

function priceTag(u, v) {
  // Rotate 45 degrees.
  const cos = Math.SQRT1_2;
  const a = u * cos - v * cos;
  const b = u * cos + v * cos;
  const inRect = Math.abs(a) <= 0.155 && b >= -0.26 && b <= 0.2;
  // Pointed tip at the bottom of the tag.
  const inTip = b > 0.2 && b <= 0.32 && Math.abs(a) <= 0.155 * (1 - (b - 0.2) / 0.12);
  const hole = Math.hypot(a, b + 0.17) <= 0.055;
  return (inRect || inTip) && !hole;
}

function drawIcon(size) {
  const SS = 4; // supersampling factor
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let tagHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size - 0.5;
          const v = (y + (sy + 0.5) / SS) / size - 0.5;
          if (roundedSquare(u, v)) {
            bgHits++;
            if (priceTag(u, v)) tagHits++;
          }
        }
      }
      const total = SS * SS;
      const alpha = bgHits / total;
      const tagMix = bgHits > 0 ? tagHits / bgHits : 0;
      const t = y / size;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(lerp(lerp(TOP[0], BOT[0], t), MARK[0], tagMix));
      rgba[i + 1] = Math.round(lerp(lerp(TOP[1], BOT[1], t), MARK[1], tagMix));
      rgba[i + 2] = Math.round(lerp(lerp(TOP[2], BOT[2], t), MARK[2], tagMix));
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), drawIcon(size));
  console.log(`icon${size}.png`);
}
