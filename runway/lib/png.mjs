import { open } from 'node:fs/promises';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads width, height and alpha support from a PNG header without decoding the image. */
export async function readPngInfo(path) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(33);
    await fh.read(head, 0, 33, 0);
    if (!head.subarray(0, 8).equals(SIGNATURE) || head.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('not a PNG file');
    }
    const colorType = head[25];
    return {
      width: head.readUInt32BE(16),
      height: head.readUInt32BE(20),
      // 4 = grey+alpha, 6 = RGBA. Palette PNGs (3) can carry transparency too, but print art should be RGBA.
      hasAlpha: colorType === 4 || colorType === 6,
      bytes: size,
    };
  } finally {
    await fh.close();
  }
}
