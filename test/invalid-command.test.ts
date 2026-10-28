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
