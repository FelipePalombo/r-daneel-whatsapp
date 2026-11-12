import { downloadCobalt } from './cobalt.js';
import { downloadSnapinsta, InstagramPhotoAvailable } from './snapinsta.js';
import { downloadTwitter } from './twitter-download.js';
import { downloadYoutube } from './youtube-download.js';
import { downloadYoutubeDirect, youtubeMediaUsage, YoutubeSizeError, type YoutubeRunner } from './youtube-direct.js';
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
    const platform = videoPlatformName(url);
    return `${platform} limitou temporariamente o acesso do servidor. Não consegui contornar esse bloqueio agora. Aguarde e tente novamente mais tarde; reenviar imediatamente pode falhar de novo.`;
  }
  return `Não consegui baixar esse vídeo. Precisa ser uma publicação pública com vídeo de até 3 minutos e 16 MiB. ${videoPlatformName(url)} pode exigir login ou bloquear o download temporariamente; as tentativas disponíveis não conseguiram concluir.`;
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
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      const short = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
      if (!short || url.hash) return;
      return `https://www.youtube.com/shorts/${short[1]}`;
    }
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname)) return;
    const match = /^\/(?:[a-zA-Z0-9_]{1,15}|i\/web)\/status\/(\d{1,25})(?:\/video\/\d+)?\/?$/.exec(url.pathname);
    if (!match) return;
    return `https://x.com/i/web/status/${match[1]}`;
  } catch { return; }
}

export type VideoPlatform = 'instagram' | 'twitter' | 'youtube';
export function videoPlatform(value: string): VideoPlatform | undefined {
  const url = videoUrl(value);
  if (!url) return;
  const host = new URL(url).hostname;
  return host === 'www.instagram.com' ? 'instagram' : host === 'www.youtube.com' ? 'youtube' : 'twitter';
}
export function videoPlatformName(value: string): string {
  const platform = videoPlatform(value);
  return platform === 'instagram' ? 'O Instagram' : platform === 'youtube' ? 'O YouTube' : platform === 'twitter' ? 'O Twitter/X' : 'A plataforma';
}

export type VideoRunner = (args: string[], directory: string, timeoutMs?: number) => Promise<void>;
export type VideoRetryOptions = {
  onRetry?: () => Promise<void>;
  onExternalFallback?: () => Promise<void>;
  externalFallback?: typeof downloadSnapinsta;
  twitterFallback?: typeof downloadTwitter;
  youtubeFallback?: typeof downloadYoutube;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  fallback?: typeof downloadCobalt;
};

const executeYtDlp: YoutubeRunner = (args, directory, timeoutMs) => new Promise((resolve, reject) => {
  const youtubeTracks = args.includes('--load-info-json');
  let sizeExceeded = false, stopped = false, checking = false;
  const child = execFile(process.env.YT_DLP_PATH ?? (existsSync('.tools/yt-dlp-current/bin/yt-dlp') ? resolvePath('.tools/yt-dlp-current/bin/yt-dlp') : existsSync('.tools/yt-dlp/bin/yt-dlp') ? resolvePath('.tools/yt-dlp/bin/yt-dlp') : 'yt-dlp'), args, {
    cwd: directory, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => {
    stopped = true; clearInterval(watch);
    if (youtubeTracks && sizeExceeded) { reject(new YoutubeSizeError('Faixas do Short acima de 16 MiB.')); return; }
    if (!error) { resolve(stdout); return; }
    const detail = `${stdout} ${stderr}`;
    reject(videoDownloadFailure(detail, !!error.killed));
  });
  // Inclui a soma real das faixas de Shorts, inclusive arquivos .part.
  const watch = setInterval(() => {
    if (checking || stopped) return;
    checking = true;
    void (async () => {
      if (youtubeTracks) {
        const usage = await youtubeMediaUsage(directory);
        sizeExceeded = usage.tracks > MAX_VIDEO_BYTES || usage.output > MAX_VIDEO_BYTES;
      } else {
        const files = await Promise.all(['video.mp4', 'video.mp4.part'].map(name => stat(join(directory, name)).catch(() => undefined)));
        sizeExceeded = files.some(file => file && file.size > MAX_VIDEO_BYTES);
      }
      if (sizeExceeded && !stopped) child.kill('SIGKILL');
    })().finally(() => { checking = false; });
  }, 200);
});
const download: VideoRunner = async (args, directory, timeoutMs = DIRECT_VIDEO_TIMEOUT_MS) => {
  const canonical = args.at(-1)!;
  if (videoPlatform(canonical) === 'youtube') await downloadYoutubeDirect(canonical, directory, timeoutMs, executeYtDlp);
  else await executeYtDlp(args, directory, timeoutMs);
};

/** O arquivo existe somente durante o callback de envio, inclusive em caso de erro. */
export async function withVideo(url: string, send: (path: string) => Promise<void>, run: VideoRunner = download, options: VideoRetryOptions = {}): Promise<void> {
  const canonical = videoUrl(url);
  if (!canonical) throw new Error('Link inválido.');
  const platform = videoPlatform(canonical)!;
  const directory = await mkdtemp(join(tmpdir(), 'r-daneel-video-'));
  const now = options.now ?? Date.now;
  const deadline = now() + DIRECT_VIDEO_TIMEOUT_MS;
  let rateLimit: VideoRateLimitError | undefined;
  const attempt = async () => {
    const remaining = deadline - now();
    if (remaining <= 0) throw rateLimit ?? new Error('Download excedeu o tempo permitido.');
    await run(platform === 'youtube' ? ['--js-runtimes', 'node', '--', canonical] : [
      '--ignore-config', '--no-cache-dir', '--no-playlist', '--playlist-items', '1',
      '--no-progress', '--no-warnings', '--socket-timeout', '15', '--retries', '1',
      '--match-filter', 'duration <=? 180 & !is_live',
      '--max-filesize', String(MAX_VIDEO_BYTES),
      // Estimativa evita escolher HD sabidamente grande quando filesize não é informado.
      '-f', 'best[ext=mp4][protocol=https][filesize<=?16777216][filesize_approx<=?16777216]/best[ext=mp4][protocol=http][filesize<=?16777216][filesize_approx<=?16777216]',
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
      let recovered = false;
      if (endpoint) {
        console.log('Download direto falhou; tentando Cobalt local.');
        await rm(join(directory, 'video.mp4'), { force: true });
        try { await (options.fallback ?? downloadCobalt)(canonical, directory, endpoint); recovered = true; }
        catch { /* A próxima contingência pode recuperar a falha de extração. */ }
      }
      const enabled = platform === 'instagram' ? process.env.SNAPINSTA_ENABLED !== 'false'
        : platform === 'youtube' ? process.env.YOUTUBE_FALLBACK_ENABLED !== 'false'
        : process.env.FXTWITTER_ENABLED !== 'false' || process.env.VXTWITTER_ENABLED !== 'false';
      const external = platform === 'instagram'
        ? options.externalFallback ?? (run === download ? downloadSnapinsta : undefined)
        : platform === 'youtube'
          ? options.youtubeFallback ?? (run === download ? downloadYoutube : undefined)
          : options.twitterFallback ?? (run === download ? downloadTwitter : undefined);
      if (!recovered && enabled && external) {
        await options.onExternalFallback?.().catch(() => {});
        await Promise.all(['video.mp4', 'video.mp4.part', 'video.mp4.ytdl'].map(name => rm(join(directory, name), { force: true })));
        console.log('Download principal falhou; tentando contingência externa.');
        try { await external(canonical, directory); recovered = true; }
        catch (error) { if (error instanceof InstagramPhotoAvailable && platform === 'instagram') throw error; /* Não registrar resposta, cookies ou URLs do serviço externo. */ }
      }
      if (!recovered) throw rateLimit ?? error;
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
              if (!(duration > 0 && duration <= 180) || !info.streams?.some((stream: { codec_type: string }) => stream.codec_type === 'video') ||
                  (platform === 'youtube' && !info.streams?.some((stream: { codec_type: string }) => stream.codec_type === 'audio'))) throw new Error();
              resolve();
            } catch { reject(new Error('Arquivo inválido, sem áudio exigido ou vídeo acima de 3 minutos.')); }
          });
      });
    }
    await send(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
