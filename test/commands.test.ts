import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseVideoCommand, requestStatus } from '../src/request.js';
import { sendVideoResponse } from '../src/video-response.js';
import { withVideo } from '../src/video.js';
import { createLinkedVideoSticker, validateAnimatedSticker } from '../src/animated-sticker.js';

const url = 'https://x.com/i/web/status/123';
test('aliases, espaços, maiúsculas, validação e autorização', () => {
  for (const command of ['!video', '!v', '!vfigurinha', '!vf']) {
    assert.deepEqual(parseVideoCommand(`  ${command.toUpperCase()}  ${url}  `), { url, sticker: ['!vf', '!vfigurinha'].includes(command) });
    assert.equal(parseVideoCommand(`${command} errado`), undefined);
    assert.equal(parseVideoCommand(`${command} ${url} texto extra`), undefined);
  }
  assert.deepEqual(parseVideoCommand(url), {url, sticker:false});
  assert.equal(parseVideoCommand(`!vfoo ${url}`), undefined);
  const phone='5511999999999';
  const key={id:'commands',remoteJid:`${phone}@s.whatsapp.net`};
  for(const caption of ['!f',' !F ','!figurinha']) {
    assert.equal(requestStatus({key,message:{imageMessage:{caption}}},phone),'aceita');
    assert.equal(requestStatus({key,message:{videoMessage:{caption}}},phone),'animação aceita');
    assert.equal(requestStatus({key,message:{documentMessage:{caption,mimetype:'image/gif'}}},phone),'animação aceita');
  }
  assert.equal(requestStatus({key,message:{conversation:`!vf ${url}`}},'5511888888888'),'remetente não autorizado');
  assert.equal(requestStatus({key,message:{conversation:'!vf errado'}},phone),'comando de vídeo inválido');
});

test('um download, ordem dos envios, falhas parciais e limpeza', async () => {
  for (const scenario of ['ok','convert-fail','sticker-fail','video-fail','video-only']) {
    const events:string[]=[];
    let directory='', downloads=0;
    const promise=sendVideoResponse({url,sticker:scenario!=='video-only'}, {
      video:async path=>{ await access(path); events.push('video'); if(scenario==='video-fail') throw new Error('send'); },
      sticker:async()=>{events.push('sticker');if(scenario==='sticker-fail') throw new Error('send');},
      text:async text=>{events.push(text.includes('primeiros')?'trim':'error');},
    }, (link,send)=>withVideo(link,send,async(_,dir)=>{
      downloads++;directory=dir;await writeFile(join(dir,'video.mp4'),'fixture');
    }), async path=>{await access(path);events.push('convert');if(scenario==='convert-fail')throw new Error('convert');return {sticker:Buffer.from('webp'),trimmed:true};});
    if(scenario==='video-fail')await assert.rejects(promise);else await promise;
    assert.equal(downloads,1);
    assert.deepEqual(events, scenario==='ok'?['video','convert','trim','sticker']:
      scenario==='convert-fail'?['video','convert','error']:
      scenario==='sticker-fail'?['video','convert','trim','sticker','error']:['video']);
    await assert.rejects(access(directory));
  }
});

test('conversão local de link: vídeo curto inteiro e primeiros 10 segundos de vídeo longo', async () => {
  const dir=await mkdtemp(join(tmpdir(),'daneel-linked-test-'));
  try {
    for(const duration of [1,12]) {
      const source=join(dir,`input-${duration}.mp4`);
      await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i',`testsrc2=size=120x180:rate=12:duration=${duration}`,
        '-threads','1','-c:v','libx264','-pix_fmt','yuv420p',source],{timeout:15000});
      const result=await createLinkedVideoSticker(source);
      const meta=validateAnimatedSticker(result.sticker);
      assert.equal(result.trimmed,duration>10);
      assert.ok(meta.durationMs>=Math.min(duration,10)*1000-100);
      assert.ok(meta.durationMs<=10000);
      assert.ok((await readFile(source)).length>0);
    }
    await assert.rejects(createLinkedVideoSticker(join(dir,'missing.mp4')));
  } finally {await rm(dir,{recursive:true,force:true});}
});
