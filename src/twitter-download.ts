import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicHttp, HttpBodyTooLargeError, type PublicHttp } from './public-http.js';

export type TwitterProvider = 'fx' | 'vx';
const MAX_BYTES = 16 * 1024 * 1024;
export const TWITTER_FALLBACK_TIMEOUT_MS = 60_000;
const headers = { 'User-Agent': 'R-Daneel/0.1 (+https://github.com/FelipePalombo/r-daneel-whatsapp)', Accept: 'application/json' };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
function mp4(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'video.twimg.com' && !url.username && !url.password && !url.port && !url.hash && url.pathname.endsWith('.mp4') && !url.pathname.includes('/hevc/')) return url.href;
  } catch { /* URL externa inválida. */ }
}

/** Somente o primeiro vídeo do post solicitado, sem herdar mídia de tweets citados. */
export function twitterMedia(data: unknown, provider: TwitterProvider, id: string): string[] {
  const root = object(data);
  let video: Record<string, unknown>;
  if (provider === 'fx') {
    const status = object(root.status);
    if (root.code !== 200 || status.id !== id) throw new Error('FxTwitter não encontrou o post solicitado.');
    video = object(array(object(status.media).videos)[0]);
    if (typeof video.duration === 'number' && video.duration > 180) throw new Error('Vídeo acima de 3 minutos.');
  } else {
    if (root.tweetID !== id) throw new Error('VxTwitter não encontrou o post solicitado.');
    video = object(array(root.media_extended).find(item => ['video', 'gif'].includes(String(object(item).type))));
    if (typeof video.duration_millis === 'number' && video.duration_millis > 180_000) throw new Error('Vídeo acima de 3 minutos.');
  }
  // Formatos permanecem vinculados ao primeiro vídeo, ordenados por resolução.
  const urls = [video.url, ...array(video.formats).map(item => object(item).url)].map(mp4).filter((url): url is string => !!url);
  const pixels = (url: string): number => {
    const dimensions = /\/(\d{1,5})x(\d{1,5})\//.exec(new URL(url).pathname);
    return dimensions ? Number(dimensions[1]) * Number(dimensions[2]) : 0;
  };
  const unique = [...new Set(urls)].sort((a, b) => pixels(b) - pixels(a)).slice(0, 8);
  if (!unique.length) throw new Error('Provedor não encontrou MP4 compatível.');
  return unique;
}

type TwitterOptions = { providers?: TwitterProvider[]; timeoutMs?: number };
/** FxTwitter -> VxTwitter, com no máximo 60s para as duas consultas e transferências. */
export async function downloadTwitter(url: string, directory: string, io?: PublicHttp, options: TwitterOptions = {}): Promise<void> {
  const id = /^https:\/\/x\.com\/i\/web\/status\/(\d{1,25})$/.exec(url)?.[1];
  if (!id) throw new Error('Link incompatível com a contingência do X.');
  const total = Math.min(TWITTER_FALLBACK_TIMEOUT_MS, options.timeoutMs ?? TWITTER_FALLBACK_TIMEOUT_MS);
  if (!(total > 0)) throw new Error('Contingência excedeu o tempo permitido.');
  const signal = AbortSignal.timeout(total);
  const providers = options.providers ?? (['fx', 'vx'] as const).filter(name => process.env[name === 'fx' ? 'FXTWITTER_ENABLED' : 'VXTWITTER_ENABLED'] !== 'false');
  for (const [index, provider] of providers.entries()) {
    signal.throwIfAborted();
    // Reserva tempo para o segundo serviço se o primeiro ficar indisponível.
    const attemptSignal = index < providers.length - 1 ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(30_000, Math.ceil(total / 2)))]) : signal;
    const host = provider === 'fx' ? 'api.fxtwitter.com' : 'api.vxtwitter.com';
    const endpoint = provider === 'fx' ? `https://${host}/2/status/${id}` : `https://${host}/i/status/${id}`;
    try {
      const response = await publicHttp(endpoint, { signal: attemptSignal, limit: 1024 * 1024, allowedHost: name => name === host, headers }, io);
      const media = twitterMedia(JSON.parse(response.body.toString('utf8')), provider, id);
      for (const target of media) {
        try {
          const video = await publicHttp(target, { signal: attemptSignal, limit: MAX_BYTES, allowedHost: name => name === 'video.twimg.com', headers }, io);
          if (video.body.length < 12 || video.body.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Provedor não retornou MP4.');
          attemptSignal.throwIfAborted();
          await writeFile(join(directory, 'video.mp4'), video.body, { signal: attemptSignal });
          return;
        } catch (error) {
          // Fechar o corpo grande e tentar a próxima qualidade dentro do mesmo orçamento.
          if (!(error instanceof HttpBodyTooLargeError)) throw error;
        }
      }
    } catch { /* Próximo provedor, sem registrar conteúdo ou URLs retornadas. */ }
  }
  throw new Error('Contingências do X não conseguiram baixar o vídeo.');
}
