import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedNumbers } from '../src/access.js';
import { stickerRequest } from '../src/request.js';

test('valida lista e rejeita configuração que liberaria acesso indevido', () => {
  assert.deepEqual(parseAllowedNumbers('{"numbers":["5511999999999","5511999999999","5521988888888"]}'), ['5511999999999','5521988888888']);
  for (const text of ['{}','null','{"numbers":[]}','{"numbers":[5511999999999]}','{"numbers":["*"]}','{"numbers":["+55 11 99999-9999"]}','invalid']) assert.throws(() => parseAllowedNumbers(text));
});
test('aceita membros distintos e recusa quem não está na lista', () => {
  const phones = ['5511999999999','5521988888888'];
  const message = (remoteJid: string) => ({ key: { id: 'test', remoteJid, fromMe: false }, message: { imageMessage: { caption: '!figurinha' } } });
  assert.equal(stickerRequest(message(`${phones[0]}@s.whatsapp.net`),phones),true);
  assert.equal(stickerRequest(message(`${phones[1]}@s.whatsapp.net`),phones),true);
  assert.equal(stickerRequest(message('552188888888@s.whatsapp.net'),phones),true);
  assert.equal(stickerRequest(message('5531999999999@s.whatsapp.net'),phones),false);
  assert.equal(stickerRequest(message('5511999999999@s.whatsapp.net'),[]),false);
});
