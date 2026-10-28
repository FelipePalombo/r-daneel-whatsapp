import sharp from 'sharp';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnimatedStickerError, encodeAnimatedSource, MAX_ANIMATED_INPUT_BYTES } from './animated-sticker.js';
import { downloadAnimation } from './gif-download.js';

export const MAX_GIF_FRAMES=300;
export const MAX_GIF_PIXELS=50_000_000;
export async function createGifSticker(input: Buffer): Promise<{sticker:Buffer;trimmed:boolean}> {
  if(!input.length || input.length>MAX_ANIMATED_INPUT_BYTES) throw new AnimatedStickerError('Envie uma animação de até 10 MiB.');
  const gif=/^GIF8[79]a$/.test(input.toString('ascii',0,6));
  const webp=input.toString('ascii',0,4)==='RIFF' && input.toString('ascii',8,12)==='WEBP';
  if(!gif && !webp) throw new AnimatedStickerError('Formato incompatível. Use um link direto de GIF ou WebP animado; páginas e AVIF não são suportados.');
  let directory:string|undefined;
  try {
    const options={animated:true,limitInputPixels:MAX_GIF_PIXELS};
    const meta=await sharp(input,options).timeout({seconds:10}).metadata();
    const frames=meta.pages ?? 1, width=meta.width ?? 0, height=meta.pageHeight ?? meta.height ?? 0;
    if(frames<2) throw new AnimatedStickerError('Esse arquivo é estático. Envie o link da animação original.');
    if(frames>MAX_GIF_FRAMES || !width || !height || width*height>8_294_400 || width*height*frames>MAX_GIF_PIXELS)
      throw new AnimatedStickerError('A animação excede 300 quadros ou os limites de resolução e pixels.');
    const delays=Array.from({length:frames},(_,i)=>meta.delay?.[i] ?? 100);
    if(delays.some(ms=>!Number.isFinite(ms) || ms<=0)) throw new AnimatedStickerError('A animação tem tempos de quadros inválidos.');
    const total=delays.reduce((a,b)=>a+b,0);
    const duration=Math.min(total,10000)/1000;
    if(duration<0.2) throw new AnimatedStickerError('A animação precisa ter pelo menos 0,2 segundo.');
    directory=await mkdtemp(join(tmpdir(),'r-daneel-gif-'));
    // Raw em disco evita manter a animação inteira descomprimida no heap do Node.
    const raw=join(directory,'frames.raw');
    await pipeline(sharp(input,options).timeout({seconds:30}).ensureAlpha().raw(),createWriteStream(raw,{mode:0o600}));
    const file=await open(raw,'r');
    const lines:string[]=[];
    const deadline=Date.now()+60_000;
    let elapsed=0;
    try {
      const bytes=width*height*4;
      const buffer=Buffer.alloc(bytes);
      for(let i=0;i<frames && elapsed<10000;i++) {
        if(Date.now()>deadline) throw new AnimatedStickerError('A preparação dos quadros excedeu o tempo permitido.');
        let read=0;
        while(read<bytes) {
          const result=await file.read(buffer,read,bytes-read,i*bytes+read);
          if(!result.bytesRead) throw new Error('Quadro incompleto');
          read+=result.bytesRead;
        }
        const name=`frame-${i}.png`;
        await sharp(buffer,{raw:{width,height,channels:4}}).timeout({seconds:10})
          .resize(512,512,{fit:'fill'}).png().toFile(join(directory,name));
        const ms=Math.min(delays[i]!,10000-elapsed);
        lines.push(`file '${name}'`,`duration ${ms/1000}`);
        elapsed+=ms;
      }
    } finally {await file.close();}
    // O último arquivo repetido permite ao concat respeitar a duração do último quadro.
    lines.push(lines[lines.length-2]!);
    const source=join(directory,'frames.ffconcat');
    await writeFile(source,'ffconcat version 1.0\n'+lines.join('\n')+'\n',{mode:0o600});
    const sticker=await encodeAnimatedSource(source,duration,join(directory,'sticker.webp'),['-f','concat','-safe','1']);
    return {sticker,trimmed:total>10000};
  } catch(error) {
    if(error instanceof AnimatedStickerError) throw error;
    throw new AnimatedStickerError('Não consegui converter essa animação. O arquivo pode estar inválido ou exceder os limites de processamento.', {cause:error});
  } finally {if(directory)await rm(directory,{recursive:true,force:true});}
}

export async function sendGifResponse(url:string, send:{sticker:(data:Buffer)=>Promise<void>;text:(text:string)=>Promise<void>},
  download=downloadAnimation,convert=createGifSticker):Promise<void> {
  await send.text('Vou baixar a animação e preparar a figurinha. Isso pode levar alguns minutos.');
  const result=await convert(await download(url));
  if(result.trimmed)await send.text('Para a figurinha, usei os primeiros 10 segundos da animação.');
  await send.sticker(result.sticker);
}
