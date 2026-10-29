import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withVideo, videoDownloadFailure, videoFailureReply, VideoRateLimitError, DIRECT_VIDEO_TIMEOUT_MS, VIDEO_RATE_LIMIT_PAUSE_MS } from '../src/video.js';
import { sendVideoResponse } from '../src/video-response.js';
const url='https://www.instagram.com/reel/Abc12345/';
async function cobaltEnv(action:()=>Promise<void>, enabled=false) {
  const previous=process.env.COBALT_API_URL;
  if(enabled)process.env.COBALT_API_URL='http://cobalt.test/';else delete process.env.COBALT_API_URL;
  try{await action();}finally{if(previous===undefined)delete process.env.COBALT_API_URL;else process.env.COBALT_API_URL=previous;}
}
test('classifica a resposta real de limite anônimo separadamente de login e outros erros',()=>{
  const actual='The webpage request was redirected to the login page. You have exceeded the rate-limit for accessing posts anonymously. Use --cookies-from-browser or --cookies';
  assert.ok(videoDownloadFailure(actual) instanceof VideoRateLimitError);
  for(const text of ['HTTP Error 429: Too Many Requests','HTTP 429','status code: 429'])assert.ok(videoDownloadFailure(text) instanceof VideoRateLimitError);
  for(const text of ['Login required','content is not available','format not available','network failure'])assert.ok(!(videoDownloadFailure(text) instanceof VideoRateLimitError));
  assert.ok(videoFailureReply(videoDownloadFailure(actual),url).includes('Instagram'));
  assert.ok(videoFailureReply(videoDownloadFailure(actual),'https://x.com/test/status/123').includes('Twitter/X'));
});
test('uma retentativa com aviso e pausa respeita orçamento e remove parciais',async()=>cobaltEnv(async()=>{
  let now=0,calls=0,directory='',sent=0;
  const events:string[]=[];
  await withVideo(url,async()=>{sent++;events.push('send');},async(args,dir,timeout)=>{
    calls++;directory=dir;events.push('attempt');
    assert.ok(args.includes('--ignore-config'));assert.ok(!args.some(value=>value.includes('cookies')));
    if(calls===1){assert.equal(timeout,DIRECT_VIDEO_TIMEOUT_MS);now+=40000;await writeFile(join(dir,'video.mp4.part'),'partial');throw new VideoRateLimitError('limited');}
    assert.equal(timeout,62000);await assert.rejects(access(join(dir,'video.mp4.part')));
    await writeFile(join(dir,'video.mp4'),'fixture');
  },{now:()=>now,onRetry:async()=>{events.push('notice');},wait:async ms=>{assert.equal(ms,VIDEO_RATE_LIMIT_PAUSE_MS);events.push('wait');now+=ms;}});
  assert.equal(calls,2);assert.equal(sent,1);assert.deepEqual(events,['attempt','notice','wait','attempt','send']);await assert.rejects(access(directory));
}));
test('limite persistente tenta Cobalt uma vez e preserva erro específico com limpeza',async()=>cobaltEnv(async()=>{
  let calls=0,pauses=0,fallback=0,directory='';
  await assert.rejects(withVideo(url,async()=>assert.fail('não deve enviar'),async(_,dir)=>{
    calls++;directory=dir;throw new VideoRateLimitError('limited');
  },{wait:async()=>{pauses++;},fallback:async()=>{fallback++;throw new Error('cobalt vazio');}}),VideoRateLimitError);
  assert.equal(calls,2);assert.equal(pauses,1);assert.equal(fallback,1);await assert.rejects(access(directory));
},true));
test('Cobalt pode recuperar após limite sem novo download por falha de envio',async()=>cobaltEnv(async()=>{
  let calls=0,fallback=0,directory='';
  await assert.rejects(withVideo(url,async()=>{throw new Error('envio falhou');},async(_,dir)=>{
    calls++;directory=dir;throw new VideoRateLimitError('limited');
  },{wait:async()=>{},fallback:async(_url,dir)=>{fallback++;await writeFile(join(dir,'video.mp4'),'fixture');}}),/envio falhou/);
  assert.equal(calls,2);assert.equal(fallback,1);await assert.rejects(access(directory));
},true));
test('sem orçamento, sem rate limit ou com falha de envio não cria retentativa',async()=>cobaltEnv(async()=>{
  let now=0,calls=0;
  await assert.rejects(withVideo(url,async()=>{},async()=>{calls++;now=105000;throw new VideoRateLimitError('limited');},
    {now:()=>now,wait:async()=>assert.fail('não aguardar'),onRetry:async()=>assert.fail('não avisar')}),VideoRateLimitError);
  assert.equal(calls,1);
  for(const error of [new Error('login necessário'),new Error('formato'),new Error('arquivo grande')]) {
    calls=0;
    await assert.rejects(withVideo(url,async()=>{},async()=>{calls++;throw error;},{wait:async()=>assert.fail('não aguardar')}));
    assert.equal(calls,1);
  }
  calls=0;
  await assert.rejects(withVideo(url,async()=>{throw new VideoRateLimitError('erro no envio');},async(_,dir)=>{
    calls++;await writeFile(join(dir,'video.mp4'),'fixture');
  },{wait:async()=>assert.fail('não aguardar')}),VideoRateLimitError);
  assert.equal(calls,1);
}));
test('vf e v compartilham o aviso de retentativa e enviam vídeo somente após sucesso',async()=>{
  for(const sticker of [false,true]) {
    const events:string[]=[];
    await sendVideoResponse({url,sticker},{
      video:async()=>{events.push('video');},sticker:async()=>{events.push('sticker');},text:async text=>{assert.ok(text.includes('Instagram'));events.push('retry');},
    },async(_url,send,_run,options)=>{await options?.onRetry?.();await send('/tmp/fixture.mp4');},async()=>({sticker:Buffer.from('webp'),trimmed:false}));
    assert.deepEqual(events,sticker?['retry','video','sticker']:['retry','video']);
  }
});
