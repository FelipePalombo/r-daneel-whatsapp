import { mkdir } from 'node:fs/promises';
import makeWASocket, { DisconnectReason, downloadMediaMessage, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { createDirectAnimatedSticker, AnimatedStickerError, accelerateSticker } from './animated-sticker.js';
import { createSticker, MAX_INPUT_BYTES } from './sticker.js';
import { readBounded, requestStatus, requestedVideo, messageText, parseGifCommand, invalidCommandReply, stickerProfile } from './request.js';
import { videoFailureReply } from './video.js';
import { sendVideoResponse } from './video-response.js';
import { HELP_TEXT } from './help.js';
import { sendGifResponse } from './gif-sticker.js';
import { JobQueue } from './job-queue.js';
import { PhotoAlbumCollector, sendPhotoBatch } from './photo-batch.js';
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
const jobs = new JobQueue(3, () => console.error('Falha no processamento.'));
const seen = new Map<string, number>();
let lastRequest = 0;

function reportBusy(message: import('@whiskeysockets/baileys').WAMessage) {
  const jid = message.key.remoteJid!;
  void socket.sendMessage(jid, { text: 'A fila está cheia. Este pedido não entrou: aguarde os atuais terminarem e envie novamente.' }, { quoted: message }).catch(() => {});
}
const albums = new PhotoAlbumCollector(allowedNumbers, jobs, async batch => {
  if (stopping) return;
  const jid = batch.photos[0]!.key.remoteJid!;
  await sendPhotoBatch(batch, {
    text: async text => { await socket.sendMessage(jid, { text }); },
    sticker: async (sticker, original) => { await socket.sendMessage(jid, { sticker, width: 512, height: 512 }, { quoted: original }); },
  }, async original => {
    const stream = await downloadMediaMessage(original, 'stream', { options: { signal: AbortSignal.timeout(30_000) } }, {
      logger, reuploadRequest: socket.updateMediaMessage,
    });
    return createSticker(await readBounded(stream, MAX_INPUT_BYTES));
  });
}, reportBusy, undefined, async (message, text) => { await socket.sendMessage(message.key.remoteJid!, { text }, { quoted: message }); });

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
    if (connection === 'open') { attempt = 0; console.log('R. Daneel conectado. Envie foto, vídeo ou GIF com !figurinha ou um link de Instagram, Twitter/X ou YouTube Shorts.'); }
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
      const now = Date.now();
      for (const [key, timestamp] of seen) if (now - timestamp > 600_000) seen.delete(key);
      const key = `${message.key.remoteJid}:${message.key.id}`;
      if (seen.has(key)) { console.log('Pedido ignorado: repetido.'); continue; }
      if (albums.offer(message)) { seen.set(key, now); continue; }
      if (!['aceita', 'animação aceita', 'vídeo aceito', 'comando de vídeo inválido', 'gif por link aceito', 'comando de gif inválido', 'ajuda aceita', 'comando em formato inválido', 'comando desconhecido'].includes(status)) continue;
      // Fotos avulsas com comando próprio podem chegar juntas sem o intervalo de 2s.
      if (status !== 'aceita' && now - lastRequest < 2000) {
        console.log('Pedido ignorado: intervalo mínimo.');
        void current.sendMessage(message.key.remoteJid!, { text: 'Recebi pedidos muito próximos. Aguarde 2 segundos e reenvie este comando; ele não entrou na fila.' }, { quoted: message }).catch(() => {});
        continue;
      }
      const reservation = jobs.reserve();
      if (!reservation) { reportBusy(message); continue; }
      seen.set(key, now);
      if (status !== 'aceita') lastRequest = now;
      const jid = message.key.remoteJid!;
      const queued = current.sendMessage(jid, { text: jobs.pending > 1
        ? 'Pedido recebido e colocado na fila. Vou avisar quando começar. Não precisa reenviar.'
        : 'Pedido recebido. Vou iniciar o processamento.' }, { quoted: message }).catch(() => {});
      reservation.submit(async () => {
        await queued;
        if (stopping) return;
        const jid = message.key.remoteJid!;
        if (status === 'ajuda aceita') {
          await current.sendMessage(jid, { text: HELP_TEXT }, { quoted: message });
          return;
        }
        const videoRequest = requestedVideo(message);
        const url = videoRequest?.url;
        if (['comando de gif inválido', 'comando de vídeo inválido', 'comando em formato inválido', 'comando desconhecido'].includes(status)) {
          await current.sendMessage(jid, { text: invalidCommandReply(message) }, { quoted: message });
          return;
        }
        try {
          const gifUrl=parseGifCommand(messageText(message));
          if (gifUrl) {
            await sendGifResponse(gifUrl, {
              sticker: async sticker => { await current.sendMessage(jid, { sticker, isAnimated:true, width:512, height:512 }, { quoted:message }); },
              text: async text => { await current.sendMessage(jid, { text }); },
            }, undefined, undefined, stickerProfile(messageText(message)));
            console.log('Figurinha de link enviada.');
            return;
          }
          if (videoRequest) {
            await current.sendMessage(jid, { text: 'Vou buscar o vídeo. Pode levar alguns minutos.' });
            await sendVideoResponse(videoRequest, {
              video: async (path, link) => { await current.sendMessage(jid, { video: { url: path }, mimetype: 'video/mp4', caption: link }, { quoted: message }); },
              image: async (image, mimetype) => { await current.sendMessage(jid, { image, mimetype }, { quoted: message }); },
              sticker: async sticker => { await current.sendMessage(jid, { sticker, isAnimated: true, width: 512, height: 512 }, { quoted: message }); },
              text: async text => { await current.sendMessage(jid, { text }); },
            });
            console.log('Vídeo enviado.');
            return;
          }
          if (status === 'aceita') await current.sendMessage(jid, { text: 'Vou criar a figurinha desta foto.' }).catch(() => {});
          if (status === 'animação aceita') await current.sendMessage(jid, { text: 'Vou preparar a figurinha animada. Isso pode levar alguns minutos.' });
          const stream = await downloadMediaMessage(message, 'stream', { options: { signal: AbortSignal.timeout(30_000) } }, {
            logger, reuploadRequest: current.updateMediaMessage
          });
          const input = await readBounded(stream, MAX_INPUT_BYTES);
          let sticker: Buffer;
          if (status === 'animação aceita') {
            const converted = await createDirectAnimatedSticker(input, stickerProfile(messageText(message)));
            if (converted.trimmed) await current.sendMessage(jid, { text: 'Para a figurinha, usei os primeiros 10 segundos do vídeo ou GIF.' }).catch(() => {});
            const result = accelerateSticker(converted.sticker); sticker = result.sticker;
            if (result.accelerated) await current.sendMessage(jid, { text: 'Acelerei a figurinha para deixar a animação mais fluida.' }).catch(() => {});
          } else sticker = await createSticker(input);
          await current.sendMessage(jid, { sticker, isAnimated: status === 'animação aceita', width: 512, height: 512 }, { quoted: message });
          console.log('Figurinha enviada.');
        } catch (error) {
          if (url && error instanceof Error) console.error(error.message);
          console.error(url ? 'Não foi possível concluir o vídeo.' : 'Não foi possível concluir uma figurinha.');
          await current.sendMessage(jid, { text: error instanceof AnimatedStickerError ? error.message : url ? videoFailureReply(error, url) : 'Não consegui preparar essa figurinha. Envie foto, vídeo ou GIF de até 10 MB com a legenda !figurinha. Vídeos e GIFs longos usam os primeiros 10 segundos.' }).catch(() => {});
        }
      });
    }
  }
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  albums.close();
  socket?.end(undefined);
  void jobs.idle.finally(() => saveCreds()).then(() => process.exit(code), () => process.exit(1));
  setTimeout(() => process.exit(code), 5000).unref();
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
connect();
