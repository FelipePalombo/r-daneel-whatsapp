import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapinstaForm, snapinstaMedia, downloadSnapinsta } from '../src/snapinsta.js';
import { publicHttp, type PublicHttp, type HttpReply } from '../src/public-http.js';
import { withVideo, VideoRateLimitError } from '../src/video.js';
import { sendVideoResponse } from '../src/video-response.js';

const url = 'https://www.instagram.com/reel/Example123/';
const media = 'https://d.rapidcdn.app/download?token=fake&amp;quality=720';
function encoded(html: string): string {
  const code = `document.getElementById("download").innerHTML = ${JSON.stringify(html)};`;
  const alphabet = '0123456789'; const base = 8; const offset = 17;
  const payload = [...code].map(c => (c.charCodeAt(0) + offset).toString(base) + alphabet[base]).join('');
  return `}(${JSON.stringify(payload)},1,"${alphabet}",${offset},${base},1))`;
}
const response = encoded(`<a href="${media}">Download</a>`);
const fixture = Buffer.from('0000ftypisomfixture');
function reply(body: string | Buffer, headers: HttpReply['headers'] = {}, status = 200): HttpReply {
  return { status, headers, body: (async function* () { yield Buffer.from(body); })(), close: () => {} };
}
function network(request: PublicHttp['request']): PublicHttp {
  return { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request };
}

test('Snapinsta: extrai campos atuais e decodifica somente dados, sem executar scripts', () => {
  const form = new URLSearchParams(snapinstaForm(`<input value='fresh&amp;token' name='token'><input name="lang" value="en"><input name="unrelated" value="ignore">`, url));
  assert.equal(form.get('token'), 'fresh&token'); assert.equal(form.get('url'), url); assert.equal(form.has('unrelated'), false);
  assert.equal(snapinstaMedia(response), media.replace('&amp;', '&'));
  assert.equal(snapinstaMedia(response + '; throw new Error("must not execute")'), media.replace('&amp;', '&'));
  for (const html of ['<p>Login required</p>', '<a href="http://d.rapidcdn.app/download">x</a>', '<a href="https://d.rapidcdn.app.evil.test/x">x</a>', '<a href="https://d.rapidcdn.app/thumb?token=fake">x</a>', '<a href="https://user@d.rapidcdn.app/x">x</a>']) assert.throws(() => snapinstaMedia(encoded(html)));
  for (const body of ['captcha required', '<html>error</html>', 'x'.repeat(1024 * 1024 + 1)]) assert.throws(() => snapinstaMedia(body));
  assert.throws(() => snapinstaForm('<form>missing token</form>', url));
});

test('Snapinsta: consulta formulário uma vez, usa cookie público somente no POST e baixa mídia uma vez', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snap-test-')); const calls: string[] = []; let signal: AbortSignal | undefined;
  try {
    await downloadSnapinsta(url, dir, network(async (target, _address, currentSignal, method, headers, body) => {
      if (signal) assert.equal(currentSignal, signal); else signal = currentSignal;
      calls.push(target.hostname + target.pathname);
      if (calls.length === 1) return reply('<input name="token" value="fresh">', { 'set-cookie': ['session=fake; Secure; HttpOnly'] });
      if (calls.length === 2) {
        assert.equal(method, 'POST'); assert.equal(headers.Cookie, 'session=fake');
        assert.equal(new URLSearchParams(body).get('token'), 'fresh'); assert.equal(new URLSearchParams(body).get('url'), url);
        return reply(response);
      }
      assert.equal(headers.Cookie, undefined); return reply(fixture);
    }));
    assert.deepEqual(calls, ['snapinsta.ai/', 'snapinsta.ai/action2.php', 'd.rapidcdn.app/download']);
    assert.deepEqual(await readFile(join(dir, 'video.mp4')), fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTTPS público: bloqueia DNS interno, destinos inválidos e redirects sem consultá-los', async () => {
  const options = { signal: AbortSignal.timeout(1000), limit: 100, allowedHost: () => true };
  let calls = 0;
  for (const target of ['http://example.com/', 'https://user:pass@example.com/', 'https://example.com:8443/']) await assert.rejects(publicHttp(target, options, network(async () => { calls++; return reply('ok'); })));
  for (const address of ['127.0.0.1', '169.254.169.254', '::1', '10.0.0.1']) await assert.rejects(publicHttp('https://example.com/', options, { resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }], request: async () => { calls++; return reply('ok'); } }));
  assert.equal(calls, 0);
  let closed = 0;
  await assert.rejects(publicHttp('https://example.com/', options, network(async () => {
    calls++; return { ...reply('', { location: 'http://127.0.0.1/' }, 302), close: () => { closed++; } };
  })));
  assert.equal(calls, 1); assert.equal(closed, 1);
});

test('HTTPS público: limita corpo real, tamanho anunciado, redirects e tempo incluindo DNS', async () => {
  for (const [body, headers] of [['abcd', {}], ['ok', { 'content-length': '1000' }]] as const) {
    let closed = false;
    await assert.rejects(publicHttp('https://example.com/', { signal: AbortSignal.timeout(1000), limit: 3, allowedHost: () => true }, network(async () => ({ ...reply(body, headers), close: () => { closed = true; } }))));
    assert.equal(closed, true);
  }
  let calls = 0;
  await assert.rejects(publicHttp('https://example.com/', { signal: AbortSignal.timeout(1000), limit: 100, allowedHost: () => true }, network(async () => { calls++; return reply('', { location: '/next' }, 302); })));
  assert.equal(calls, 4);
  const controller = new AbortController();
  const pending = publicHttp('https://example.com/', { signal: controller.signal, limit: 100, allowedHost: () => true }, { resolve: async () => new Promise(() => {}), request: async () => assert.fail() });
  controller.abort(); await assert.rejects(pending, /tempo permitido/);
});

test('Snapinsta: arquivo inválido ou excessivo nunca é gravado', async () => {
  for (const variant of ['html', 'oversized', 'static']) {
    const dir = await mkdtemp(join(tmpdir(), 'snap-fail-')); let calls = 0;
    try {
      await assert.rejects(downloadSnapinsta(url, dir, network(async () => {
        if (++calls === 1) return reply('<input name="token" value="fresh">');
        if (calls === 2) return reply(variant === 'static' ? 'captcha' : response);
        return reply('<html>not mp4</html>', variant === 'oversized' ? { 'content-length': String(16 * 1024 * 1024 + 1) } : {});
      })));
      await assert.rejects(access(join(dir, 'video.mp4')));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('vídeo: Cobalt antes do externo; aviso único, limpeza e envio sem repetição', async () => {
  const previous = process.env.COBALT_API_URL; process.env.COBALT_API_URL = 'http://cobalt.test/';
  const events: string[] = []; let dir = '';
  try {
    await assert.rejects(withVideo(url, async () => { events.push('send'); throw new Error('send failed'); }, async (_, directory) => {
      dir = directory; events.push('direct'); await writeFile(join(dir, 'video.mp4.part'), 'partial'); throw new Error('empty media');
    }, { fallback: async () => { events.push('cobalt'); throw new Error('empty'); }, onExternalFallback: async () => { events.push('notice'); }, externalFallback: async (_, directory) => {
      events.push('external'); await assert.rejects(access(join(directory, 'video.mp4.part'))); await writeFile(join(directory, 'video.mp4'), fixture);
    } }), /send failed/);
    assert.deepEqual(events, ['direct', 'cobalt', 'notice', 'external', 'send']); await assert.rejects(access(dir));
  } finally { if (previous === undefined) delete process.env.COBALT_API_URL; else process.env.COBALT_API_URL = previous; }
});

test('vídeo: contingência externa não roda para X nem quando desativada; preserva rate limit', async () => {
  const previous = process.env.SNAPINSTA_ENABLED; const previousCobalt = process.env.COBALT_API_URL; delete process.env.COBALT_API_URL;
  try {
    for (const [target, enabled] of [['https://x.com/i/web/status/123', 'true'], [url, 'false']]) {
      process.env.SNAPINSTA_ENABLED = enabled;
      await assert.rejects(withVideo(target!, async () => assert.fail(), async () => { throw new Error('empty'); }, { externalFallback: async () => assert.fail('external not expected') }));
    }
    process.env.SNAPINSTA_ENABLED = 'true'; let notices = 0, external = 0;
    await assert.rejects(withVideo(url, async () => assert.fail(), async () => { throw new VideoRateLimitError('limited'); }, { wait: async () => {}, onExternalFallback: async () => { notices++; }, externalFallback: async () => { external++; throw new Error('blocked'); } }), VideoRateLimitError);
    assert.equal(notices, 1); assert.equal(external, 1);
  } finally {
    if (previous === undefined) delete process.env.SNAPINSTA_ENABLED; else process.env.SNAPINSTA_ENABLED = previous;
    if (previousCobalt === undefined) delete process.env.COBALT_API_URL; else process.env.COBALT_API_URL = previousCobalt;
  }
});

test('v e vf avisam antes do externo e preservam ordem de vídeo e figurinha', async () => {
  for (const sticker of [false, true]) {
    const events: string[] = [];
    await sendVideoResponse({ url, sticker }, { text: async text => { assert.match(text, /mais um minuto/); events.push('notice'); }, video: async () => { events.push('video'); }, sticker: async () => { events.push('sticker'); } }, async (_url, send, _run, options) => { await options?.onExternalFallback?.(); await send('/tmp/fixture.mp4'); }, async () => ({ sticker: Buffer.from('webp'), trimmed: false }));
    assert.deepEqual(events, sticker ? ['notice', 'video', 'sticker'] : ['notice', 'video']);
  }
});
