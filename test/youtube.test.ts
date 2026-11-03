import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, access, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { videoUrl, videoPlatform, videoFailureReply, VideoRateLimitError, withVideo } from '../src/video.js';
import { parseVideoCommand, requestStatus, commandUsage } from '../src/request.js';
import { sendVideoResponse } from '../src/video-response.js';
import { HELP_TEXT } from '../src/help.js';
import { youtubeChoices, downloadYoutubeDirect, youtubeMediaUsage } from '../src/youtube-direct.js';
import { downloadYoutube } from '../src/youtube-download.js';
import type { PublicHttp, HttpReply } from '../src/public-http.js';
const id = 'AbC_123-xyz', url = `https://www.youtube.com/shorts/${id}`;
const fixture = Buffer.from('0000ftypisomfixture');
const video = { format_id: '136', ext: 'mp4', protocol: 'https', vcodec: 'avc1.4D401F', acodec: 'none', width: 720, height: 1036, tbr: 2000 };
const audio = { format_id: '140', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 };
const progressive = { ...video, format_id: '18', acodec: 'mp4a.40.2', width: 360, height: 518 };
function info(formats: unknown[] = [video, audio, progressive]) { return { id, duration: 14, is_live: false, formats }; }
async function sparse(path: string, bytes: number) { await writeFile(path, ''); await truncate(path, bytes); }
function reply(body: string | Buffer, status = 200, headers: HttpReply['headers'] = {}): HttpReply {
  return { status, headers, body: (async function* () { yield Buffer.from(body); })(), close: () => {} };
}
function network(request: PublicHttp['request']): PublicHttp { return { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request }; }

test('Shorts: normaliza hosts e rastreamento; rejeita outros formatos e endereços', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com']) assert.equal(videoUrl(`https://${host}/shorts/${id}/?is=tracking&si=more`), url);
  for (const value of [`http://youtube.com/shorts/${id}`, `https://youtube.com.evil.test/shorts/${id}`, `https://user@youtube.com/shorts/${id}`, `https://youtube.com:8443/shorts/${id}`, `https://youtube.com/shorts/${id}/extra`, `https://youtube.com/shorts/${id}#fragment`, `https://youtube.com/watch?v=${id}`, `https://youtu.be/${id}`, 'https://youtube.com/playlist?list=abc', 'https://youtube.com/live/abc', 'https://youtube.com/@channel', 'https://youtube.com/shorts/short', `${url} texto`]) assert.equal(videoUrl(value), undefined);
  assert.equal(videoPlatform(url), 'youtube'); assert.equal(videoPlatform('https://x.com/i/web/status/123'), 'twitter'); assert.equal(videoPlatform('https://www.instagram.com/reel/Example123/'), 'instagram');
  assert.match(videoFailureReply(new VideoRateLimitError(), url), /YouTube/);
  assert.match(videoFailureReply(new Error('login'), url), /YouTube/);
});

test('Shorts: comandos, legenda, maiúsculas e autorização existentes', () => {
  const phone = '5511999999999', key = { id: 'shorts', remoteJid: `${phone}@s.whatsapp.net` };
  for (const command of ['!v', '!video', '!vf', '!vfigurinha']) {
    const text = ` ${command.toUpperCase()}  ${url}?is=tracking `;
    assert.deepEqual(parseVideoCommand(text), { url, sticker: ['!vf', '!vfigurinha'].includes(command) });
    assert.equal(requestStatus({ key, message: { imageMessage: { caption: text } } }, phone), 'vídeo aceito');
    assert.equal(requestStatus({ key, message: { conversation: text } }, '5511888888888'), 'remetente não autorizado');
    assert.equal(requestStatus({ key: { ...key, remoteJid: 'group@g.us' }, message: { conversation: text } }, phone), 'conversa não permitida');
    assert.match(commandUsage(command)!, /YouTube Shorts/);
  }
  assert.deepEqual(parseVideoCommand(url), { url, sticker: false }); assert.match(HELP_TEXT, /YouTube Shorts/);
});

test('Shorts: escolhe H264/AAC até 720p, soma estimativas e prefere tamanho exato', () => {
  assert.deepEqual(youtubeChoices(info(), id), [{ video: '136', audio: '140' }, { video: '18' }]);
  assert.deepEqual(youtubeChoices(info([{ ...video, filesize: 1000, filesize_approx: 40e6 }, audio]), id), [{ video: '136', audio: '140' }]);
  assert.deepEqual(youtubeChoices(info([{ ...video, filesize: 15e6 }, { ...audio, filesize_approx: 2e6 }, progressive]), id), [{ video: '18' }]);
  for (const data of [null, { ...info(), id: 'other' }, { ...info(), is_live: true }, { ...info(), duration: 181 }, info([{ ...video, vcodec: 'av01' }, audio]), info([{ ...video, width: 1080, height: 1920 }, audio]), info([{ ...video, protocol: 'm3u8_native' }, audio]), info([{ ...video, format_id: '136;bad' }, audio]), info([video]), info([audio])]) assert.throws(() => youtubeChoices(data, id));
});

test('Shorts: uma extração, faixas separadas, remux e limpeza dos componentes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-mux-')); const events: string[] = [];
  try {
    await downloadYoutubeDirect(url, dir, 5000, async (args, directory, timeout) => {
      assert.equal(directory, dir); assert.ok(timeout > 0 && timeout <= 5000); assert.ok(args.includes('--js-runtimes')); assert.equal(args[args.indexOf('--js-runtimes') + 1], 'node'); assert.equal(args[args.indexOf('--fixup') + 1], 'never'); assert.ok(!args.some(x => x.includes('cookies')));
      if (args.includes('--dump-single-json')) { events.push('metadata'); return JSON.stringify(info()); }
      assert.ok(args.includes('--load-info-json')); assert.equal((await stat(join(dir, 'youtube-info.json'))).mode & 0o777, 0o600);
      const name = args[args.indexOf('-o') + 1]!; events.push(name); await writeFile(join(dir, name), fixture); return '';
    }, async directory => {
      events.push('mux'); await access(join(directory, 'video-track.mp4')); await access(join(directory, 'audio-track.m4a')); await writeFile(join(directory, 'video.mp4'), fixture);
    });
    assert.deepEqual(events, ['metadata', 'video-track.mp4', 'audio-track.m4a', 'mux']); assert.deepEqual(await readFile(join(dir, 'video.mp4')), fixture);
    for (const file of ['youtube-info.json', 'video-track.mp4', 'audio-track.m4a']) await assert.rejects(access(join(dir, file)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Shorts: soma real das faixas acima de 16 MiB tenta qualidade menor sem repetir metadados', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-limit-')); let metadata = 0;
  try {
    await downloadYoutubeDirect(url, dir, 5000, async args => {
      if (args.includes('--dump-single-json')) { metadata++; return JSON.stringify(info()); }
      const name = args[args.indexOf('-o') + 1]!;
      if (name === 'video-track.mp4') await sparse(join(dir, name), 9 * 1024 * 1024);
      else if (name === 'audio-track.m4a') await sparse(join(dir, name), 8 * 1024 * 1024);
      else { await assert.rejects(access(join(dir, 'video-track.mp4'))); await writeFile(join(dir, name), fixture); }
      return '';
    }, async () => assert.fail('faixas grandes não podem ser mescladas'));
    assert.equal(metadata, 1); assert.deepEqual(await readFile(join(dir, 'video.mp4')), fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Shorts: remux acima do limite, falha e timeout limpam temporários', async () => {
  for (const mode of ['large', 'error', 'timeout']) {
    const dir = await mkdtemp(join(tmpdir(), 'shorts-cleanup-'));
    try {
      await assert.rejects(downloadYoutubeDirect(url, dir, mode === 'timeout' ? 20 : 5000, async args => {
        if (args.includes('--dump-single-json')) { if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 30)); return JSON.stringify(info([video, audio])); }
        await writeFile(join(dir, args[args.indexOf('-o') + 1]!), fixture); return '';
      }, async () => { if (mode === 'error') throw new Error('merge failed'); await sparse(join(dir, 'video.mp4'), 16777217); }));
      for (const file of ['video.mp4', 'youtube-info.json', 'video-track.mp4', 'audio-track.m4a']) await assert.rejects(access(join(dir, file)));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('Shorts: monitor soma componentes e .part sem dobrar arquivo durante remux', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-usage-'));
  try {
    await sparse(join(dir, 'video-track.mp4'), 10e6); await sparse(join(dir, 'audio-track.m4a.part'), 6e6); await sparse(join(dir, 'video.mp4'), 16e6);
    assert.deepEqual(await youtubeMediaUsage(dir), { tracks: 16e6, output: 16e6 });
    await sparse(join(dir, 'audio-track.m4a'), 7e6);
    assert.deepEqual(await youtubeMediaUsage(dir), { tracks: 17e6, output: 16e6 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('YouTube externo: orçamento único, requisição configurada e download sem cookies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'youtube-api-')); let calls = 0, signal: AbortSignal | undefined;
  try {
    await downloadYoutube(url, dir, network(async (target, _, currentSignal, method, headers, body) => {
      if (signal) assert.equal(signal, currentSignal); else signal = currentSignal;
      assert.equal(headers.Cookie, undefined);
      if (++calls === 1) {
        assert.equal(target.hostname, 'rue-cobalt.xenon.zone'); assert.equal(method, 'POST'); const request = JSON.parse(body!);
        assert.equal(request.url, url); assert.equal(request.youtubeVideoCodec, 'h264'); assert.equal(request.videoQuality, '720'); assert.equal(request.localProcessing, 'disabled'); assert.equal(request.alwaysProxy, true);
        return reply(JSON.stringify({ status: 'tunnel', url: 'https://rue-cobalt.xenon.zone/tunnel?id=fake' }));
      }
      return reply(fixture);
    }));
    assert.equal(calls, 2); assert.deepEqual(await readFile(join(dir, 'video.mp4')), fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('YouTube externo: bloqueia host estranho, HTTP, login, corpo grande e mídia inválida', async () => {
  for (const mode of ['host', 'http', 'login', 'large-text', 'large-video', 'invalid-video', 'invalid-json']) {
    const dir = await mkdtemp(join(tmpdir(), 'youtube-api-fail-')); let calls = 0;
    try {
      await assert.rejects(downloadYoutube(url, dir, network(async () => {
        if (++calls === 1) {
          if (mode === 'login') return reply(JSON.stringify({ status: 'error', error: { code: 'api.auth.missing' } }));
          if (mode === 'invalid-json') return reply('captcha html');
          const target = mode === 'host' ? 'https://googlevideo.com.evil.test/x' : mode === 'http' ? 'http://rue-cobalt.xenon.zone/x' : 'https://r1.example.googlevideo.com/x';
          return reply(JSON.stringify({ status: 'redirect', url: target }), 200, mode === 'large-text' ? { 'content-length': '1048577' } : {});
        }
        return reply(mode === 'invalid-video' ? 'html' : fixture, 200, mode === 'large-video' ? { 'content-length': '16777217' } : {});
      })));
      await assert.rejects(access(join(dir, 'video.mp4')));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('YouTube: ordem de contingência, erro de envio e isolamento dos provedores', async () => {
  const old = process.env.COBALT_API_URL; process.env.COBALT_API_URL = 'http://cobalt.test/'; const events: string[] = []; let directory = '';
  try {
    await assert.rejects(withVideo(url, async () => { events.push('send'); throw new Error('send failed'); }, async (args, dir) => {
      directory = dir; assert.ok(args.includes('--js-runtimes')); events.push('direct'); throw new Error('YouTube login');
    }, { fallback: async () => { events.push('cobalt'); throw new Error('login'); }, onExternalFallback: async () => { events.push('notice'); },
      youtubeFallback: async (_, dir) => { events.push('youtube'); await writeFile(join(dir, 'video.mp4'), fixture); },
      externalFallback: async () => assert.fail('Instagram'), twitterFallback: async () => assert.fail('Twitter'),
    }), /send failed/);
    assert.deepEqual(events, ['direct', 'cobalt', 'notice', 'youtube', 'send']); await assert.rejects(access(directory));
    const previous = process.env.YOUTUBE_FALLBACK_ENABLED; process.env.YOUTUBE_FALLBACK_ENABLED = 'false';
    try { await assert.rejects(withVideo(url, async () => assert.fail(), async () => { throw new Error('login'); }, { fallback: async () => { throw new Error('login'); }, youtubeFallback: async () => assert.fail('desativado') })); }
    finally { if (previous === undefined) delete process.env.YOUTUBE_FALLBACK_ENABLED; else process.env.YOUTUBE_FALLBACK_ENABLED = previous; }
  } finally { if (old === undefined) delete process.env.COBALT_API_URL; else process.env.COBALT_API_URL = old; }
});

test('Shorts vf: download único, vídeo antes do recorte e figurinha; falha parcial específica', async () => {
  for (const fail of [false, true]) {
    const events: string[] = []; let calls = 0;
    await sendVideoResponse({ url, sticker: true }, { video: async () => { events.push('video'); }, sticker: async () => { events.push('sticker'); }, text: async text => { events.push(text.includes('primeiros') ? 'trim' : 'partial'); } },
      async (_url, send) => { calls++; await send('/tmp/fixture.mp4'); }, async () => { if (fail) throw new Error('convert'); return { sticker: fixture, trimmed: true }; });
    assert.equal(calls, 1); assert.deepEqual(events, fail ? ['video', 'partial'] : ['video', 'trim', 'sticker']);
  }
});
