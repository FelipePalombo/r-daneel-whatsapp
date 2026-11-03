import { execFile } from 'node:child_process';
import { stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { youtubeShortId } from './youtube-download.js';

const MAX_BYTES = 16 * 1024 * 1024;
export class YoutubeSizeError extends Error {}
export type YoutubeRunner = (args: string[], directory: string, timeoutMs: number) => Promise<string>;
type Format = { format_id: string; ext: string; protocol: string; vcodec?: string; acodec?: string; width?: number; height?: number; fps?: number; abr?: number; tbr?: number; filesize?: number; filesize_approx?: number };
export type YoutubeChoice = { video: string; audio?: string };
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const bytes = (f: Format): number => number(f.filesize) || number(f.filesize_approx);
const formatId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value);

/** H.264/AAC, maior resolução até 720p; tamanho exato tem precedência sobre estimativa. */
export function youtubeChoices(data: unknown, id: string): YoutubeChoice[] {
  const info = data as { id?: unknown; is_live?: unknown; duration?: unknown; formats?: unknown } | null;
  if (!info || info.id !== id || info.is_live === true || number(info.duration) > 180 || !Array.isArray(info.formats)) throw new Error('Short indisponível ou acima de 3 minutos.');
  const formats = info.formats.filter((value): value is Format => value && typeof value === 'object' && formatId(value.format_id) && value.protocol === 'https');
  const audio = formats.filter(f => f.ext === 'm4a' && f.vcodec === 'none' && /^mp4a/.test(f.acodec ?? ''))
    .sort((a, b) => number(b.abr) - number(a.abr));
  const choices: { choice: YoutubeChoice; pixels: number; fps: number; bitrate: number; audioRate: number }[] = [];
  for (const video of formats) {
    const width = number(video.width), height = number(video.height);
    if (video.ext !== 'mp4' || !/^avc1/.test(video.vcodec ?? '') || !width || !height || Math.min(width, height) > 720 || Math.max(width, height) > 1280) continue;
    const tracks = /^mp4a/.test(video.acodec ?? '') ? [undefined] : video.acodec === 'none' ? audio : [];
    for (const track of tracks) {
      const estimate = bytes(video), audioEstimate = track ? bytes(track) : 0;
      // Reservar espaço para o container; tamanhos desconhecidos continuam sujeitos ao limite real.
      if (estimate + audioEstimate > MAX_BYTES - 128 * 1024) continue;
      choices.push({ choice: { video: video.format_id, ...(track ? { audio: track.format_id } : {}) }, pixels: width * height, fps: number(video.fps), bitrate: number(video.tbr), audioRate: track ? number(track.abr) : number(video.abr) });
    }
  }
  choices.sort((a, b) => b.pixels - a.pixels || b.fps - a.fps || b.bitrate - a.bitrate || b.audioRate - a.audioRate);
  const unique = new Map<string, YoutubeChoice>();
  for (const item of choices) unique.set(`${item.choice.video}+${item.choice.audio ?? ''}`, item.choice);
  if (!unique.size) throw new Error('Nenhuma qualidade H.264/AAC cabe no limite do Short.');
  return [...unique.values()].slice(0, 8);
}

const names = ['video.mp4', 'video-track.mp4', 'audio-track.m4a'] as const;
async function size(path: string): Promise<number> { return (await stat(path).catch(() => undefined))?.size ?? 0; }
/** Não soma o arquivo final aos componentes durante o remux; cada grupo tem limite próprio. */
export async function youtubeMediaUsage(directory: string): Promise<{ tracks: number; output: number }> {
  const measured = await Promise.all(names.map(async name => Math.max(await size(join(directory, name)), await size(join(directory, `${name}.part`)))));
  return { output: measured[0]!, tracks: measured[1]! + measured[2]! };
}
async function clearMedia(directory: string): Promise<void> {
  await Promise.all(names.flatMap(name => ['', '.part', '.ytdl'].map(suffix => rm(join(directory, name + suffix), { force: true }))));
}
export type YoutubeMerge = (directory: string, timeoutMs: number) => Promise<void>;
const merge: YoutubeMerge = (directory, timeoutMs) => new Promise((resolve, reject) => {
  let oversized = false, stopped = false;
  const child = execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
    '-protocol_whitelist', 'file,pipe', '-i', 'video-track.mp4', '-protocol_whitelist', 'file,pipe', '-i', 'audio-track.m4a',
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-map_metadata', '-1', '-movflags', '+faststart', 'video.mp4'],
  { cwd: directory, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, error => {
    stopped = true; clearInterval(watch);
    if (oversized) reject(new YoutubeSizeError('MP4 do Short acima de 16 MiB.'));
    else if (error) reject(new Error('Não consegui juntar áudio e vídeo do Short.'));
    else resolve();
  });
  const watch = setInterval(() => { void size(join(directory, 'video.mp4')).then(bytes => {
    if (!stopped && bytes > MAX_BYTES) { oversized = true; child.kill('SIGKILL'); }
  }); }, 100);
});

/** Metadados únicos e faixas limitadas; remux local sem recodificar ou iniciar WhatsApp. */
export async function downloadYoutubeDirect(url: string, directory: string, timeoutMs: number, run: YoutubeRunner, mux: YoutubeMerge = merge): Promise<void> {
  const id = youtubeShortId(url);
  if (!id) throw new Error('Link de Short inválido.');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw new Error('Download do Short excedeu o tempo permitido.'); return ms; };
  const common = ['--ignore-config', '--no-cache-dir', '--no-playlist', '--playlist-items', '1', '--no-progress', '--no-warnings', '--js-runtimes', 'node', '--fixup', 'never', '--socket-timeout', '15', '--retries', '1'];
  const raw = await run([...common, '--skip-download', '--dump-single-json', '--', url], directory, remaining());
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Metadados do Short acima do limite.');
  let metadata: unknown;
  try { metadata = JSON.parse(raw); } catch { throw new Error('Metadados inválidos do Short.'); }
  const choices = youtubeChoices(metadata, id);
  const infoPath = join(directory, 'youtube-info.json');
  await writeFile(infoPath, raw, { mode: 0o600 });
  const track = async (format: string, name: string) => {
    await run([...common, '--load-info-json', 'youtube-info.json', '--max-filesize', String(MAX_BYTES), '-f', format, '-o', name], directory, remaining());
    const file = await size(join(directory, name));
    const usage = await youtubeMediaUsage(directory);
    if (!file || usage.tracks > MAX_BYTES || usage.output > MAX_BYTES) throw new YoutubeSizeError('Faixas do Short acima de 16 MiB.');
  };
  let completed = false;
  try {
    for (const choice of choices) {
      await clearMedia(directory);
      try {
        if (choice.audio) {
          await track(choice.video, 'video-track.mp4');
          await track(choice.audio, 'audio-track.m4a');
          await mux(directory, remaining());
        } else await track(choice.video, 'video.mp4');
        const finalSize = await size(join(directory, 'video.mp4'));
        if (!finalSize || finalSize > MAX_BYTES) throw new YoutubeSizeError('MP4 do Short acima de 16 MiB.');
        completed = true;
        return;
      } catch (error) {
        if (!(error instanceof YoutubeSizeError)) throw error;
      }
    }
    throw new YoutubeSizeError('As qualidades disponíveis do Short ultrapassam 16 MiB.');
  } finally {
    if (!completed) await clearMedia(directory);
    await rm(infoPath, { force: true });
    await Promise.all(['video-track.mp4', 'audio-track.m4a'].flatMap(name => ['', '.part', '.ytdl'].map(suffix => rm(join(directory, name + suffix), { force: true }))));
  }
}
