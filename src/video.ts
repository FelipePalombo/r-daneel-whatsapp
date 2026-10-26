import { downloadCobalt } from './cobalt.js';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

export const MAX_VIDEO_BYTES = 16 * 1024 * 1024;

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

export type VideoRunner = (args: string[], directory: string) => Promise<void>;

const download: VideoRunner = (args, directory) => new Promise((resolve, reject) => {
  // Seleciona MP4 com áudio e vídeo juntos: não cria processos de merge/transcoding.
  const child = execFile(process.env.YT_DLP_PATH ?? (existsSync('.tools/yt-dlp-current/bin/yt-dlp') ? resolvePath('.tools/yt-dlp-current/bin/yt-dlp') : existsSync('.tools/yt-dlp/bin/yt-dlp') ? resolvePath('.tools/yt-dlp/bin/yt-dlp') : 'yt-dlp'), args, {
    cwd: directory, timeout: 110_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
  }, (error, stdout, stderr) => {
    clearInterval(watch);
    if (!error) { resolve(); return; }
    const detail = `${stdout} ${stderr}`;
    const reason = /login|log in|rate.limit|content is not available/i.test(detail) ? 'A plataforma exige login, limitou o acesso ou removeu o vídeo.'
      : /format.*not available/i.test(detail) ? 'Formato de vídeo compatível indisponível.'
      : error.killed ? 'Download excedeu o tempo ou tamanho permitido.' : 'Falha de rede ou do extrator de vídeo.';
    reject(new Error(reason));
  });
  // Também limita downloads cujo tamanho não foi anunciado pelo servidor.
  const watch = setInterval(() => {
    void Promise.all(['video.mp4', 'video.mp4.part'].map(name => stat(join(directory, name)).catch(() => undefined)))
      .then(files => { if (files.some(file => file && file.size > MAX_VIDEO_BYTES)) child.kill('SIGKILL'); });
  }, 200);
});

/** O arquivo existe somente durante o callback de envio, inclusive em caso de erro. */
export async function withVideo(url: string, send: (path: string) => Promise<void>, run: VideoRunner = download): Promise<void> {
  const canonical = videoUrl(url);
  if (!canonical) throw new Error('Link inválido.');
  const directory = await mkdtemp(join(tmpdir(), 'r-daneel-video-'));
  try {
    try {
      await run([
        '--ignore-config', '--no-cache-dir', '--no-playlist', '--playlist-items', '1',
        '--no-progress', '--no-warnings', '--socket-timeout', '15', '--retries', '1',
        '--match-filter', 'duration <=? 180 & !is_live',
        '--max-filesize', String(MAX_VIDEO_BYTES),
        '-f', 'best[ext=mp4][protocol=https][filesize<=?16777216]/best[ext=mp4][protocol=http][filesize<=?16777216]',
        '-o', 'video.mp4', '--', canonical,
      ], directory);
      const downloaded = await stat(join(directory, 'video.mp4')).catch(() => undefined);
      if (!downloaded?.size) throw new Error('Nenhum vídeo compatível foi baixado (limite, formato ou acesso).');
    } catch (error) {
      const endpoint = process.env.COBALT_API_URL;
      if (!endpoint) throw error;
      console.log('Download direto falhou; tentando Cobalt local.');
      await rm(join(directory, 'video.mp4'), { force: true });
      try { await downloadCobalt(canonical, directory, endpoint); }
      catch { throw new Error(`${error instanceof Error ? error.message : 'Download direto falhou.'} Cobalt também não conseguiu baixar o vídeo.`); }
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
