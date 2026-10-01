const fs = require('fs');
const { decodePNG, encodePNG } = require('./patch-png.cjs');


const img = decodePNG('src/renderer/src/assets/hq-campus-hd.png');
const bpp = img.bytesPerPixel;
const w = img.width;
const pix = img.pixels;

// Find bounding box of bubble (white/cream bg) and character in this region
let minX = 9999, maxX = 0, minY = 9999, maxY = 0;
for (let y = 620; y < 800; y++) {
  for (let x = 950; x < 1200; x++) {
    const idx = (y * w + x) * bpp;
    const r = pix[idx], g = pix[idx+1], b = pix[idx+2];
    // Speech bubble is white/cream: r>230, g>230, b>200
    if (r > 220 && g > 220 && b > 200) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
console.log(`Bubble bounding box in hq-campus-hd.png: x: ${minX}..${maxX}, y: ${minY}..${maxY}`);

// Find bounding box of character (dark suit r < 70, g < 80, b < 90)
let cMinX = 9999, cMaxX = 0, cMinY = 9999, cMaxY = 0;
for (let y = 680; y < 800; y++) {
  for (let x = 1000; x < 1150; x++) {
    const idx = (y * w + x) * bpp;
    const r = pix[idx], g = pix[idx+1], b = pix[idx+2];
    // Dark suit / pants
    if (r < 75 && g < 85 && b < 100) {
      if (x < cMinX) cMinX = x;
      if (x > cMaxX) cMaxX = x;
      if (y < cMinY) cMinY = y;
      if (y > cMaxY) cMaxY = y;
    }
  }
}
console.log(`Character bounding box in hq-campus-hd.png: x: ${cMinX}..${cMaxX}, y: ${cMinY}..${cMaxY}`);
