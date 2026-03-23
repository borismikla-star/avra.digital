/**
 * AVRA — Pure Node.js floor plan parser
 * No Python, no OpenCV — works everywhere
 * Uses Jimp (if available) or raw PNG parsing
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOM_NAMES = [
  'Obývacia izba','Kuchyňa','Spálňa','Detská izba',
  'Kúpeľňa','Chodba','Pracovňa','Jedáleň','WC','Šatník','Terasa','Balkón'
];

// ── Main entry point ──────────────────────────────────────────────────────────
async function parseFloorPlan(imagePath, pythonBin) {
  // Try Python parser first if available
  if (pythonBin) {
    const result = await tryPythonParser(imagePath, pythonBin);
    if (result && result.rooms && result.rooms.length >= 2) return result;
  }

  // Pure JS fallback
  return parseWithJS(imagePath);
}

async function tryPythonParser(imagePath, python) {
  return new Promise(resolve => {
    const script = path.join(__dirname, '../parser/parse.py');
    execFile(python, [script, imagePath], { timeout: 25000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const r = JSON.parse(stdout.trim());
        resolve(r.error ? null : r);
      } catch { resolve(null); }
    });
  });
}

async function parseWithJS(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();

  // Try to load image as raw pixels
  let pixels = null;
  let W = 0, H = 0;

  // Method 1: Try Jimp
  try {
    const Jimp = require('jimp');
    const img = await Jimp.read(imagePath);
    img.resize(256, 256).grayscale();
    W = img.bitmap.width;
    H = img.bitmap.height;
    pixels = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      pixels[i] = img.bitmap.data[i * 4]; // R channel (grayscale)
    }
    console.log('Parser: Jimp loaded image', W, 'x', H);
  } catch (e) {
    console.log('Parser: Jimp not available:', e.message);
  }

  // Method 2: Manual PNG parsing (no deps)
  if (!pixels && ext === '.png') {
    try {
      const result = parsePNGRaw(imagePath);
      if (result) { pixels = result.pixels; W = result.w; H = result.h; }
    } catch (e) {
      console.log('Parser: PNG raw parse failed:', e.message);
    }
  }

  if (!pixels) {
    return { rooms: [], walls: [], source: 'js-failed',
      message: 'Nedá sa načítať obrázok. Nakreslite miestnosti manuálne.' };
  }

  return segmentPixels(pixels, W, H);
}

// ── Raw PNG parser (no dependencies) ─────────────────────────────────────────
function parsePNGRaw(filePath) {
  const buf = fs.readFileSync(filePath);

  // Check PNG signature
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;

  // Parse IHDR chunk
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8) return null;

  // For simplicity: resize to 256x256 by sampling
  const SIZE = 256;
  const pixels = new Uint8Array(SIZE * SIZE);

  // Extract raw image data using zlib
  const zlib = require('zlib');
  const chunks = [];
  let offset = 8;
  while (offset < buf.length - 12) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(buf.slice(offset + 8, offset + 8 + len));
    if (type === 'IEND') break;
    offset += 12 + len;
  }

  const compressed = Buffer.concat(chunks);
  let raw;
  try { raw = zlib.inflateSync(compressed); } catch { return null; }

  // Channels per pixel
  const ch = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 3;
  const rowSize = 1 + w * ch; // filter byte + pixels

  // Sample to 256x256
  for (let sy = 0; sy < SIZE; sy++) {
    for (let sx = 0; sx < SIZE; sx++) {
      const srcX = Math.floor(sx * w / SIZE);
      const srcY = Math.floor(sy * h / SIZE);
      const rowOffset = srcY * rowSize + 1; // skip filter byte
      const pixOffset = rowOffset + srcX * ch;
      // Average RGB to grayscale
      const r2 = raw[pixOffset] || 0;
      const g2 = ch > 1 ? (raw[pixOffset + 1] || 0) : r2;
      const b2 = ch > 2 ? (raw[pixOffset + 2] || 0) : r2;
      pixels[sy * SIZE + sx] = Math.round((r2 + g2 + b2) / 3);
    }
  }

  return { pixels, w: SIZE, h: SIZE };
}

// ── Flood-fill segmentation ───────────────────────────────────────────────────
function segmentPixels(pixels, W, H) {
  // Otsu threshold
  const hist = new Array(256).fill(0);
  for (let i = 0; i < pixels.length; i++) hist[pixels[i]]++;
  let thresh = 128, bestVar = 0;
  for (let t = 1; t < 255; t++) {
    let w0 = 0, w1 = 0, s0 = 0, s1 = 0;
    for (let i = 0; i < t; i++) { w0 += hist[i]; s0 += i * hist[i]; }
    for (let i = t; i < 256; i++) { w1 += hist[i]; s1 += i * hist[i]; }
    if (!w0 || !w1) continue;
    const m0 = s0 / w0, m1 = s1 / w1;
    const v = (w0 * w1 * (m0 - m1) ** 2) / (pixels.length ** 2);
    if (v > bestVar) { bestVar = v; thresh = t; }
  }

  const isWall = i => pixels[i] < thresh;
  const visited = new Uint8Array(W * H);
  const regions = [];
  const MIN = W * H * 0.003;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (visited[i] || isWall(i)) continue;
      // BFS
      const q = [i];
      let head = 0;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      while (head < q.length) {
        const ci = q[head++];
        if (visited[ci]) continue;
        visited[ci] = 1; count++;
        const cx = ci % W, cy = Math.floor(ci / W);
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cx + 1 < W  && !visited[ci+1] && !isWall(ci+1)) q.push(ci+1);
        if (cx - 1 >= 0 && !visited[ci-1] && !isWall(ci-1)) q.push(ci-1);
        if (cy + 1 < H  && !visited[ci+W] && !isWall(ci+W)) q.push(ci+W);
        if (cy - 1 >= 0 && !visited[ci-W] && !isWall(ci-W)) q.push(ci-W);
      }
      if (count >= MIN) regions.push({ minX, maxX, minY, maxY, count });
    }
  }

  regions.sort((a, b) => b.count - a.count);
  const REAL_M = 20.0, AR = 0.035;

  const rooms = regions.slice(0, 12).map((r, i) => {
    const cx = (r.minX + r.maxX) / 2;
    const cy = (r.minY + r.maxY) / 2;
    const rw = Math.max(1, r.maxX - r.minX);
    const rd = Math.max(1, r.maxY - r.minY);
    return {
      name:  ROOM_NAMES[i % ROOM_NAMES.length],
      label: `R${i + 1}`,
      x:     +((cx / W - 0.5) * REAL_M * AR).toFixed(4),
      z:     +((cy / H - 0.5) * REAL_M * AR).toFixed(4),
      w:     +(rw / W * REAL_M * AR).toFixed(4),
      d:     +(rd / H * REAL_M * AR).toFixed(4),
      area:  +(rw / W * REAL_M * rd / H * REAL_M).toFixed(1),
    };
  });

  console.log(`Parser JS: ${rooms.length} rooms (thresh=${thresh})`);
  return { rooms, walls: [], source: 'js', roomCount: rooms.length, wallCount: 0 };
}

module.exports = { parseFloorPlan };
