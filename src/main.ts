import { mkdir } from 'node:fs/promises';
import makeWASocket, { DisconnectReason, downloadMediaMessage, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { createAnimatedSticker, AnimatedStickerError } from './animated-sticker.js';
import { createSticker, MAX_INPUT_BYTES } from './sticker.js';
import { readBounded, requestStatus, requestedVideo, messageText, parseGifCommand } from './request.js';
import { sendVideoResponse } from './video-response.js';
import { sendGifResponse } from './gif-sticker.js';
import { loadAllowedNumbers } from './access.js';

process.umask(0o077);
const allowedNumbers = await loadAllowedNumbers();
const authDir = process.env.AUTH_DIR ?? './data/auth';
const pairing = process.env.PAIRING_MODE === 'true';
if (pairing && !process.stdout.isTTY) throw new Error('Vincule em um terminal interativo; QR não deve ir para logs de hospedagem.');
await mkdir(authDir, { recursive: true, mode: 0o700 });
const { state, saveCreds } = await useMultiFileAuthState(authDir);
if (!state.creds.me?.id && !pairing) throw new Error('Primeiro vincule localmente: PAIRING_MODE=true npm start');
// Evita imprimir chaves de sessão, números e conteúdo de mensagens nos logs da biblioteca.
const logger = pino({ level: 'silent' });
let stopping = false;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let socket: ReturnType<typeof makeWASocket>;
let pending = 0;
let queue = Promise.resolve();
const seen = new Map<string, number>();
let lastRequest = 0;

function connect() {
  const current = makeWASocket({ auth: state, logger, syncFullHistory: false, markOnlineOnConnect: false });
  socket = current;
  current.ev.on('creds.update', () => { void saveCreds().catch(() => {
    console.error('Falha ao persistir sessão; encerrando para evitar perda de estado.'); stop(1);
  }); });
  current.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (pairing) qrcode.generate(qr, { small: true });
      else { console.error('Sessão precisa ser vinculada novamente em terminal local.'); stop(1); }
    }
    if (connection === 'open') { attempt = 0; console.log('R. Daneel conectado. Envie foto, vídeo ou GIF com !figurinha ou um link de vídeo do Twitter/X ou Instagram.'); }
    if (connection === 'close' && !stopping) {
      current.ev.removeAllListeners('messages.upsert');
      current.ev.removeAllListeners('connection.update');
      const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (status === DisconnectReason.loggedOut || status === DisconnectReason.connectionReplaced) {
        console.error('Sessão encerrada ou usada por outra instância. Revise a vinculação.'); stop(1); return;
      }
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6));
      console.log(`Conexão interrompida. Nova tentativa em ${delay / 1000}s.`);
      timer = setTimeout(connect, delay);
    }
  });
  current.ev.on('messages.upsert', ({ type, messages }) => {
    void receive(type, messages).catch(() => console.error('Falha ao identificar mensagem recebida.'));
  });
  async function receive(type: string, messages: import('@whiskeysockets/baileys').WAMessage[]) {
    if (type !== 'notify' || stopping) return;
    for (const message of messages) {
      if (message.key.remoteJid?.endsWith('@lid') && !message.key.remoteJidAlt && !message.key.fromMe) {
        const mapped = await current.signalRepository.lidMapping.getPNForLID(message.key.remoteJid);
        if (mapped) message.key.remoteJidAlt = mapped;
      }
      const status = requestStatus(message, allowedNumbers);
      if (!message.key.fromMe) console.log(`Recebimento: ${status}.`);
      if (!['aceita', 'animação aceita', 'vídeo aceito', 'comando de vídeo inválido', 'gif por link aceito', 'comando de gif inválido'].includes(status)) continue;
      const now = Date.now();
      for (const [key, timestamp] of seen) if (now - timestamp > 600_000) seen.delete(key);
      const key = `${message.key.remoteJid}:${message.key.id}`;
      if (seen.has(key) || now - lastRequest < 2000 || pending >= 3) {
        console.log('Pedido ignorado: repetido, intervalo mínimo ou fila cheia.'); continue;
      }
      seen.set(key, now); lastRequest = now; pending++;
      queue = queue.then(async () => {
        if (stopping) return;
        const jid = message.key.remoteJid!;
        const videoRequest = requestedVideo(message);
        const url = videoRequest?.url;
        if (status === 'comando de gif inválido') {
          await current.sendMessage(jid, { text: 'Use !gifigurinha <link> ou !gf <link HTTPS direto de GIF ou WebP animado>.' });
          return;
        }
        if (status === 'comando de vídeo inválido') {
          await current.sendMessage(jid, { text: 'Envie o link de uma publicação ou Reel do Instagram, ou de uma publicação do Twitter/X. Use !video ou !v <link> para vídeo; !vfigurinha ou !vf <link> para vídeo e figurinha.' });
          return;
        }
        try {
          const gifUrl=parseGifCommand(messageText(message));
          if (gifUrl) {
            await sendGifResponse(gifUrl, {
              sticker: async sticker => { await current.sendMessage(jid, { sticker, isAnimated:true, width:512, height:512 }, { quoted:message }); },
              text: async text => { await current.sendMessage(jid, { text }); },
            });
            console.log('Figurinha de link enviada.');
            return;
          }
          if (videoRequest) {
            await current.sendMessage(jid, { text: 'Vou buscar o vídeo. Pode levar até três minutos.' });
            await sendVideoResponse(videoRequest, {
              video: async (path, link) => { await current.sendMessage(jid, { video: { url: path }, mimetype: 'video/mp4', caption: link }, { quoted: message }); },
              sticker: async sticker => { await current.sendMessage(jid, { sticker, isAnimated: true, width: 512, height: 512 }, { quoted: message }); },
              text: async text => { await current.sendMessage(jid, { text }); },
            });
            console.log('Vídeo enviado.');
            return;
          }
          const stream = await downloadMediaMessage(message, 'stream', { options: { signal: AbortSignal.timeout(30_000) } }, {
            logger, reuploadRequest: current.updateMediaMessage
          });
          const input = await readBounded(stream, MAX_INPUT_BYTES);
          const sticker = status === 'animação aceita' ? await createAnimatedSticker(input) : await createSticker(input);
          await current.sendMessage(jid, { sticker, isAnimated: status === 'animação aceita', width: 512, height: 512 }, { quoted: message });
          console.log('Figurinha enviada.');
        } catch (error) {
          if (url && error instanceof Error) console.error(error.message);
          console.error(url ? 'Não foi possível concluir o vídeo.' : 'Não foi possível concluir uma figurinha.');
          await current.sendMessage(jid, { text: error instanceof AnimatedStickerError ? error.message : url ? 'Não consegui baixar esse vídeo. Precisa ser uma publicação pública com vídeo de até 3 minutos e 16 MB. O Instagram ou X também pode exigir login ou bloquear o download temporariamente.' : 'Não consegui preparar essa figurinha. Envie foto, vídeo ou GIF de até 10 MB com a legenda !figurinha. Vídeos e GIFs devem ter até 10 segundos.' }).catch(() => {});
        }
      }).catch(() => { console.error('Falha no processamento.'); }).finally(() => { pending--; });
    }
  }
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  socket?.end(undefined);
  void queue.finally(() => saveCreds()).then(() => process.exit(code), () => process.exit(1));
  setTimeout(() => process.exit(code), 5000).unref();
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
connect();
