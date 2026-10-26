import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadCobalt } from '../src/cobalt.js';
import { withVideo } from '../src/video.js';

test('Cobalt: obtém primeiro vídeo do picker e grava a transferência', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cobalt-test-'));
  let calls = 0;
  try {
    await downloadCobalt('https://www.instagram.com/reel/DejIhofCWYv/', dir, 'http://localhost:9000/', (async (_, options) => {
      calls++;
      if (calls === 1) {
        assert.equal(options?.method, 'POST');
        return Response.json({ status: 'picker', picker: [{ type: 'photo', url: 'https://example.com/photo' }, { type: 'video', url: 'https://example.com/video' }] });
      }
      return new Response('video');
    }) as typeof fetch);
    assert.equal((await readFile(join(dir, 'video.mp4'))).toString(), 'video');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Cobalt: recusa resposta de erro, download grande e URL inválida', async () => {
  for (const response of [{status:'error'}, {status:'redirect',url:'file:///etc/passwd'}]) {
    await assert.rejects(downloadCobalt('https://x.com/i/web/status/123', tmpdir(), 'http://localhost:9000/', (async () => Response.json(response)) as typeof fetch));
  }
  let calls = 0;
  await assert.rejects(downloadCobalt('https://x.com/i/web/status/123', tmpdir(), 'http://localhost:9000/', (async () => ++calls === 1
    ? Response.json({status:'redirect',url:'https://example.com/video'}) : new Response(new Uint8Array(16 * 1024 * 1024 + 1))) as typeof fetch));
});

test('falha no envio não aciona novo download nem Cobalt', async () => {
  const {writeFile} = await import('node:fs/promises');
  let calls = 0;
  await assert.rejects(withVideo('https://x.com/i/web/status/123', async () => { throw new Error('envio falhou'); }, async (_, dir) => {
    calls++; await writeFile(join(dir,'video.mp4'),'fixture');
  }), /envio falhou/);
  assert.equal(calls, 1);
});
