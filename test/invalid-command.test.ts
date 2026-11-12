import test from 'node:test';
import assert from 'node:assert/strict';
import {requestStatus,invalidCommandReply,requestedVideo} from '../src/request.js';
const phone='5511999999999';
const key={id:'command-errors',remoteJid:`${phone}@s.whatsapp.net`};
test('comandos desconhecidos e formatos incorretos orientam uso em texto e legenda',()=>{
  for(const [text,status,reply] of [
    ['!teste','comando desconhecido','!help'],[' !F ','comando em formato inválido','legenda'],
    ['!f texto','comando em formato inválido','legenda'],['!help extra','comando em formato inválido','sem argumentos'],
    ['!vf','comando de vídeo inválido','!vf <link'],['!v errado','comando de vídeo inválido','!video <link'],
    ['!gf','comando de gif inválido','!gf <link'],['!gifigurinha errado','comando de gif inválido','!gf <link'],
  ]) {
    const message={key,message:{conversation:text}};
    assert.equal(requestStatus(message,phone),status,text);
    assert.ok(invalidCommandReply(message).includes(reply!));
  }
  for(const content of [{imageMessage:{caption:'!foo'}},{videoMessage:{caption:'!foo'}},
    {documentMessage:{caption:'!foo'}},{ephemeralMessage:{message:{imageMessage:{caption:'!foo'}}}}]) {
    const m={key,message:content};assert.equal(requestStatus(m,phone),'comando desconhecido');
    assert.ok(invalidCommandReply(m).includes('não existe'));
    assert.equal(requestStatus(m,'5511888888888'),'remetente não autorizado');
    assert.equal(requestStatus({...m,key:{...key,remoteJid:'group@g.us'}},phone),'conversa não permitida');
    assert.equal(requestStatus({...m,key:{...key,fromMe:true}},phone),'mensagem própria');
    assert.notEqual(requestStatus({key,message:{viewOnceMessage:{message:content}}},phone),'comando desconhecido');
  }
});
test('texto comum é ignorado e comandos válidos em legendas continuam processáveis',()=>{
  for(const text of ['oi','bom dia','isso é !teste'])assert.ok(!requestStatus({key,message:{conversation:text}},phone).startsWith('comando'));
  assert.equal(requestStatus({key,message:{imageMessage:{caption:'!f'}}},phone),'aceita');
  assert.equal(requestStatus({key,message:{videoMessage:{caption:'!gf',gifPlayback:true}}},phone),'animação aceita');
  const m={key,message:{imageMessage:{caption:'!vf https://x.com/example/status/123'}}};
  assert.equal(requestStatus(m,phone),'vídeo aceito');assert.equal(requestedVideo(m)?.sticker,true);
});

test('perfis funcionam em anexos e links e rejeitam argumentos incorretos', async () => {
  const {stickerProfile,isAnimationStickerCommand,parseGifCommand,parseVideoCommand}=await import('../src/request.js');
  for(const value of ['!f fluida',' !GF NÍTIDA ','!figurinha equilibrada']) assert.equal(isAnimationStickerCommand(value),true);
  assert.equal(stickerProfile('!f NÍTIDA'),'nitida');
  assert.equal(stickerProfile('!f'),'equilibrada');
  assert.equal(isAnimationStickerCommand('!f rapido'),false);
  assert.equal(parseGifCommand('!gf fluida https://example.com/a.gif'),'https://example.com/a.gif');
  assert.equal(parseGifCommand('!gf rapido https://example.com/a.gif'),undefined);
  assert.equal(parseVideoCommand('!vf nitida https://x.com/example/status/123')?.profile,'nitida');
  assert.equal(parseVideoCommand('!v fluida https://x.com/example/status/123'),undefined);
});

test('mídias e links automáticos preservam autorização e aceitam !f antes ou depois do link',async()=>{
  const {requestStatus,parseVideoCommand,parseGifCommand}=await import('../src/request.js');
  const phone='5511999999999',key={id:'auto',remoteJid:`${phone}@s.whatsapp.net`};
  for(const message of [{imageMessage:{}},{imageMessage:{caption:'oi'}},{videoMessage:{}},{videoMessage:{gifPlayback:true}}]) {
    assert.ok(['aceita','animação aceita'].includes(requestStatus({key,message},phone)));
    assert.equal(requestStatus({key,message},'5511888888888'),'remetente não autorizado');
    assert.notEqual(requestStatus({key,message:{viewOnceMessage:{message}}},phone),'aceita');
  }
  const link='https://x.com/user/status/123';
  assert.equal(parseVideoCommand(link)?.sticker,false);
  assert.equal(parseVideoCommand('!f '+link)?.sticker,true);
  assert.equal(parseVideoCommand(link+' !f')?.sticker,true);
  assert.equal(parseGifCommand('https://example.com/test.gif'),'https://example.com/test.gif');
  assert.equal(parseGifCommand('https://example.com/page'),undefined);
  assert.equal(requestStatus({key,message:{imageMessage:{caption:'!invalido'}}},phone),'comando desconhecido');
});
