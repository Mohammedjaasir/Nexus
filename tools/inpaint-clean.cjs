const fs = require('fs');
const { decodePNG, encodePNG } = require('./patch-png.cjs');

// Fresh decode from hq-campus-hd.png
const img = decodePNG('src/renderer/src/assets/hq-campus-hd.png');
console.log(`Decoded hq-campus-hd.png: ${img.width}x${img.height}, bpp: ${img.bytesPerPixel}`);

const bpp = img.bytesPerPixel;
const w = img.width;
const pix = img.pixels;

// 1. Clean corridor speech bubble "where to next?" (x: 980..1150, y: 630..686)
// Sample from clean corridor above Game Dev Studio (x: 1180..1350, y: 630..686)
for (let y = 630; y <= 686; y++) {
  for (let x = 980; x <= 1150; x++) {
    const srcX = x + 200;
    const srcIdx = (y * w + srcX) * bpp;
    const dstIdx = (y * w + x) * bpp;
    for (let c = 0; c < bpp; c++) {
      pix[dstIdx + c] = pix[srcIdx + c];
    }
  }
}

// 2. Doorway opening & wall (x: 1010..1120, y: 687..785)
// Sample from clean Research Lab doorway: x=1880..1990 (pure white wall & door, past all signs)
for (let y = 687; y <= 785; y++) {
  for (let x = 1010; x <= 1120; x++) {
    const srcX = 1880 + (x - 1010);
    const srcIdx = (y * w + srcX) * bpp;
    const dstIdx = (y * w + x) * bpp;
    for (let c = 0; c < bpp; c++) {
      pix[dstIdx + c] = pix[srcIdx + c];
    }
  }
}





// 4. Clean reception desk speech bubble "good morning!" (x: 200..350, y: 990..1060)
for (let y = 990; y <= 1060; y++) {
  for (let x = 200; x <= 350; x++) {
    const srcX = x + 160;
    const srcIdx = (y * w + srcX) * bpp;
    const dstIdx = (y * w + x) * bpp;
    for (let c = 0; c < bpp; c++) {
      pix[dstIdx + c] = pix[srcIdx + c];
    }
  }
}

const out = encodePNG(img.width, img.height, img.colorType, pix);
fs.writeFileSync('src/renderer/src/assets/hq-campus-clean.png', out);
console.log('Saved seamless clean hq-campus-clean.png, length:', out.length);
