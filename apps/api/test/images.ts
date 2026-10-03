import { crc32, deflateSync } from "node:zlib";

/** A minimal well-formed PNG (1x1, grey); `extra` is appended after IEND. */
export function tinyPng(extra = Buffer.alloc(0)): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 0x80]))), chunk("IEND", Buffer.alloc(0)), extra]);
}

/** A minimal JPEG marker layout (SOI, APP0, SOF0, SOS, scan bytes) followed by `tail` (EOI by default). */
export function tinyJpeg(tail = Buffer.from([0xff, 0xd9])): Buffer {
  const seg = (m: number, data: Buffer) => {
    const h = Buffer.from([0xff, m, 0, 0]);
    h.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])), seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34]), tail]);
}
