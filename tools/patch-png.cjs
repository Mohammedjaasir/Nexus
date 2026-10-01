const fs = require('fs');
const zlib = require('zlib');

function decodePNG(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.readUInt32BE(0) !== 0x89504E47 || buf.readUInt32BE(4) !== 0x0D0A1A0A) {
    throw new Error('Not a PNG file');
  }

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      console.log(`IHDR: ${width}x${height}, bitDepth: ${bitDepth}, colorType: ${colorType}`);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  const compressed = Buffer.concat(idatChunks);
  const raw = zlib.inflateSync(compressed);
  console.log(`Raw decompressed length: ${raw.length}, expected: ${(width * 4 + 1) * height}`);

  // Unfilter scanlines
  const bytesPerPixel = colorType === 2 ? 3 : 4;
  const stride = width * bytesPerPixel;
  const uncompressed = Buffer.alloc(width * height * bytesPerPixel);

  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];
    const lineOffset = y * stride;

    for (let x = 0; x < stride; x++) {
      const b = raw[rawOffset++];
      let left = x >= bytesPerPixel ? uncompressed[lineOffset + x - bytesPerPixel] : 0;
      let up = y > 0 ? uncompressed[(y - 1) * stride + x] : 0;
      let upLeft = (y > 0 && x >= bytesPerPixel) ? uncompressed[(y - 1) * stride + x - bytesPerPixel] : 0;

      let val = b;
      if (filterType === 1) { // Sub
        val = (b + left) & 0xff;
      } else if (filterType === 2) { // Up
        val = (b + up) & 0xff;
      } else if (filterType === 3) { // Average
        val = (b + Math.floor((left + up) / 2)) & 0xff;
      } else if (filterType === 4) { // Paeth
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        let pr;
        if (pa <= pb && pa <= pc) pr = left;
        else if (pb <= pc) pr = up;
        else pr = upLeft;
        val = (b + pr) & 0xff;
      }
      uncompressed[lineOffset + x] = val;
    }
  }

  return { width, height, bitDepth, colorType, pixels: uncompressed, bytesPerPixel };
}

function encodePNG(width, height, colorType, pixels) {
  const bytesPerPixel = colorType === 2 ? 3 : 4;
  const stride = width * bytesPerPixel;
  const filtered = Buffer.alloc((stride + 1) * height);

  // Filter 0 (None)
  let outPos = 0;
  for (let y = 0; y < height; y++) {
    filtered[outPos++] = 0; // Filter 0
    pixels.copy(filtered, outPos, y * stride, (y + 1) * stride);
    outPos += stride;
  }

  const compressed = zlib.deflateSync(filtered, { level: 9 });

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xedb88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(12 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
  }

  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth
  ihdrData[9] = colorType; // RGB or RGBA
  ihdrData[10] = 0; // Compression
  ihdrData[11] = 0; // Filter
  ihdrData[12] = 0; // Interlace

  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([header, ihdr, idat, iend]);
}

module.exports = { decodePNG, encodePNG };
