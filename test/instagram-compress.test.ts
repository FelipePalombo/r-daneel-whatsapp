import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,stat,access,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compressInstagramVideo,InstagramCompressionError,OUTPUT_LIMIT} from '../src/instagram-compress.js';
const exec=promisify(execFile);

test('compacta mídia local com áudio, preserva duração e remove o original',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'daneel-compress-test-'));
  try {
    await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=128x128:rate=12:duration=2','-f','lavfi','-i','sine=frequency=400:duration=2','-threads','1','-c:v','libx264','-c:a','aac',join(dir,'instagram-original.mp4')]);
    await compressInstagramVideo(dir);
    const path=join(dir,'video.mp4');assert.ok((await stat(path)).size<=OUTPUT_LIMIT);await assert.rejects(access(join(dir,'instagram-original.mp4')));
    const {stdout}=await exec('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',path]);
    const info=JSON.parse(stdout);assert.ok(Number(info.format.duration)>=1.5);assert.ok(info.streams.some((x:{codec_type:string})=>x.codec_type==='audio'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('falha de entrada inválida remove arquivos temporários e não deixa vídeo parcial',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'daneel-compress-invalid-'));
  try {await writeFile(join(dir,'instagram-original.mp4'),'inválido');await assert.rejects(compressInstagramVideo(dir),InstagramCompressionError);await assert.rejects(access(join(dir,'instagram-original.mp4')));await assert.rejects(access(join(dir,'video.mp4')));}
  finally {await rm(dir,{recursive:true,force:true});}
});

test('recusa vídeo acima de 3 minutos antes de compactar e limpa entrada',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'daneel-compress-long-'));
  try {
    await exec('ffmpeg',['-v','error','-f','lavfi','-i','color=size=16x16:rate=1:duration=181','-threads','1','-c:v','libx264',join(dir,'instagram-original.mp4')]);
    await assert.rejects(compressInstagramVideo(dir),/até 3 minutos/);
    await assert.rejects(access(join(dir,'instagram-original.mp4')));await assert.rejects(access(join(dir,'video.mp4')));
  } finally {await rm(dir,{recursive:true,force:true});}
});
