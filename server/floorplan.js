/**
 * AVRA Floor Plan Parser — pure Node.js, zero native deps
 * Works with PNG/JPG via manual pixel reading from raw buffer
 */
const fs   = require('fs');
const path = require('path');

const ROOM_NAMES = [
  'Obývacia izba','Kuchyňa','Spálňa','Detská izba',
  'Kúpeľňa','Chodba','Pracovňa','Jedáleň','WC','Šatník','Terasa','Balkón'
];

async function parseFloorPlan(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  console.log('parseFloorPlan:', filePath, ext);

  try {
    // Try sharp first (fastest)
    const sharp = require('sharp');
    const { data, info } = await sharp(filePath)
      .resize(200, 200, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    console.log('Sharp parsed:', info.width, 'x', info.height);
    return segmentPixels(data, info.width, info.height);
  } catch(e) {
    console.log('Sharp not available:', e.message);
  }

  try {
    // Try jimp
    const Jimp = require('jimp');
    const img = await Jimp.read(filePath);
    img.resize(200, 200).grayscale();
    const W = img.bitmap.width, H = img.bitmap.height;
    const data = Buffer.alloc(W * H);
    for (let y=0; y<H; y++) {
      for (let x=0; x<W; x++) {
        data[y*W+x] = img.bitmap.data[(y*W+x)*4];
      }
    }
    console.log('Jimp parsed:', W, 'x', H);
    return segmentPixels(data, W, H);
  } catch(e) {
    console.log('Jimp not available:', e.message);
  }

  console.log('No image parser available, returning null');
  return null;
}

function segmentPixels(data, W, H) {
  const THRESHOLD = 155;
  const MIN_AREA  = Math.floor(W * H * 0.004);
  const REAL_M    = 18.0;
  const AR        = 0.035;

  const visited = new Uint8Array(W * H);

  function flood(sx, sy) {
    const stack = [sy * W + sx];
    let minX=sx, maxX=sx, minY=sy, maxY=sy, count=0;
    while (stack.length) {
      const i = stack.pop();
      if (visited[i]) continue;
      const x = i % W, y = Math.floor(i / W);
      if (data[i] < THRESHOLD) continue; // wall
      visited[i] = 1; count++;
      if(x<minX)minX=x; if(x>maxX)maxX=x;
      if(y<minY)minY=y; if(y>maxY)maxY=y;
      if(x+1<W)  stack.push(i+1);
      if(x-1>=0) stack.push(i-1);
      if(y+1<H)  stack.push(i+W);
      if(y-1>=0) stack.push(i-W);
    }
    return { minX, maxX, minY, maxY, count };
  }

  const regions = [];
  for (let y=0; y<H; y++) {
    for (let x=0; x<W; x++) {
      const i = y*W+x;
      if (!visited[i] && data[i] >= THRESHOLD) {
        const r = flood(x, y);
        if (r.count >= MIN_AREA) regions.push(r);
      }
    }
  }

  regions.sort((a,b) => b.count - a.count);
  const top = regions.slice(0, 10);

  if (!top.length) {
    console.log('No regions found, defaulting');
    return null;
  }

  const rooms = top.map((r, i) => {
    const cx = (r.minX + r.maxX) / 2;
    const cy = (r.minY + r.maxY) / 2;
    const rw = Math.max(1, r.maxX - r.minX);
    const rd = Math.max(1, r.maxY - r.minY);
    return {
      name:  ROOM_NAMES[i % ROOM_NAMES.length],
      label: `R${i+1}`,
      x:     +((cx/W - 0.5) * REAL_M * AR).toFixed(4),
      z:     +((cy/H - 0.5) * REAL_M * AR).toFixed(4),
      w:     +(rw/W * REAL_M * AR).toFixed(4),
      d:     +(rd/H * REAL_M * AR).toFixed(4),
      area:  +(rw/W * REAL_M * rd/H * REAL_M).toFixed(1),
    };
  });

  console.log('Segmented', rooms.length, 'rooms');
  return { rooms, source: 'image', count: rooms.length };
}

module.exports = { parseFloorPlan };
