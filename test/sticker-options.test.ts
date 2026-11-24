import test from 'node:test';
import assert from 'node:assert/strict';
import { stickerOptions, shouldOptimize } from '../src/sticker-options.js';
import { soundEnabledFor } from '../src/sound-gate.js';
import { parseVideoCommand, requestStatus, stickerProfile } from '../src/request.js';

test('interpreta modos e preserva comandos e links', () => {
  const url = 'https://x.com/i/web/status/123';
  assert.deepEqual(stickerOptions(` !VF !NORMAL ${url} `), {sound:false, mode:'normal', text:`!VF ${url}`, valid:true});
  assert.deepEqual(parseVideoCommand(`!vf !qualidade ${url}`), {url, sticker:true, profile:'nitida'});
  assert.equal(stickerProfile('!gf fluida !qualidade'), 'nitida');
  assert.equal(stickerOptions('!normal !otimizar').valid, false);
  assert.equal(shouldOptimize('normal', false), false);
  assert.equal(shouldOptimize('qualidade', false), false);
  assert.equal(shouldOptimize(undefined, false), true);
});

test('aceita opção de áudio em vídeo e mantém autorização', () => {
  const key={id:'1',remoteJid:'5511999999999@s.whatsapp.net'};
  assert.equal(requestStatus({key,message:{videoMessage:{caption:'!som'}}},'5511999999999'), 'animação aceita');
  assert.equal(requestStatus({key,message:{videoMessage:{caption:'!som'}}},'5511888888888'), 'remetente não autorizado');
});

test('o som segue a lista de números autorizados', () => {
  const allowed=['5511999999999','5511888888888'];
  for (const phone of allowed) {
    const message={key:{id:'1',remoteJid:`${phone}@s.whatsapp.net`}};
    assert.equal(soundEnabledFor(message,true,allowed),true);
    assert.equal(soundEnabledFor(message,false,allowed),false);
  }
  const blocked={key:{id:'2',remoteJid:'5511777777777@s.whatsapp.net'}};
  assert.equal(soundEnabledFor(blocked,true,allowed),false);
  assert.equal(soundEnabledFor({key:{id:'3',remoteJid:'123@g.us'}},true,allowed),false);
  assert.equal(soundEnabledFor({key:{id:'4',remoteJid:`${allowed[0]}@s.whatsapp.net`,fromMe:true}},true,allowed),false);
});
