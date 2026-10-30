import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { twitterMedia, downloadTwitter } from '../src/twitter-download.js';
import type { PublicHttp, HttpReply } from '../src/public-http.js';
import { withVideo } from '../src/video.js';
const id = '1234567890123456789';
const url = `https://x.com/i/web/status/${id}`;
const media = 'https://video.twimg.com/ext_tw_video/example/vid/avc1/640x360/sample.mp4';
const fixture = Buffer.from('0000ftypisomfixture');
const fx = { code: 200, status: { id, media: { videos: [{ url: media, duration: 30 }] } } };
const vx = { tweetID: id, media_extended: [{ type: 'image', url: 'https://pbs.twimg.com/photo.jpg' }, { type: 'video', url: media, duration_millis: 30000 }] };
function reply(body: Buffer | string, status = 200, headers: HttpReply['headers'] = {}): HttpReply {
  return { status, headers, body: (async function* () { yield Buffer.from(body); })(), close: () => {} };
}
function io(request: PublicHttp['request']): PublicHttp {
  return { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request };
}

test('Fx/Vx: identifica post, primeiro vídeo, MP4 público e limite de duração', () => {
  assert.deepEqual(twitterMedia(fx, 'fx', id), [media]);
  assert.deepEqual(twitterMedia(vx, 'vx', id), [media]);
  assert.throws(() => twitterMedia({ ...fx, code: 404 }, 'fx', id));
  assert.throws(() => twitterMedia(fx, 'fx', '999'));
  assert.throws(() => twitterMedia({ ...vx, tweetID: Number(id) }, 'vx', id));
  for (const candidate of ['https://video.twimg.com.evil.test/x.mp4', 'http://video.twimg.com/x.mp4', 'https://user@video.twimg.com/x.mp4', 'https://video.twimg.com/x.m3u8', 'https://video.twimg.com/x/hevc/x.mp4']) {
    assert.throws(() => twitterMedia({ code: 200, status: { id, media: { videos: [{ url: candidate }, { url: media }] } } }, 'fx', id));
  }
  assert.throws(() => twitterMedia({ code: 200, status: { id, media: { videos: [{ url: media, duration: 181 }] } } }, 'fx', id));
  assert.throws(() => twitterMedia({ tweetID: id, media_extended: [{ type: 'gif', url: media, duration_millis: 181000 }] }, 'vx', id));
  for (const malformed of [null, [], 'html', { code: 200, status: { id, media: { videos: {} } } }]) assert.throws(() => twitterMedia(malformed, 'fx', id));
});

test('FxTwitter: uma consulta e uma mídia; sucesso não consulta VxTwitter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fx-test-')); const calls: string[] = [];
  try {
    await downloadTwitter(url, dir, io(async (target, _, signal, method, headers) => {
      calls.push(target.hostname); assert.equal(method, 'GET'); assert.equal(signal.aborted, false); assert.match(headers['User-Agent']!, /^R-Daneel/);
      if (target.hostname === 'api.fxtwitter.com') { assert.equal(target.pathname, `/2/status/${id}`); return reply(JSON.stringify(fx)); }
      assert.equal(target.hostname, 'video.twimg.com'); return reply(fixture);
    }));
    assert.deepEqual(calls, ['api.fxtwitter.com', 'video.twimg.com']); assert.deepEqual(await readFile(join(dir, 'video.mp4')), fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('VxTwitter recupera falha HTTP, resposta inválida, mídia inválida ou grande do Fx', async () => {
  for (const mode of ['http', 'json', 'media', 'size']) {
    const dir = await mkdtemp(join(tmpdir(), 'vx-test-')); const calls: string[] = [];
    try {
      await downloadTwitter(url, dir, io(async target => {
        calls.push(target.hostname);
        if (target.hostname === 'api.fxtwitter.com') return mode === 'http' ? reply('blocked', 403) : reply(mode === 'json' ? 'invalid JSON' : JSON.stringify(fx));
        if (target.hostname === 'api.vxtwitter.com') { assert.equal(target.pathname, `/i/status/${id}`); return reply(JSON.stringify(vx)); }
        const beforeVx = !calls.includes('api.vxtwitter.com');
        return beforeVx ? reply('bad', 200, mode === 'size' ? { 'content-length': '16777217' } : {}) : reply(fixture);
      }));
      assert.ok(calls.includes('api.vxtwitter.com')); assert.deepEqual(await readFile(join(dir, 'video.mp4')), fixture);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('Fx/Vx: timeout reserva tempo para o segundo serviço e não duplica minuto extra', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twitter-timeout-'));
  const keepAlive = setTimeout(() => {}, 2000);
  const started = Date.now();
  try {
    await downloadTwitter(url, dir, {
      resolve: async host => host === 'api.fxtwitter.com' ? new Promise(() => {}) : [{ address: '8.8.8.8', family: 4 }],
      request: async target => reply(target.hostname === 'api.vxtwitter.com' ? JSON.stringify(vx) : fixture),
    }, { timeoutMs: 100 });
    assert.deepEqual(await readFile(join(dir, 'video.mp4')), fixture);
    await assert.rejects(downloadTwitter(url, dir, { resolve: async () => new Promise(() => {}), request: async () => assert.fail() }, { timeoutMs: 60 }));
    assert.ok(Date.now() - started < 1500);
  } finally { clearTimeout(keepAlive); await rm(dir, { recursive: true, force: true }); }
});

test('Fx/Vx: preserva validação DNS e redirects para mídia; falhas não gravam arquivo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twitter-block-')); let internalRequests = 0;
  try {
    await assert.rejects(downloadTwitter(url, dir, {
      resolve: async host => [{ address: host === 'video.twimg.com' ? '127.0.0.1' : '8.8.8.8', family: 4 }],
      request: async target => {
        if (target.hostname === 'video.twimg.com') { internalRequests++; return reply(fixture); }
        return reply(JSON.stringify(target.hostname === 'api.fxtwitter.com' ? fx : vx));
      },
    }));
    assert.equal(internalRequests, 0); await assert.rejects(access(join(dir, 'video.mp4')));
    await assert.rejects(downloadTwitter('https://www.instagram.com/reel/Example123/', dir, io(async () => assert.fail())));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('X: ordem direto -> Cobalt -> aviso -> Fx/Vx; falha de envio não repete download', async () => {
  const old = process.env.COBALT_API_URL; process.env.COBALT_API_URL = 'http://cobalt.test/'; const events: string[] = []; let directory = '';
  try {
    await assert.rejects(withVideo(url, async () => { events.push('send'); throw new Error('send failed'); }, async (_, dir) => { directory = dir; events.push('direct'); throw new Error('empty'); }, {
      fallback: async () => { events.push('cobalt'); throw new Error('empty'); },
      onExternalFallback: async () => { events.push('notice'); },
      externalFallback: async () => assert.fail('Instagram não deve ser consultado'),
      twitterFallback: async (_, dir) => { events.push('twitter'); await writeFile(join(dir, 'video.mp4'), fixture); },
    }), /send failed/);
    assert.deepEqual(events, ['direct', 'cobalt', 'notice', 'twitter', 'send']); await assert.rejects(access(directory));
  } finally { if (old === undefined) delete process.env.COBALT_API_URL; else process.env.COBALT_API_URL = old; }
});

test('Fx/Vx podem ser desativados separadamente ou juntos', async () => {
  const oldFx = process.env.FXTWITTER_ENABLED, oldVx = process.env.VXTWITTER_ENABLED;
  const dir = await mkdtemp(join(tmpdir(), 'twitter-env-'));
  try {
    process.env.FXTWITTER_ENABLED = 'false'; process.env.VXTWITTER_ENABLED = 'true';
    await downloadTwitter(url, dir, io(async target => {
      assert.notEqual(target.hostname, 'api.fxtwitter.com'); return reply(target.hostname === 'api.vxtwitter.com' ? JSON.stringify(vx) : fixture);
    }));
    process.env.VXTWITTER_ENABLED = 'false';
    await assert.rejects(withVideo(url, async () => assert.fail(), async () => { throw new Error('failed'); }, { twitterFallback: async () => assert.fail('desativado'), fallback: async () => { throw new Error('failed'); } }));
  } finally {
    if (oldFx === undefined) delete process.env.FXTWITTER_ENABLED; else process.env.FXTWITTER_ENABLED = oldFx;
    if (oldVx === undefined) delete process.env.VXTWITTER_ENABLED; else process.env.VXTWITTER_ENABLED = oldVx;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Fx: ordena e deduplica qualidades do mesmo vídeo antes de tentar a maior que cabe', async () => {
  const qualities = ['1080x1920', '720x1280', '480x852', '320x568'].map(size => `https://video.twimg.com/ext_tw_video/example/vid/avc1/${size}/sample.mp4`);
  const payload = { code: 200, status: { id, media: { videos: [{ url: qualities[0], formats: [
    { url: qualities[3] }, { url: qualities[1] }, { url: qualities[0] }, { url: qualities[2] },
  ] }, { url: 'https://video.twimg.com/other/vid/1920x1080/other.mp4' }] } } };
  assert.deepEqual(twitterMedia(payload, 'fx', id), qualities);
  const dir = await mkdtemp(join(tmpdir(), 'twitter-quality-')); const tried: string[] = []; let largeClosed = false, largeRead = false;
  try {
    await downloadTwitter(url, dir, io(async target => {
      if (target.hostname === 'api.fxtwitter.com') return reply(JSON.stringify(payload));
      assert.equal(target.hostname, 'video.twimg.com', 'não deve consultar Vx após sucesso do Fx');
      tried.push(target.href);
      if (target.href === qualities[0]) return {
        status: 200, headers: { 'content-length': '24764132' },
        body: (async function* () { largeRead = true; yield fixture; })(), close: () => { largeClosed = true; },
      };
      assert.equal(largeClosed, true); return reply(fixture);
    }));
    assert.deepEqual(tried, qualities.slice(0, 2)); assert.equal(largeRead, false);
    assert.deepEqual(await readFile(join(dir, 'video.mp4')), fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Fx: sem tamanho anunciado, interrompe corpo excessivo e recupera com qualidade menor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twitter-stream-limit-')); let closed = false, calls = 0;
  const smaller = media.replace('640x360', '320x180');
  const payload = { code: 200, status: { id, media: { videos: [{ url: media, formats: [{ url: smaller }] }] } } };
  try {
    await downloadTwitter(url, dir, io(async target => {
      if (target.hostname === 'api.fxtwitter.com') return reply(JSON.stringify(payload));
      calls++;
      if (target.href === media) return {
        status: 200, headers: {}, close: () => { closed = true; },
        body: (async function* () { yield Buffer.alloc(16 * 1024 * 1024); yield Buffer.from('excess'); assert.fail('deve parar antes de continuar lendo'); })(),
      };
      assert.equal(closed, true); assert.equal(target.href, smaller); return reply(fixture);
    }));
    assert.equal(calls, 2); assert.deepEqual(await readFile(join(dir, 'video.mp4')), fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Fx: todas as qualidades acima do limite tentam Vx uma vez, sem gravar arquivo grande', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twitter-all-large-')); let vxCalls = 0;
  try {
    await assert.rejects(downloadTwitter(url, dir, io(async target => {
      if (target.hostname === 'api.fxtwitter.com') return reply(JSON.stringify({ code: 200, status: { id, media: { videos: [{ url: media, formats: [{ url: media.replace('640x360', '320x180') }] }] } } }));
      if (target.hostname === 'api.vxtwitter.com') { vxCalls++; return reply(JSON.stringify(vx)); }
      return reply('unused', 200, { 'content-length': '16777217' });
    })));
    assert.equal(vxCalls, 1); await assert.rejects(access(join(dir, 'video.mp4')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
