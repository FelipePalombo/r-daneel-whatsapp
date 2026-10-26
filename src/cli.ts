import { readFile, stat, writeFile } from 'node:fs/promises';
import { createSticker, MAX_INPUT_BYTES } from './sticker.js';
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Uso: npm run convert -- entrada.jpg saida.webp');
  process.exitCode = 1;
} else {
  try {
    if ((await stat(input)).size > MAX_INPUT_BYTES) throw new Error('Arquivo maior que 10 MB.');
    const sticker = await createSticker(await readFile(input));
    await writeFile(output, sticker, { flag: 'wx' });
    console.log(`Figurinha criada: ${sticker.length} bytes (512 × 512).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Falha na conversão.');
    process.exitCode = 1;
  }
}
