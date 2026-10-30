import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicHttp, type PublicHttp } from './public-http.js';

const HOME = 'https://snapinsta.ai/';
const MAX_TEXT = 1024 * 1024;
export const EXTERNAL_VIDEO_TIMEOUT_MS = 60_000;
const headers = { 'User-Agent': 'Mozilla/5.0', Referer: HOME };
const entities = (value: string) => value.replace(/&(amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (_, name: string) => {
  if (name[0] === '#') { const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }
  return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[name.toLowerCase()]!;
});
function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s<>]+))/g)) result[match[1]!.toLowerCase()] = entities(match[2] ?? match[3] ?? match[4] ?? '');
  return result;
}
export function snapinstaForm(html: string, url: string): string {
  if (html.length > MAX_TEXT) throw new Error('Formulário externo inválido.');
  const form = new URLSearchParams();
  for (const tag of html.match(/<input\b[^>]{0,8192}>/gi) ?? []) {
    const attrs = attributes(tag);
    if (['action', 'lang', 'token'].includes(attrs.name ?? '')) form.set(attrs.name!, attrs.value ?? '');
  }
  if (!form.get('token')) throw new Error('Formulário externo indisponível.');
  form.set('url', url); return form.toString();
}

/** Decodifica apenas o envelope de dados observado; nunca interpreta código recebido. */
export function snapinstaMedia(response: string): string {
  if (response.length > MAX_TEXT) throw new Error('Resposta externa inválida.');
  const envelope = /\}\("([^"\\]+)",(\d+),"([^"\\]+)",(\d+),(\d+),(\d+)\)\)/.exec(response);
  if (!envelope) throw new Error('Serviço externo mudou a resposta ou exige verificação.');
  const alphabet = envelope[3]!, base = Number(envelope[5]), offset = Number(envelope[4]);
  if (base < 2 || base > 10 || alphabet.length > 64 || alphabet.length <= base || new Set(alphabet).size !== alphabet.length || !Number.isSafeInteger(offset)) throw new Error('Envelope externo inválido.');
  let decoded = '';
  for (const part of envelope[1]!.split(alphabet[base]!)) {
    if (!part) continue;
    if (part.length > 32) throw new Error('Envelope externo inválido.');
    let code = 0;
    for (const char of part) {
      const digit = alphabet.indexOf(char);
      if (digit < 0 || digit >= base) throw new Error('Envelope externo inválido.');
      code = code * base + digit;
    }
    code -= offset;
    if (!Number.isSafeInteger(code) || code < 0 || code > 65535) throw new Error('Envelope externo inválido.');
    decoded += String.fromCharCode(code);
  }
  const literal = /document\.getElementById\(["']download["']\)\.innerHTML\s*=\s*("(?:\\.|[^"\\])*")/.exec(decoded)?.[1];
  if (!literal) throw new Error('Serviço externo não encontrou vídeo.');
  // HTML é uma string JS entre aspas duplas: aceitar somente escapes de dados conhecidos.
  const html: string = JSON.parse(literal.replace(/\\'/g, "'").replace(/\\x([\da-f]{2})/gi, '\\u00$1'));
  for (const tag of html.match(/<a\b[^>]{0,16384}>/gi) ?? []) {
    const href = attributes(tag).href;
    if (!href) continue;
    try {
      const url = new URL(href);
      if (url.protocol === 'https:' && url.hostname === 'd.rapidcdn.app' && !url.username && !url.password && !url.port && !url.hash && !url.pathname.startsWith('/thumb')) return url.href;
    } catch { /* Não é um destino de vídeo reconhecido. */ }
  }
  throw new Error('Serviço externo não encontrou vídeo.');
}

export async function downloadSnapinsta(url: string, directory: string, io?: PublicHttp): Promise<void> {
  if (!/^https:\/\/www\.instagram\.com\/(?:p|reel|tv)\/[\w-]+\/$/.test(url)) throw new Error('Link incompatível com a contingência.');
  const signal = AbortSignal.timeout(EXTERNAL_VIDEO_TIMEOUT_MS);
  const pageOptions = { signal, limit: MAX_TEXT, allowedHost: (host: string) => host === 'snapinsta.ai' };
  const home = await publicHttp(HOME, { ...pageOptions, headers }, io);
  const cookies = home.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies : cookies ? [cookies] : []).map(item => item.split(';')[0]).join('; ');
  const result = await publicHttp(`${HOME}action2.php`, { ...pageOptions, method: 'POST',
    headers: { ...headers, Origin: HOME.slice(0, -1), 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: snapinstaForm(home.body.toString('utf8'), url) }, io);
  const media = snapinstaMedia(result.body.toString('utf8'));
  const video = await publicHttp(media, { signal, limit: 16 * 1024 * 1024, allowedHost: host => host === 'd.rapidcdn.app', headers }, io);
  if (video.body.length < 12 || video.body.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Serviço externo não retornou MP4.');
  signal.throwIfAborted();
  await writeFile(join(directory, 'video.mp4'), video.body, { signal });
}
