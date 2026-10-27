import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_ANIMATED_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_ANIMATED_STICKER_BYTES = 500_000;
export const MAX_ANIMATION_SECONDS = 10;
export class AnimatedStickerError extends Error {}

function command(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) reject(new AnimatedStickerError('Não consegui converter essa animação. Tente um vídeo ou GIF menor, com até 10 segundos e 10 MB.'));
      else resolve(stdout);
    });
  });
}

/** Verifica o arquivo final sem decodificar todos os quadros na memória. */
export function validateAnimatedSticker(data: Buffer): { frames: number; durationMs: number } {
  const invalid = () => { throw new AnimatedStickerError('A animação não ficou em um formato válido para figurinha. Tente outro vídeo ou GIF.'); };
  if (data.length > MAX_ANIMATED_STICKER_BYTES || data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' ||
      data.toString('ascii', 8, 12) !== 'WEBP' || data.readUInt32LE(4) !== data.length - 8) return invalid();
  let offset = 12, frames = 0, durationMs = 0, canvas = false, loop = false;
  while (offset < data.length) {
    if (offset + 8 > data.length) return invalid();
    const type = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > data.length) return invalid();
    if (type === 'VP8X') {
      if (size !== 10) return invalid();
      canvas = Boolean(data[start]! & 2) && data.readUIntLE(start + 4, 3) + 1 === 512 && data.readUIntLE(start + 7, 3) + 1 === 512;
    }
    if (type === 'ANIM') {
      if (size !== 6) return invalid();
      loop = data.readUInt16LE(start + 4) === 0;
    }
    if (type === 'ANMF') {
      if (size < 16) return invalid();
      const ms = data.readUIntLE(start + 12, 3);
      const x = data.readUIntLE(start, 3) * 2, y = data.readUIntLE(start + 3, 3) * 2;
      const w = data.readUIntLE(start + 6, 3) + 1, h = data.readUIntLE(start + 9, 3) + 1;
      if (ms < 8 || x + w > 512 || y + h > 512) return invalid();
      durationMs += ms; frames++;
    }
    offset = start + size + (size % 2);
  }
  if (offset !== data.length || !canvas || !loop || frames < 2 || durationMs <= 0 || durationMs > 10_000) return invalid();
  return { frames, durationMs };
}

/** Vídeos e GIFs recebidos diretamente; nunca acessa URLs presentes na mídia. */
export async function createAnimatedSticker(input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > MAX_ANIMATED_INPUT_BYTES) throw new AnimatedStickerError('Envie um vídeo ou GIF de até 10 MB com a legenda !figurinha.');
  const gif = /^GIF8[79]a$/.test(input.toString('ascii', 0, 6));
  const mp4 = input.toString('ascii', 4, 8) === 'ftyp';
  const webm = input.length >= 4 && input.readUInt32BE(0) === 0x1a45dfa3;
  if (!gif && !mp4 && !webm) throw new AnimatedStickerError('Use vídeo MP4/WebM ou GIF com a legenda !figurinha.');
  const directory = await mkdtemp(join(tmpdir(), 'r-daneel-animation-'));
  try {
    const source = join(directory, gif ? 'input.gif' : mp4 ? 'input.mp4' : 'input.webm');
    const output = join(directory, 'sticker.webp');
    await writeFile(source, input, { mode: 0o600 });
    const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-show_entries', 'format=duration:stream=codec_type,width,height,duration', '-of', 'json', source], 10_000));
    const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === 'video');
    const duration = Number(probe.format?.duration ?? video?.duration);
    if (!video || !Number.isFinite(duration) || duration < 0.2) throw new AnimatedStickerError('Não consegui identificar uma animação válida. Envie vídeo ou GIF entre 0,2 e 10 segundos.');
    if (duration > MAX_ANIMATION_SECONDS) throw new AnimatedStickerError('Esse vídeo ou GIF passa de 10 segundos. Recorte um trecho de até 10 segundos e envie com a legenda !figurinha.');
    if (!(video.width > 0 && video.height > 0) || video.width * video.height > 8_294_400) throw new AnimatedStickerError('A resolução é muito alta. Envie um vídeo ou GIF com resolução de até 4K.');
    return await encodeAnimatedSource(source, duration, output, gif ? ['-ignore_loop', '1'] : []);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Prepara somente mídia local já baixada; o limite de downloads permanece separado. */
export async function createLinkedVideoSticker(source: string): Promise<{ sticker: Buffer; trimmed: boolean }> {
  const probe = JSON.parse(await command('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', source], 10_000));
  const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  const duration = Number(probe.format?.duration);
  if (!video || !Number.isFinite(duration) || duration < 0.2 || !(video.width > 0 && video.height > 0) ||
      video.width * video.height > 8_294_400) throw new AnimatedStickerError('Não consegui preparar um trecho válido desse vídeo para figurinha.');
  const directory = await mkdtemp(join(tmpdir(), 'r-daneel-clip-'));
  try {
    const clip = join(directory, 'clip.mp4');
    await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
      '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:v:0',
      '-an', '-sn', '-dn', '-t', '10', '-vf', "fps=24,scale='min(512,iw)':-2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '2M', '-bufsize', '2M',
      '-pix_fmt', 'yuv420p', '-threads', '1', '-map_metadata', '-1', clip], 60_000);
    return { sticker: await createAnimatedSticker(await readFile(clip)), trimmed: duration > MAX_ANIMATION_SECONDS };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Entrada local normalizada; compartilhada pelos conversores de animação. */
export async function encodeAnimatedSource(source: string, duration: number, output: string, inputOptions: string[] = []): Promise<Buffer> {
  // Primeiro preserva detalhes; só reduz a resolução interna quando necessário.
  // O canvas final continua 512×512, mesmo nos últimos níveis de emergência.
  const attempts = [
    [12, 65, 512], [10, 40, 512], [8, 20, 512],
    [6, 10, 320], [4, 5, 224], [3, 1, 128], [2, 0, 64],
  ] as const;
  for (const [targetFps, quality, size] of attempts) {
    const fps = Math.max(targetFps, Math.ceil(2 / duration));
    try {
      await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
      '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', ...inputOptions,
      '-i', source, '-map', '0:v:0', '-an', '-sn', '-dn', '-t', String(duration), '-frames:v', String(Math.ceil(fps * duration)),
      '-vf', `fps=${fps},scale=${size}:${size}:flags=area,format=rgba,scale=512:512:flags=neighbor,setsar=1`,
      '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', String(quality), '-compression_level', '3',
      '-threads', '1', '-loop', '0', '-fs', '1000000', '-f', 'webp', output], 30_000);
    } catch (error) {
      if (!(error instanceof AnimatedStickerError)) throw error;
      // Uma tentativa pesada pode exceder o tempo na VM; tentar a próxima, menor.
      continue;
    }
    const result = await readFile(output);
    if (result.length > MAX_ANIMATED_STICKER_BYTES) continue;
    validateAnimatedSticker(result);
    return result;
  }
  throw new AnimatedStickerError('Não consegui deixar essa animação abaixo de 500 KB. Tente um trecho mais curto ou com menos movimento.');
}
