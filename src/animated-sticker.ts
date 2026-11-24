import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const MAX_ANIMATED_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_ANIMATED_STICKER_BYTES = 500_000;
export const MAX_ANIMATION_SECONDS = 10;
export class AnimatedStickerError extends Error {}
export type StickerProfile = 'equilibrada' | 'fluida' | 'nitida';

function command(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) reject(new AnimatedStickerError('Não consegui converter essa animação. Tente um vídeo ou GIF menor, com até 10 MB.'));
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

/** Ajusta apenas os tempos ANMF; conserva quadros e limita a aceleração a 1,5×. */
export function accelerateSticker(input: Buffer): { sticker: Buffer; accelerated: boolean } {
  const {frames,durationMs}=validateAnimatedSticker(input);
  const target=Math.max(Math.ceil(durationMs / 1.5),frames*100);
  if(target>=durationMs) return {sticker:input,accelerated:false};
  const sticker=Buffer.from(input); let offset=12, elapsed=0, last=0;
  while(offset<sticker.length) {
    const size=sticker.readUInt32LE(offset+4), start=offset+8;
    if(sticker.toString('ascii',offset,offset+4)==='ANMF') {
      elapsed+=sticker.readUIntLE(start+12,3);
      const next=Math.round(elapsed*target/durationMs);
      const delay=next-last;
      if(delay<8) return {sticker:input,accelerated:false};
      sticker.writeUIntLE(delay,start+12,3);last=next;
    }
    offset=start+size+(size%2);
  }
  validateAnimatedSticker(sticker);
  return {sticker,accelerated:true};
}

/** Vídeos e GIFs recebidos diretamente; nunca acessa URLs presentes na mídia. */
export async function createAnimatedSticker(input: Buffer, profile: StickerProfile = 'equilibrada'): Promise<Buffer> {
  return (await createDirectAnimatedSticker(input, profile)).sticker;
}

export async function createDirectAnimatedSticker(input: Buffer, profile: StickerProfile = 'equilibrada'): Promise<{sticker:Buffer;trimmed:boolean}> {
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
      '-show_entries', 'format=duration:stream=codec_type,width,height,duration,avg_frame_rate,r_frame_rate', '-of', 'json', source], 10_000));
    const video = probe.streams?.find((stream: { codec_type: string }) => stream.codec_type === 'video');
    const duration = Number(probe.format?.duration ?? video?.duration);
    if (!video || !Number.isFinite(duration) || duration < 0.2) throw new AnimatedStickerError('Não consegui identificar uma animação válida. Envie vídeo ou GIF com pelo menos 0,2 segundo.');
    if (!(video.width > 0 && video.height > 0) || video.width * video.height > 8_294_400) throw new AnimatedStickerError('A resolução é muito alta. Envie um vídeo ou GIF com resolução de até 4K.');
    const sticker = await encodeAnimatedSource(source, Math.min(duration, MAX_ANIMATION_SECONDS), output, gif ? ['-ignore_loop', '1'] : [], parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate), profile);
    return {sticker, trimmed:duration > MAX_ANIMATION_SECONDS};
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Prepara somente mídia local já baixada; o limite de downloads permanece separado. */
export async function createLinkedVideoSticker(source: string, profile: StickerProfile = 'equilibrada', optimize = true): Promise<{ sticker: Buffer; trimmed: boolean; accelerated?: boolean }> {
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
      '-an', '-sn', '-dn', '-t', '10', '-vf', "scale='min(512,iw)':-2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '2M', '-bufsize', '2M',
      '-pix_fmt', 'yuv420p', '-threads', '1', '-map_metadata', '-1', clip], 60_000);
    const encoded = await createAnimatedSticker(await readFile(clip), profile);
    const playback = optimize ? accelerateSticker(encoded) : { sticker: encoded, accelerated: false };
    return { ...playback, trimmed: duration > MAX_ANIMATION_SECONDS };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Taxa racional informada pelo ffprobe; valores inválidos não limitam a tentativa. */
export function parseFrameRate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+(?:\/\d+)?$/.test(value)) return;
  const [numerator, denominator = 1] = value.split('/').map(Number);
  const rate = numerator! / denominator;
  return Number.isFinite(rate) && rate > 0 && rate <= 240 ? rate : undefined;
}

/** Conversão compartilhada com tempo limitado e quadros em disco temporário. */
export async function encodeAnimatedSource(source: string, duration: number, output: string, inputOptions: string[] = [], sourceFps?: number, profile: StickerProfile = 'equilibrada'): Promise<Buffer> {
  const candidates: Record<StickerProfile, readonly (readonly [number, number, number, number?])[]> = {
    equilibrada: [[6,320,14,6],[6,256,20],[6,224,12],[5,192,8],[4,160,5],[2,96,0]],
    fluida: [[10,192,7],[8,224,9],[8,192,5],[6,160,5],[4,128,2],[2,96,0]],
    nitida: [[4,320,32],[5,288,22],[4,256,15],[4,192,8],[2,128,2]],
  };
  const deadline=Date.now()+180_000;
  const framesDir=await mkdtemp(join(dirname(output),'frames-'));
  try {
    for (const [requestedFps, size, quality, method = 4] of candidates[profile]) {
      let remaining=deadline-Date.now();
      if (remaining<=0) break;
      const fps=Math.max(2/duration, Math.min(requestedFps, sourceFps && sourceFps>0 ? sourceFps : requestedFps));
      for (const name of await readdir(framesDir)) await rm(join(framesDir,name));
      try {
        await command('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-filter_threads','1',
          '-protocol_whitelist','file,pipe',...inputOptions,'-i',source,'-map','0:v:0','-an','-sn','-dn','-t',String(duration),
          '-vf',`fps=${fps},${inputOptions.length || source.endsWith('.gif') ? '' : 'hqdn3d=2:1:3:2,'}scale=${size}:${size}:flags=area,format=rgba,scale=512:512:flags=bilinear,setsar=1`,
          '-threads','1',join(framesDir,'frame-%03d.png')],Math.min(45_000,remaining));
        const files=(await readdir(framesDir)).filter(x=>/^frame-\d+\.png$/.test(x)).sort();
        if(files.length<2 || files.length>120) continue;
        const total=Math.min(10000,Math.round(duration*1000));
        const args=['-min_size','-loop','0','-lossy','-q',String(quality),'-m',String(method)];
        for(let i=0;i<files.length;i++) {
          const delay=Math.round((i+1)*total/files.length)-Math.round(i*total/files.length);
          args.push('-d',String(delay),join(framesDir,files[i]!));
        }
        remaining=deadline-Date.now();
        if(remaining<=0) break;
        args.push('-o',output);
        await command('img2webp',args,Math.min(method === 6 ? 100_000 : 45_000,remaining));
        const result=await readFile(output);
        if(result.length>MAX_ANIMATED_STICKER_BYTES) continue;
        validateAnimatedSticker(result);
        return result;
      } catch (error) { if (!(error instanceof AnimatedStickerError)) throw error; }
    }
    throw new AnimatedStickerError('Não consegui deixar essa animação abaixo de 500 KB. Tente um trecho mais curto ou com menos movimento.');
  } finally { await rm(framesDir,{recursive:true,force:true}); }
}
