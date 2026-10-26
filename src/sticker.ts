import sharp from 'sharp';
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_STICKER_BYTES = 100_000;
sharp.cache(false);
sharp.concurrency(1);

/** Conversão local, sem upload e sem preservar metadados EXIF. */
export async function createSticker(input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > MAX_INPUT_BYTES) throw new Error('Envie uma imagem de até 10 MB.');
  const options = { limitInputPixels: 25_000_000, failOn: 'error' as const };
  const metadata = await sharp(input, options).metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) {
    throw new Error('Use uma imagem estática JPEG, PNG ou WebP.');
  }
  const pixels = await sharp(input, options).rotate().resize(512, 512, {
    fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }
  }).png().toBuffer();
  for (const quality of [85, 70, 55, 40, 25, 10]) {
    const output = await sharp(pixels).webp({ quality, effort: 5 }).toBuffer();
    if (output.length <= MAX_STICKER_BYTES) return output;
  }
  throw new Error('Esta imagem não coube no limite da figurinha. Tente uma imagem mais simples.');
}
