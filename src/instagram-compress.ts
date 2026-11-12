import {execFile} from 'node:child_process';
import {rm,stat} from 'node:fs/promises';
import {join} from 'node:path';

export const INSTAGRAM_INPUT_LIMIT = 60 * 1024 * 1024;
export const OUTPUT_LIMIT = 16 * 1024 * 1024;
export class InstagramCompressionError extends Error {}

type Probe = {duration: number; video: boolean; audio: boolean};
function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve,reject)=>execFile(file,args,{timeout,killSignal:'SIGKILL',maxBuffer:65536},(error,stdout)=>error?reject(new InstagramCompressionError('Não consegui compactar o vídeo dentro dos limites.')):resolve(stdout)));
}
async function probe(path:string):Promise<Probe> {
  const text=await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type','-of','json',path],10_000);
  try {const info=JSON.parse(text);return {duration:Number(info.format?.duration),video:info.streams?.some((s:{codec_type:string})=>s.codec_type==='video'),audio:info.streams?.some((s:{codec_type:string})=>s.codec_type==='audio')};}
  catch {throw new InstagramCompressionError('Não consegui validar o vídeo recebido.');}
}

/** Entrada/saída sempre locais e temporárias; o diretório é removido pelo chamador. */
export async function compressInstagramVideo(directory:string):Promise<void> {
  const input=join(directory,'instagram-original.mp4'), output=join(directory,'video.mp4');
  try {
    const original=await probe(input);
    if(!original.video || !Number.isFinite(original.duration) || original.duration<=0 || original.duration>180)
      throw new InstagramCompressionError('O vídeo precisa ter até 3 minutos.');
    // Reserva 10% para container e variação de bitrate, além de 96 kbps de áudio.
    const videoKbps=Math.min(2400,Math.floor((OUTPUT_LIMIT*0.9*8/original.duration-96_000)/1000));
    if(videoKbps<100) throw new InstagramCompressionError('O vídeo não cabe no limite disponível.');
    const child=execFile('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1',
      '-protocol_whitelist','file,pipe','-i',input,'-map','0:v:0','-map','0:a:0?',
      '-c:v','libx264','-preset','ultrafast','-b:v',`${videoKbps}k`,'-maxrate',`${Math.ceil(videoKbps*1.1)}k`,
      '-bufsize',`${videoKbps*2}k`,'-c:a','aac','-b:a','96k','-threads','1','-movflags','+faststart',output],
      {timeout:180_000,killSignal:'SIGKILL',maxBuffer:65536});
    let exceeded=false;
    const watcher=setInterval(()=>{void stat(output).then(s=>{if(s.size>OUTPUT_LIMIT){exceeded=true;child.kill('SIGKILL');}}).catch(()=>{});},250);
    try {await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0&&!exceeded?resolve():reject(new Error('ffmpeg')));});}
    catch {throw new InstagramCompressionError('Não consegui compactar o vídeo dentro dos limites.');}
    finally {clearInterval(watcher);}
    const file=await stat(output);
    if(file.size<=0 || file.size>OUTPUT_LIMIT) throw new InstagramCompressionError('O vídeo compactado ultrapassou 16 MiB.');
    const result=await probe(output);
    if(!result.video || (original.audio&&!result.audio) || !Number.isFinite(result.duration) || result.duration>180 || result.duration<original.duration-0.5)
      throw new InstagramCompressionError('Não consegui validar o vídeo compactado completo.');
  } catch(error) {await rm(output,{force:true});throw error;}
  finally {await rm(input,{force:true});}
}
