import { directAnimationUrl } from './gif-download.js';
import { videoUrl } from './video.js';
import type { StickerProfile } from './animated-sticker.js';
import type { WAMessage } from '@whiskeysockets/baileys';

/** WhatsApp pode representar celulares brasileiros pelo número anterior ao nono dígito. */
function authorizedPhoneJid(jid: string, phone: string): boolean {
  if (jid === `${phone}@s.whatsapp.net`) return true;
  // Remove somente o 9 inicial de um celular brasileiro completo, preservando país e DDD.
  if (/^55[1-9]\d9[6-9]\d{7}$/.test(phone)) {
    const legacy = phone.slice(0, 4) + phone.slice(5);
    return jid === `${legacy}@s.whatsapp.net`;
  }
  return false;
}

/** Mesma autorização para pedidos individuais e membros de álbuns. */
export function authorizationStatus(m: WAMessage, allowedPhone: string | readonly string[]): string | undefined {
  const jid = m.key.remoteJid ?? '';
  if (m.key.fromMe) return 'mensagem própria';
  if (!m.key.id || (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid'))) return 'conversa não permitida';
  const phoneJid = jid.endsWith('@s.whatsapp.net') ? jid : m.key.remoteJidAlt;
  if (!phoneJid) return 'identificador interno sem número associado';
  if (!(typeof allowedPhone === 'string' ? [allowedPhone] : allowedPhone).some(phone => authorizedPhoneJid(phoneJid, phone))) return 'remetente não autorizado';
}

/** Desembrulha apenas tipos conhecidos; nunca abre visualização única. */
export function messageContent(m: WAMessage) {
  let content = m.message;
  for (let i = 0; i <= 5; i++) {
    if (content?.viewOnceMessage || content?.viewOnceMessageV2 || content?.viewOnceMessageV2Extension ||
        content?.imageMessage?.viewOnce || content?.videoMessage?.viewOnce) return undefined;
    const nested = content?.ephemeralMessage?.message ?? content?.documentWithCaptionMessage?.message ?? content?.associatedChildMessage?.message;
    if (!nested) return content;
    if (i === 5) return undefined;
    content = nested;
  }
}

export function requestStatus(m: WAMessage, allowedPhone: string | readonly string[]): string {
  const rejected = authorizationStatus(m, allowedPhone);
  if (rejected) return rejected;
  const content = messageContent(m);
  const animation = content?.videoMessage ??
    (content?.documentMessage?.mimetype === 'image/gif' ? content.documentMessage : undefined) ??
    (content?.imageMessage?.mimetype === 'image/gif' ? content.imageMessage : undefined);
  if (animation && (isAnimationStickerCommand(animation.caption) || !(animation.caption ?? '').trim().startsWith('!'))) return 'animação aceita';
  if (!animation && content?.imageMessage && (isStickerCommand(content.imageMessage.caption) || !(content.imageMessage.caption ?? '').trim().startsWith('!'))) return 'aceita';
  const text = messageText(m);
  if (text.trim().toLowerCase() === '!help') return 'ajuda aceita';
  if (parseGifCommand(text)) return 'gif por link aceito';
  if (/^!(?:gifigurinha|gf)(?:\s|$)/i.test(text.trim())) return 'comando de gif inválido';
  if (parseVideoCommand(text)) return 'vídeo aceito';
  if (/^!(?:video|v|vfigurinha|vf)(?:\s|$)/i.test(text.trim())) return 'comando de vídeo inválido';
  if (text.trim().startsWith('!')) return commandUsage(text) ? 'comando em formato inválido' : 'comando desconhecido';
  if (animation) return 'mídia sem legenda !figurinha';
  if (!content?.imageMessage) return 'aguardando foto com legenda !figurinha';
  return 'foto sem legenda !figurinha';
}

export function stickerRequest(m: WAMessage, allowedPhone: string | readonly string[]): boolean {
  return ['aceita', 'animação aceita'].includes(requestStatus(m, allowedPhone));
}

/** Limita leitura real, sem confiar apenas no tamanho anunciado pela mensagem. */
export async function readBounded(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('Imagem maior que o limite permitido.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function isStickerCommand(text?: string | null): boolean {
  return /^!(?:figurinha|f)(?:\s+(?:fluida|nitida|nítida|equilibrada))?$/i.test(text?.trim() ?? '');
}

/** !gf também funciona como legenda de vídeo/GIF, sem exigir link. */
export function isAnimationStickerCommand(text?: string | null): boolean {
  return isStickerCommand(text) || /^!(?:gifigurinha|gf)(?:\s+(?:fluida|nitida|nítida|equilibrada))?$/i.test(text?.trim() ?? '');
}

export function stickerProfile(text: string): StickerProfile {
  const value = text.trim().split(/\s+/)[1]?.toLowerCase();
  return value === 'fluida' ? 'fluida' : value === 'nitida' || value === 'nítida' ? 'nitida' : 'equilibrada';
}
export type VideoCommand = { url: string; sticker: boolean; profile?: StickerProfile };
export function parseVideoCommand(text: string): VideoCommand | undefined {
  const combined = /^(?:!f(?:igurinha)?\s+(https:\/\/\S+)|(https:\/\/\S+)\s+!f(?:igurinha)?)$/i.exec(text.trim());
  if (combined) { const url = videoUrl(combined[1] ?? combined[2]!); if (url) return {url, sticker:true}; }
  const match = /^!(video|v|vfigurinha|vf)\s+(.+)$/is.exec(text.trim());
  const sticker = !!match && ['vfigurinha', 'vf'].includes(match[1]!.toLowerCase());
  const args = match ? match[2]! : text;
  const profileMatch = sticker ? /^(fluida|nitida|nítida|equilibrada)\s+(\S+)$/i.exec(args) : null;
  const url = videoUrl(profileMatch ? profileMatch[2]! : args);
  if (!url) return;
  return profileMatch ? {url, sticker, profile: stickerProfile('!f '+profileMatch[1])} : {url, sticker};
}

export function messageText(m: WAMessage): string {
  const content = messageContent(m);
  return content?.conversation ?? content?.extendedTextMessage?.text ?? content?.videoMessage?.caption ??
    content?.imageMessage?.caption ?? content?.documentMessage?.caption ?? '';
}

export function requestedVideo(m: WAMessage): VideoCommand | undefined {
  return parseVideoCommand(messageText(m));
}
export function parseGifCommand(text:string): string | undefined {
  const match=/^!(?:gifigurinha|gf)\s+(?:(?:fluida|nitida|nítida|equilibrada)\s+)?(\S+)$/i.exec(text.trim());
  if (match) return directAnimationUrl(match[1]!)?.href;
  if (videoUrl(text.trim())) return;
  const url = directAnimationUrl(text.trim());
  if (!url) return;
  const original = text.trim().toLowerCase();
  if (/\.(?:gif|webp)(?:[?#]|$)/i.test(original) || url.searchParams.get('format')?.toLowerCase() === 'webp' || /^https:\/\/cdn\.7tv\.app\/emote\//i.test(original)) return url.href;
  return undefined;
}

/** Orientação para comandos conhecidos sem repetir o conteúdo enviado pelo usuário. */
export function commandUsage(text: string): string | undefined {
  const name = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  switch (name) {
    case '!help': return 'Use !help, sem argumentos, para listar os comandos.';
    case '!figurinha': case '!f': return 'Envie uma foto, vídeo ou GIF com a legenda !figurinha ou !f. Vídeos e GIFs podem ter até 10 MiB; uso os primeiros 10 segundos.';
    case '!video': case '!v': return 'Use !video <link> ou !v <link de publicação pública do Instagram, Twitter/X ou YouTube Shorts>.';
    case '!vfigurinha': case '!vf': return 'Use !vfigurinha <link> ou !vf <link de publicação pública do Instagram, Twitter/X ou YouTube Shorts> para receber o vídeo e a figurinha.';
    case '!gifigurinha': case '!gf': return 'Use !gf <link HTTPS direto de GIF/WebP animado>, ou envie vídeo/GIF com a legenda !gf (até 10 MiB; uso os primeiros 10 segundos).';
  }
}
export function invalidCommandReply(m: WAMessage): string {
  return commandUsage(messageText(m)) ?? 'Esse comando não existe. Envie !help para ver os comandos disponíveis.';
}
