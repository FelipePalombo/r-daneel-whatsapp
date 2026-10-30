import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { videoUrl, withVideo, MAX_VIDEO_BYTES } from '../src/video.js';
import { requestStatus, stickerRequest } from '../src/request.js';

test('normaliza links X/Twitter e rejeita hosts, credenciais e texto extra', () => {
  assert.equal(videoUrl('!video https://twitter.com/example/status/123/video/1?s=20'), 'https://x.com/i/web/status/123');
  for (const value of ['https://x.com.evil.test/a/status/123', 'https://x.com@evil.test/a/status/123', 'http://x.com/a/status/123', 'https://x.com/a/status/123 ; touch /tmp/bad', 'https://x.com/a', 'https://x.com:443/a/status/123/../foo']) assert.equal(videoUrl(value), undefined);
});

test('vídeo só é aceito em conversa autorizada; figurinha não confunde comando', () => {
  const phone = '5511999999999';
  const message = { key: { id: 'video', remoteJid: `${phone}@s.whatsapp.net` }, message: { extendedTextMessage: { text: 'https://x.com/example/status/123' } } };
  assert.equal(requestStatus(message, phone), 'vídeo aceito');
  assert.equal(stickerRequest(message, phone), false);
  assert.equal(requestStatus(message, '5511888888888'), 'remetente não autorizado');
  assert.equal(requestStatus({ ...message, key: { ...message.key, remoteJid: 'group@g.us' } }, phone), 'conversa não permitida');
  assert.equal(requestStatus({ ...message, message: { conversation: '!video errado' } }, phone), 'comando de vídeo inválido');
});

test('mantém arquivo até envio e remove temporários após sucesso ou falha', async () => {
  for (const fail of [false, true]) {
    let directory = '';
    const result = withVideo('https://x.com/example/status/123', async path => {
      await access(path);
      if (fail) throw new Error('envio falhou');
    }, async (args, dir) => {
      directory = dir;
      assert.equal(args.at(-1), 'https://x.com/i/web/status/123');
      assert.ok(args.includes('--ignore-config'));
      // Instagram pode não anunciar duração: o limite é validado com ffprobe após baixar.
      assert.ok(args.includes('duration <=? 180 & !is_live'));
      const selector = args[args.indexOf('-f') + 1]!;
      assert.ok(selector.includes('[filesize<=?16777216][filesize_approx<=?16777216]'));
      await writeFile(join(dir, 'video.mp4'), 'fixture');
    });
    if (fail) await assert.rejects(result); else await result;
    await assert.rejects(access(directory));
  }
});

test('rejeita arquivo acima do limite e limpa falha no download', async () => {
  let directory = '';
  await assert.rejects(withVideo('https://x.com/example/status/123', async () => assert.fail('não deve enviar'), async (_, dir) => {
    directory = dir;
    const path = join(dir, 'video.mp4');
    await writeFile(path, ''); await truncate(path, MAX_VIDEO_BYTES + 1);
  }));
  await assert.rejects(access(directory));
  await assert.rejects(withVideo('https://x.com/example/status/123', async () => assert.fail(), async (_, dir) => {
    directory = dir; throw new Error('download falhou');
  }));
  await assert.rejects(access(directory));
});


test('Instagram: aceita publicações e Reels, remove rastreamento e rejeita outros endereços', () => {
  for (const kind of ['p', 'reel', 'reels', 'tv']) {
    assert.equal(videoUrl(`!video https://www.instagram.com/${kind}/Abc_123-xyz/?igsh=tracking`),
      `https://www.instagram.com/${kind === 'reels' ? 'reel' : kind}/Abc_123-xyz/`);
  }
  for (const value of ['https://instagram.com.evil.test/reel/Abc123/', 'https://instagram.com/stories/user/123/',
    'https://instagram.com/user/', 'https://instagram.com/reel/Abc123/extra',
    'https://user@instagram.com/reel/Abc123/', 'https://instagram.com/reel/Abc123/ texto']) {
    assert.equal(videoUrl(value), undefined);
  }
});

test('Instagram usa a mesma autorização, download e limpeza dos vídeos do X', async () => {
  const phone = '5511999999999';
  const message = { key: { id: 'ig', remoteJid: `${phone}@s.whatsapp.net` },
    message: { conversation: 'https://instagram.com/reel/Abc123/?igsh=tracking' } };
  assert.equal(requestStatus(message, phone), 'vídeo aceito');
  assert.equal(requestStatus(message, '5511888888888'), 'remetente não autorizado');
  let directory = '';
  await withVideo(message.message.conversation, async path => { await access(path); }, async (args, dir) => {
    directory = dir;
    assert.equal(args.at(-1), 'https://www.instagram.com/reel/Abc123/');
    await writeFile(join(dir, 'video.mp4'), 'fixture');
  });
  await assert.rejects(access(directory));
});
