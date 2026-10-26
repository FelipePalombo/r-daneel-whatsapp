import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_VIDEO_BYTES } from './video.js';

/** Usa apenas a instância configurada; não consulta APIs públicas de terceiros. */
export async function downloadCobalt(url: string, directory: string, endpoint: string, request: typeof fetch = fetch): Promise<void> {
  const signal = AbortSignal.timeout(60_000);
  const response = await request(endpoint, {
    method: 'POST', signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, videoQuality: '720', localProcessing: 'disabled', alwaysProxy: true }),
  });
  if (!response.ok) throw new Error('Cobalt indisponível.');
  const data = await response.json() as { status?: string; url?: string; picker?: { type?: string; url?: string }[] };
  const media = data.status === 'picker' ? data.picker?.find(item => item.type === 'video')?.url
    : ['tunnel', 'redirect'].includes(data.status ?? '') ? data.url : undefined;
  if (!media) throw new Error('Cobalt não encontrou um vídeo público acessível.');
  const target = new URL(media);
  const api = new URL(endpoint);
  if (target.username || target.password || (target.protocol !== 'https:' && !(target.protocol === 'http:' && target.origin === api.origin))) {
    throw new Error('Cobalt retornou um endereço inválido.');
  }
  const video = await request(target, { signal });
  if (!video.ok || !video.body) throw new Error('Cobalt não conseguiu transferir o vídeo.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of video.body) {
    size += chunk.length;
    if (size > MAX_VIDEO_BYTES) throw new Error('Vídeo acima de 16 MB.');
    chunks.push(chunk);
  }
  if (!size) throw new Error('Vídeo vazio.');
  await writeFile(join(directory, 'video.mp4'), Buffer.concat(chunks));
}
