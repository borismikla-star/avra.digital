/**
 * AVRA — Floor plan parser (pure Node.js, no Python needed)
 * Analyzes uploaded image/PDF as pixel data, segments rooms via flood-fill
 */
const fs   = require('fs');
const path = require('path');

const ROOM_NAMES = [
  'Obývacia izba','Kuchyňa','Spálňa','Detská izba',
  'Kúpeľňa','Chodba','Pracovňa','Jedáleň','WC','Šatník','Terasa','Balkón'
];

// Parse floor plan image using sharp (already in deps) or jimp as fallback
async function parseFloorPlan(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  // For PDF: try to extract embedded image
  if (ext === '.pdf') {
    return parsePDF(filePath);
  }

  // For image files: analyze directly
  return parseImage(filePath);
}

async function parsePDF(filePath) {
  // Try pdf2pic or similar — if not available, return structured demo
  try {
    const { execFile } = require('child_process');
    // Try pdftoppm if available on Railway
    const outPath = filePath + '_page';
    await new Promise((resolve, reject) => {
      execFile('pdftoppm', ['-png', '-r', '72', '-f', '1', '-l', '1', filePath, outPath],
        { timeout: 15000 }, (err) => err ? reject(err) : resolve());
    });
    // Find generated file
    const dir = path.dirname(outPath);
    const base = path.basename(outPath);
    const files = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(outPath)));
    if (files.length) {
      return parseImage(path.join(dir, files[0]));
    }
  } catch(e) {
    console.log('pdftoppm not available, using jimp fallback');
  }
  // Fallback: return null so server uses demo rooms
  return null;
}

async function parseImage(filePath) {
  try {
    // Try sharp
    const sharp = require('sharp');
    const { data, info } = await sharp(filePath)
      .resize(256, 256, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return segmentPixels(data, info.width, info.height);
  } catch(e) {
    try {
      // Try jimp
      const Jimp = require('jimp');
      const img = await Jimp.read(filePath);
      img.resize(256, 256).grayscale();
      const w = img.bitmap.width, h = img.bitmap.height;
      const data = Buffer.alloc(w * h);
      for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
        const idx = (y*w+x)*4;
        data[y*w+x] = img.bitmap.data[idx]; // R channel (grayscale)
      }
      return segmentPixels(data, w, h);
    } catch(e2) {
      console.log('Image parsing failed:', e2.message);
      return null;
    }
  }
}

function segmentPixels(data, W, H) {
  const WALL_THRESHOLD = 160; // darker = wall
  const MIN_AREA = W * H * 0.003;
  const REAL_M = 20.0;
  const AR_SCALE = 0.035;

  const visited = new Uint8Array(W * H);
  const isWall = (x, y) => data[y * W + x] < WALL_THRESHOLD;

  function floodFill(sx, sy) {
    const stack = [[sx, sy]];
    let minX=sx, maxX=sx, minY=sy, maxY=sy, count=0;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx<0||cy<0||cx>=W||cy>=H) continue;
      const i = cy*W+cx;
      if (visited[i] || isWall(cx,cy)) continue;
      visited[i]=1; count++;
      if(cx<minX)minX=cx; if(cx>maxX)maxX=cx;
      if(cy<minY)minY=cy; if(cy>maxY)maxY=cy;
      stack.push([cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]);
    }
    return {minX,maxX,minY,maxY,count};
  }

  const regions = [];
  for (let y=0; y<H; y++) {
    for (let x=0; x<W; x++) {
      if (!visited[y*W+x] && !isWall(x,y)) {
        const r = floodFill(x, y);
        if (r.count >= MIN_AREA) regions.push(r);
      }
    }
  }

  // Sort by size descending, take top 10
  regions.sort((a,b) => b.count - a.count);
  const top = regions.slice(0, 10);

  const rooms = top.map((r, i) => {
    const cx = (r.minX+r.maxX)/2, cy = (r.minY+r.maxY)/2;
    const rw = Math.max(2, r.maxX-r.minX), rd = Math.max(2, r.maxY-r.minY);
    return {
      name:  ROOM_NAMES[i % ROOM_NAMES.length],
      label: `R${i+1}`,
      x:     parseFloat(((cx/W - 0.5)*REAL_M*AR_SCALE).toFixed(4)),
      z:     parseFloat(((cy/H - 0.5)*REAL_M*AR_SCALE).toFixed(4)),
      w:     parseFloat((rw/W*REAL_M*AR_SCALE).toFixed(4)),
      d:     parseFloat((rd/H*REAL_M*AR_SCALE).toFixed(4)),
      area:  parseFloat((rw/W*REAL_M * rd/H*REAL_M).toFixed(1)),
    };
  });

  return { rooms, source: 'image', count: rooms.length };
}

module.exports = { parseFloorPlan };
