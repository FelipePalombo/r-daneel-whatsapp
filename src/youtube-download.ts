import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicHttp, type PublicHttp } from './public-http.js';

const API_HOST = 'rue-cobalt.xenon.zone';
export const YOUTUBE_FALLBACK_TIMEOUT_MS = 60_000;
export function youtubeShortId(value: string): string | undefined {
  return /^https:\/\/www\.youtube\.com\/shorts\/([A-Za-z0-9_-]{11})$/.exec(value)?.[1];
}
/** Instância comunitária explicitamente selecionada; sem descoberta automática ou login. */
export async function downloadYoutube(url: string, directory: string, io?: PublicHttp): Promise<void> {
  if (!youtubeShortId(url)) throw new Error('Link de Short inválido.');
  const signal = AbortSignal.timeout(YOUTUBE_FALLBACK_TIMEOUT_MS);
  const body = JSON.stringify({ url, videoQuality: '720', youtubeVideoCodec: 'h264', localProcessing: 'disabled', alwaysProxy: true });
  const response = await publicHttp(`https://${API_HOST}/`, {
    signal, limit: 1024 * 1024, allowedHost: host => host === API_HOST, method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'User-Agent': 'R-Daneel/0.1' }, body,
  }, io);
  let data: { status?: string; url?: string };
  try { data = JSON.parse(response.body.toString('utf8')); } catch { throw new Error('Resposta inválida da contingência do YouTube.'); }
  if (!['tunnel', 'redirect'].includes(data?.status ?? '') || typeof data.url !== 'string') throw new Error('A contingência não encontrou um Short público acessível.');
  const media = await publicHttp(data.url, {
    signal, limit: 16 * 1024 * 1024,
    allowedHost: host => host === API_HOST || host.endsWith('.googlevideo.com'),
  }, io);
  if (media.body.length < 12 || media.body.toString('ascii', 4, 8) !== 'ftyp') throw new Error('A contingência não retornou MP4.');
  signal.throwIfAborted();
  await writeFile(join(directory, 'video.mp4'), media.body, { signal });
}
