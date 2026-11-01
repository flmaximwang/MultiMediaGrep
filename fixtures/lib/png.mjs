/**
 * Minimal PNG encoder / decoder (RGB8 and RGBA8, non-interlaced).
 *
 * Uses only `node:zlib`, so no third-party dependency is required and the
 * output is byte-for-byte reproducible for identical input.
 */

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Encode raw RGB pixels into a PNG buffer.
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgb  width*height*3 bytes
 */
export function encodePNG(width, height, rgb) {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodePNG: expected ${width * height * 3} bytes, got ${rgb.length}`);
  }
  const stride = width * 3;
  // Filter type 0 (None) on every scanline keeps the encoder trivial and the
  // output stable across zlib versions that share the same deflate settings.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decode a PNG buffer produced by `encodePNG` (or any RGB/RGBA 8-bit PNG).
 *
 * @param {Buffer} buf
 * @returns {{width:number, height:number, channels:number, data:Buffer}}
 */
export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('decodePNG: not a PNG file');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`decodePNG: unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('decodePNG: interlaced PNGs are not supported');
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 0;
  if (channels === 0) throw new Error(`decodePNG: unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = line[x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paethPredictor(a, b, c);
          break;
        default:
          throw new Error(`decodePNG: unknown filter ${filter}`);
      }
      cur[x] = value & 0xff;
    }
  }

  return { width, height, channels, data: out };
}
