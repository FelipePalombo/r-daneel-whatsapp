import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { createSticker, MAX_INPUT_BYTES, MAX_STICKER_BYTES } from '../src/sticker.js';
import { readBounded, stickerRequest } from '../src/request.js';

test('foto retangular vira WebP 512x512 com bordas transparentes, sem EXIF', async () => {
  const input = await sharp({ create: { width: 800, height: 400, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const output = await createSticker(input);
  const meta = await sharp(output).metadata();
  assert.equal(meta.format, 'webp'); assert.equal(meta.width, 512); assert.equal(meta.height, 512);
  assert.ok(output.length <= MAX_STICKER_BYTES); assert.equal(meta.exif, undefined);
  const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0);
  assert.equal(data[(256 * info.width + 256) * 4 + 3], 255);
});
test('imagem com ruído também cabe no limite', async () => {
  const input = await sharp(randomBytes(768 * 768 * 3), { raw: { width: 768, height: 768, channels: 3 } }).png().toBuffer();
  assert.ok((await createSticker(input)).length <= MAX_STICKER_BYTES);
});
test('recusa conteúdo inválido, SVG e arquivos grandes', async () => {
  await assert.rejects(createSticker(Buffer.from('não é imagem')));
  await assert.rejects(createSticker(Buffer.alloc(MAX_INPUT_BYTES + 1)));
  await assert.rejects(createSticker(Buffer.from('<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg"></svg>')));
});
test('autoriza somente dono, imagem direta e comando; ignora grupos e mensagens próprias', () => {
  const phone = '5511999999999';
  const message = { key: { id: 'test', remoteJid: `${phone}@s.whatsapp.net`, fromMe: false }, message: { imageMessage: { caption: '!figurinha' } } };
  assert.equal(stickerRequest(message, phone), true);
  assert.equal(stickerRequest(message, '5511888888888'), false);
  assert.equal(stickerRequest({ ...message, key: { ...message.key, remoteJid: 'group@g.us' } }, phone), false);
  assert.equal(stickerRequest({ ...message, key: { ...message.key, fromMe: true } }, phone), false);
  assert.equal(stickerRequest({ ...message, message: { imageMessage: { caption: 'foto' } } }, phone), false);
  assert.equal(stickerRequest({ ...message, key: { ...message.key, remoteJid: '123@lid', remoteJidAlt: `${phone}@s.whatsapp.net` } }, phone), true);
  assert.equal(stickerRequest({ ...message, key: { ...message.key, remoteJid: '123@lid' } }, phone), false);
});
test('download limita bytes efetivamente lidos', async () => {
  async function* stream() { yield Buffer.alloc(6); yield Buffer.alloc(6); }
  await assert.rejects(readBounded(stream(), 10));
  assert.equal((await readBounded(stream(), 12)).length, 12);
});

test('aceita foto em mensagem temporária e continua bloqueando visualização única', () => {
  const phone = '5511999999999';
  const key = { id: 'temp', remoteJid: `${phone}@s.whatsapp.net`, fromMe: false };
  const image = { imageMessage: { caption: '!figurinha' } };
  assert.equal(stickerRequest({ key, message: { ephemeralMessage: { message: image } } }, phone), true);
  assert.equal(stickerRequest({ key, message: { viewOnceMessage: { message: image } } }, phone), false);
  assert.equal(stickerRequest({ key, message: { ephemeralMessage: { message: { viewOnceMessage: { message: image } } } } }, phone), false);
});

test('aceita nono dígito ausente no identificador brasileiro e rejeita números diferentes', () => {
  const phone = '5551998765432';
  const base = { key: { id: 'legacy', fromMe: false }, message: { imageMessage: { caption: '!figurinha' } } };
  const withJid = (remoteJid: string) => ({ ...base, key: { ...base.key, remoteJid } });
  assert.equal(stickerRequest(withJid('555198765432@s.whatsapp.net'), phone), true);
  assert.equal(stickerRequest(withJid('5551998765432@s.whatsapp.net'), phone), true);
  assert.equal(stickerRequest(withJid('555198765431@s.whatsapp.net'), phone), false);
  assert.equal(stickerRequest(withJid('555298765432@s.whatsapp.net'), phone), false);
  assert.equal(stickerRequest(withJid('555198765432@lid'), phone), false);
  assert.equal(stickerRequest(withJid('155198765432@s.whatsapp.net'), '1551998765432'), false);
});
