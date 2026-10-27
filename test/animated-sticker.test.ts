import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createAnimatedSticker, validateAnimatedSticker, MAX_ANIMATED_STICKER_BYTES, MAX_ANIMATED_INPUT_BYTES } from '../src/animated-sticker.js';
import { requestStatus } from '../src/request.js';
const exec = promisify(execFile);

async function fixture(seconds: number, gif: boolean, action: (input: Buffer) => Promise<void>, size = '120x180') {
  const dir = await mkdtemp(join(tmpdir(), 'daneel-animation-test-'));
  try {
    const path = join(dir, gif ? 'input.gif' : 'input.mp4');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=12:duration=${seconds}`,
      '-threads', '1', ...(gif ? [] : ['-c:v','libx264','-pix_fmt','yuv420p']), path], {timeout:15_000});
    await action(await readFile(path));
  } finally { await rm(dir,{recursive:true,force:true}); }
}

test('converte MP4 e GIF em WebP animado válido e realmente com movimento', async () => {
  for (const gif of [false,true]) await fixture(1,gif,async input => {
    const output = await createAnimatedSticker(input);
    const meta = validateAnimatedSticker(output);
    assert.ok(meta.frames >= 2); assert.ok(meta.durationMs <= 10000);
    assert.ok(output.length<=MAX_ANIMATED_STICKER_BYTES);
    const decoded = await sharp(output,{animated:true}).raw().toBuffer({resolveWithObject:true});
    const pageSize=512*512*decoded.info.channels;
    assert.notDeepEqual(decoded.data.subarray(0,pageSize),decoded.data.subarray(pageSize,pageSize*2));
  });
});

test('aceita limite de 10 segundos e recusa acima sem cortar silenciosamente', async () => {
  await fixture(10,false,async input=> { assert.ok(validateAnimatedSticker(await createAnimatedSticker(input)).durationMs<=10000); });
  await fixture(10.2,false,async input=> { await assert.rejects(createAnimatedSticker(input),/passa de 10 segundos/); });
});

test('recusa mídia inválida e grande e WebP final adulterado', async () => {
  await assert.rejects(createAnimatedSticker(Buffer.from('invalido')));
  await assert.rejects(createAnimatedSticker(Buffer.alloc(MAX_ANIMATED_INPUT_BYTES+1)));
  await fixture(0.5,false,async input=> {
    const sticker=await createAnimatedSticker(input);
    assert.throws(()=>validateAnimatedSticker(sticker.subarray(0,sticker.length-1)));
    const modified=Buffer.from(sticker);
    const frame=modified.indexOf('ANMF');
    modified.writeUIntLE(10001,frame+8+12,3);
    assert.throws(()=>validateAnimatedSticker(modified));
  });
});

test('vídeo e GIF exigem legenda e autorização e não permitem visualização única', () => {
  const phone='5511999999999';
  const key={id:'animation',remoteJid:`${phone}@s.whatsapp.net`};
  for(const content of [{videoMessage:{caption:'!figurinha',gifPlayback:true}},
    {documentMessage:{caption:'!figurinha',mimetype:'image/gif'}},
    {imageMessage:{caption:'!figurinha',mimetype:'image/gif'}},
    {documentWithCaptionMessage:{message:{documentMessage:{caption:'!figurinha',mimetype:'image/gif'}}}}]) {
    assert.equal(requestStatus({key,message:content},phone),'animação aceita');
    assert.equal(requestStatus({key,message:content},'5511888888888'),'remetente não autorizado');
    assert.notEqual(requestStatus({key,message:{viewOnceMessage:{message:content}}},phone),'animação aceita');
  }
  assert.equal(requestStatus({key,message:{videoMessage:{caption:'oi'}}},phone),'mídia sem legenda !figurinha');
});


test('animações horizontais e verticais preenchem o quadrado sem bordas adicionadas', async () => {
  for (const size of ['240x80', '80x240']) await fixture(0.5,false,async input=> {
    const output=await createAnimatedSticker(input);
    const {data,info}=await sharp(output,{animated:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.width,512); assert.equal(info.pageHeight,512);
    assert.equal(info.channels,4);
    for (let i=3;i<data.length;i+=4) assert.equal(data[i],255, 'preenche todos os quadros sem bordas transparentes');
    validateAnimatedSticker(output);
  }, size);
});


test('comprime animação longa com ruído reduzindo detalhes antes de desistir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daneel-noisy-animation-'));
  try {
    const path = join(dir, 'noise.mp4');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=512x512:rate=12:duration=9,noise=alls=90:allf=t:all_seed=42',
      '-threads', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', path], {timeout:30_000});
    const output = await createAnimatedSticker(await readFile(path));
    const meta = validateAnimatedSticker(output);
    assert.ok(output.length <= MAX_ANIMATED_STICKER_BYTES);
    assert.ok(meta.durationMs >= 8500, 'preserva o trecho inteiro');
    assert.ok(meta.frames < 72, 'aciona compressão além das três tentativas originais');
    const info = await sharp(output).metadata();
    assert.equal(info.width, 512); assert.equal(info.height, 512);
  } finally { await rm(dir, {recursive:true, force:true}); }
});
