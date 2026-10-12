import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

// Lossless conversion of the native scanner's P5 grayscale or P6 RGB output. No brightening,
// cropping, or resampling; the downloaded pixels remain the scanner's pixels.
export function pnmToPng(pgm) {
  const header = /^P([56])\n(\d+) (\d+)\n255\n/.exec(pgm.subarray(0, 64).toString('ascii'));
  if (!header) throw new Error('Ungültiges Scanformat.');
  const channels = header[1] === '6' ? 3 : 1;
  const width = Number(header[2]), height = Number(header[3]), stride = width * channels;
  if (!width || !height || width > 10000 || height > 32768 || width * height > 100000000 ||
      pgm.length !== header[0].length + stride * height) throw new Error('Unvollständiges Scanbild.');
  const pixels = pgm.subarray(header[0].length);
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 0;
  return { width, height, channels, png: Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]) };
}
export const pgmToPng = pnmToPng;
