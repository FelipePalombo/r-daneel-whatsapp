import { downloadCobalt } from './cobalt.js';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
export const DIRECT_VIDEO_TIMEOUT_MS = 110_000;
export const VIDEO_RATE_LIMIT_PAUSE_MS = 8000;
export class VideoRateLimitError extends Error {}

/** Classifica somente evidência explícita de limite; login isolado não prova rate limit. */
export function videoDownloadFailure(detail: string, killed = false): Error {
  if (/rate[- _]?limit|too many requests|HTTP(?: Error)?[ :]+429|status(?: code)?[ :]+429/i.test(detail))
    return new VideoRateLimitError('A plataforma limitou temporariamente o acesso anônimo do servidor.');
  return new Error(/login|log in|content is not available/i.test(detail) ? 'A plataforma exige login ou o vídeo está indisponível.'
    : /format.*not available/i.test(detail) ? 'Formato de vídeo compatível indisponível.'
    : killed ? 'Download excedeu o tempo ou tamanho permitido.' : 'Falha de rede ou do extrator de vídeo.');
}
export function videoFailureReply(error: unknown, url: string): string {
  if (error instanceof VideoRateLimitError) {
    const platform = url.includes('instagram.com/') ? 'O Instagram' : 'O Twitter/X';
    return `${platform} limitou temporariamente o acesso do servidor. Não consegui contornar esse bloqueio agora. Aguarde e tente novamente mais tarde; reenviar imediatamente pode falhar de novo.`;
  }
  return 'Não consegui baixar esse vídeo. Precisa ser uma publicação pública com vídeo de até 3 minutos e 16 MB. O Instagram ou X também pode exigir login ou bloquear o download temporariamente.';
}


/** Aceita apenas links diretos de publicações; nunca executa texto como comando. */
export function videoUrl(text: string): string | undefined {
  const value = text.trim().replace(/^!video\s+/i, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    if (['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname)) {
      const post = /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})\/?$/.exec(url.pathname);
      if (!post) return;
      const kind = post[1] === 'reels' ? 'reel' : post[1];
      return `https://www.instagram.com/${kind}/${post[2]}/`;
    }
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname)) return;
    const match = /^\/(?:[a-zA-Z0-9_]{1,15}|i\/web)\/status\/(\d{1,25})(?:\/video\/\d+)?\/?$/.exec(url.pathname);
    if (!match) return;
    return `https://x.com/i/web/status/${match[1]}`;
  } catch { return; }
}

export type VideoRunner = (args: string[], directory: string, timeoutMs?: number) => Promise<void>;
export type VideoRetryOptions = {
  onRetry?: () => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  fallback?: typeof downloadCobalt;
};

const download: VideoRunner = (args, directory, timeoutMs = DIRECT_VIDEO_TIMEOUT_MS) => new Promise((resolve, reject) => {
  // Seleciona MP4 com áudio e vídeo juntos: não cria processos de merge/transcoding.
  const child = execFile(process.env.YT_DLP_PATH ?? (existsSync('.tools/yt-dlp-current/bin/yt-dlp') ? resolvePath('.tools/yt-dlp-current/bin/yt-dlp') : existsSync('.tools/yt-dlp/bin/yt-dlp') ? resolvePath('.tools/yt-dlp/bin/yt-dlp') : 'yt-dlp'), args, {
    cwd: directory, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
  }, (error, stdout, stderr) => {
    clearInterval(watch);
    if (!error) { resolve(); return; }
    const detail = `${stdout} ${stderr}`;
    reject(videoDownloadFailure(detail, !!error.killed));
  });
  // Também limita downloads cujo tamanho não foi anunciado pelo servidor.
  const watch = setInterval(() => {
    void Promise.all(['video.mp4', 'video.mp4.part'].map(name => stat(join(directory, name)).catch(() => undefined)))
      .then(files => { if (files.some(file => file && file.size > MAX_VIDEO_BYTES)) child.kill('SIGKILL'); });
  }, 200);
});

/** O arquivo existe somente durante o callback de envio, inclusive em caso de erro. */
export async function withVideo(url: string, send: (path: string) => Promise<void>, run: VideoRunner = download, options: VideoRetryOptions = {}): Promise<void> {
  const canonical = videoUrl(url);
  if (!canonical) throw new Error('Link inválido.');
  const directory = await mkdtemp(join(tmpdir(), 'r-daneel-video-'));
  const now = options.now ?? Date.now;
  const deadline = now() + DIRECT_VIDEO_TIMEOUT_MS;
  let rateLimit: VideoRateLimitError | undefined;
  const attempt = async () => {
    const remaining = deadline - now();
    if (remaining <= 0) throw rateLimit ?? new Error('Download excedeu o tempo permitido.');
    await run([
      '--ignore-config', '--no-cache-dir', '--no-playlist', '--playlist-items', '1',
      '--no-progress', '--no-warnings', '--socket-timeout', '15', '--retries', '1',
      '--match-filter', 'duration <=? 180 & !is_live',
      '--max-filesize', String(MAX_VIDEO_BYTES),
      '-f', 'best[ext=mp4][protocol=https][filesize<=?16777216]/best[ext=mp4][protocol=http][filesize<=?16777216]',
      '-o', 'video.mp4', '--', canonical,
    ], directory, remaining);
    const downloaded = await stat(join(directory, 'video.mp4')).catch(() => undefined);
    if (!downloaded?.size) throw new Error('Nenhum vídeo compatível foi baixado (limite, formato ou acesso).');
  };
  try {
    try {
      try { await attempt(); }
      catch (error) {
        if (!(error instanceof VideoRateLimitError)) throw error;
        rateLimit = error;
        // Uma só retentativa, dentro do orçamento original de 110s do download direto.
        if (deadline - now() < VIDEO_RATE_LIMIT_PAUSE_MS + 5000) throw error;
        await options.onRetry?.().catch(() => {});
        if (deadline - now() < VIDEO_RATE_LIMIT_PAUSE_MS + 5000) throw error;
        await (options.wait ?? (ms => sleep(ms)))(VIDEO_RATE_LIMIT_PAUSE_MS);
        await Promise.all(['video.mp4', 'video.mp4.part', 'video.mp4.ytdl'].map(name => rm(join(directory, name), { force: true })));
        await attempt();
      }
    } catch (error) {
      const endpoint = process.env.COBALT_API_URL;
      if (!endpoint) throw rateLimit ?? error;
      console.log('Download direto falhou; tentando Cobalt local.');
      await rm(join(directory, 'video.mp4'), { force: true });
      try { await (options.fallback ?? downloadCobalt)(canonical, directory, endpoint); }
      catch {
        if (error instanceof VideoRateLimitError || rateLimit) throw error instanceof VideoRateLimitError ? error : rateLimit;
        throw new Error(`${error instanceof Error ? error.message : 'Download direto falhou.'} Cobalt também não conseguiu baixar o vídeo.`);
      }
    }
    const path = join(directory, 'video.mp4');
    const file = await stat(path);
    if (!file.isFile() || file.size === 0 || file.size > MAX_VIDEO_BYTES) throw new Error('Vídeo fora do limite.');
    if (run === download) {
      await new Promise<void>((resolve, reject) => {
        execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path],
          { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, output) => {
            if (error) { reject(new Error('Não consegui validar o vídeo com ffprobe.')); return; }
            try {
              const info = JSON.parse(output);
              const duration = Number(info.format?.duration);
              if (!(duration > 0 && duration <= 180) || !info.streams?.some((stream: { codec_type: string }) => stream.codec_type === 'video')) throw new Error();
              resolve();
            } catch { reject(new Error('Arquivo inválido ou vídeo acima de 3 minutos.')); }
          });
      });
    }
    await send(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
