import { videoUrl } from './video.js';
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

export function requestStatus(m: WAMessage, allowedPhone: string | readonly string[]): string {
  const jid = m.key.remoteJid ?? '';
  if (m.key.fromMe) return 'mensagem própria';
  if (!m.key.id || (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid'))) return 'conversa não permitida';
  const phoneJid = jid.endsWith('@s.whatsapp.net') ? jid : m.key.remoteJidAlt;
  if (!phoneJid) return 'identificador interno sem número associado';
  if (!(typeof allowedPhone === 'string' ? [allowedPhone] : allowedPhone).some(phone => authorizedPhoneJid(phoneJid, phone))) return 'remetente não autorizado';
  // Desembrulha somente mensagens temporárias; visualização única continua bloqueada.
  let content = m.message;
  for (let i = 0; i < 5; i++) {
    const nested = content?.ephemeralMessage?.message ?? content?.documentWithCaptionMessage?.message;
    if (!nested) break;
    content = nested;
  }
  const text = content?.conversation ?? content?.extendedTextMessage?.text ?? '';
  if (parseVideoCommand(text)) return 'vídeo aceito';
  if (/^!(?:video|v|vfigurinha|vf)(?:\s|$)/i.test(text.trim())) return 'comando de vídeo inválido';
  const animation = content?.videoMessage ??
    (content?.documentMessage?.mimetype === 'image/gif' ? content.documentMessage : undefined) ??
    (content?.imageMessage?.mimetype === 'image/gif' ? content.imageMessage : undefined);
  if (animation) return isStickerCommand(animation.caption) ? 'animação aceita' : 'mídia sem legenda !figurinha';
  if (!content?.imageMessage) return 'aguardando foto com legenda !figurinha';
  if (!isStickerCommand(content.imageMessage.caption)) return 'foto sem legenda !figurinha';
  return 'aceita';
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
  return /^!(?:figurinha|f)$/i.test(text?.trim() ?? '');
}

export type VideoCommand = { url: string; sticker: boolean };
export function parseVideoCommand(text: string): VideoCommand | undefined {
  const match = /^!(video|v|vfigurinha|vf)\s+(.+)$/is.exec(text.trim());
  const url = videoUrl(match ? match[2]! : text);
  if (!url) return;
  return { url, sticker: !!match && ['vfigurinha', 'vf'].includes(match[1]!.toLowerCase()) };
}

export function requestedVideo(m: WAMessage): VideoCommand | undefined {
  let content = m.message;
  for (let i = 0; i < 5; i++) {
    const nested = content?.ephemeralMessage?.message ?? content?.documentWithCaptionMessage?.message;
    if (!nested) break;
    content = nested;
  }
  return parseVideoCommand(content?.conversation ?? content?.extendedTextMessage?.text ?? '');
}
