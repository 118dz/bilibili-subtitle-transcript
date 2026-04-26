import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const sizes = [16, 32, 48, 128];

mkdirSync("icons", { recursive: true });

for (const size of sizes) {
  writeFileSync(`icons/icon${size}.png`, createIconPng(size));
}

function createIconPng(size) {
  const width = size;
  const height = size;
  const rows = [];

  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;

    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      const t = (x + y) / (width + height - 2);
      const border = Math.min(x, y, width - 1 - x, height - 1 - y);
      const inGlyph =
        (x > width * 0.23 && x < width * 0.38 && y > height * 0.24 && y < height * 0.75) ||
        (x > width * 0.43 && x < width * 0.62 && y > height * 0.24 && y < height * 0.38) ||
        (x > width * 0.43 && x < width * 0.62 && y > height * 0.46 && y < height * 0.60) ||
        (x > width * 0.43 && x < width * 0.62 && y > height * 0.67 && y < height * 0.81) ||
        (x > width * 0.69 && x < width * 0.78 && y > height * 0.24 && y < height * 0.81);

      if (border < Math.max(1, size * 0.05)) {
        row[offset] = 0;
        row[offset + 1] = 111;
        row[offset + 2] = 145;
        row[offset + 3] = 255;
      } else if (inGlyph) {
        row[offset] = 255;
        row[offset + 1] = 255;
        row[offset + 2] = 255;
        row[offset + 3] = 255;
      } else {
        row[offset] = Math.round(0 + 20 * t);
        row[offset + 1] = Math.round(161 - 25 * t);
        row[offset + 2] = Math.round(214 - 35 * t);
        row[offset + 3] = 255;
      }
    }

    rows.push(row);
  }

  const raw = Buffer.concat(rows);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", createIhdr(width, height)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function createIhdr(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  buffer[10] = 0;
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}
