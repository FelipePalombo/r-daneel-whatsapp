import test from 'node:test';
import assert from 'node:assert/strict';
import {requestStatus,stickerRequest,requestedVideo} from '../src/request.js';
import {HELP_TEXT} from '../src/help.js';
test('help aceita texto e mensagens temporárias, mantendo autorização e bloqueios',()=>{
  const phone='5511999999999';
  const key={id:'help',remoteJid:`${phone}@s.whatsapp.net`};
  for(const text of ['!help',' !HELP ']) {
    const message={key,message:{conversation:text}};
    assert.equal(requestStatus(message,phone),'ajuda aceita');
    assert.equal(stickerRequest(message,phone),false);
    assert.equal(requestedVideo(message),undefined);
    assert.equal(requestStatus(message,'5511888888888'),'remetente não autorizado');
    assert.equal(requestStatus({...message,key:{...key,fromMe:true}},phone),'mensagem própria');
    assert.equal(requestStatus({...message,key:{...key,remoteJid:'group@g.us'}},phone),'conversa não permitida');
    assert.equal(requestStatus({key,message:{ephemeralMessage:{message:{extendedTextMessage:{text}}}}},phone),'ajuda aceita');
  }
  for(const text of ['!help extra','!helpfoo'])assert.notEqual(requestStatus({key,message:{conversation:text}},phone),'ajuda aceita');
  for(const command of ['!help','!figurinha','!f','!video','!v','!vfigurinha','!vf','!gifigurinha','!gf'])assert.ok(HELP_TEXT.includes(command));
});
