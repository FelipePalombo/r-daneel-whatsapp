import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import makeWASocket, { DisconnectReason, downloadMediaMessage, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { createDirectAnimatedSticker, createLinkedVideoSticker, validateAnimatedSticker, AnimatedStickerError, accelerateSticker } from './animated-sticker.js';
import { createSticker, MAX_INPUT_BYTES } from './sticker.js';
import { readBounded, requestStatus, requestedVideo, messageText, parseGifCommand, invalidCommandReply, stickerProfile, authorizationStatus, messageContent } from './request.js';
import { videoFailureReply } from './video.js';
import { sendVideoResponse } from './video-response.js';
import { HELP_TEXT } from './help.js';
import { sendGifResponse } from './gif-sticker.js';
import { JobQueue } from './job-queue.js';
import { PhotoAlbumCollector, sendPhotoBatch } from './photo-batch.js';
import { loadAllowedNumbers } from './access.js';
import { shouldOptimize, stickerOptions } from './sticker-options.js';
import { SoundChoices } from './sound-choices.js';
import { installSoundDiagnostic, soundShape } from './sound-diagnostic.js';
import { soundEnabledFor } from './sound-gate.js';
import { inspectSoundSource, extractStickerAudio, sendExperimentalSoundSticker } from './sound-sticker.js';
import type { WAMessage } from '@whiskeysockets/baileys';

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
const soundDiagnostics = process.env.SOUND_STICKER_DIAGNOSTIC === 'true';
if (soundDiagnostics) installSoundDiagnostic();
const soundChoices = new SoundChoices(3);
const soundExperimental = process.env.SOUND_STICKER_EXPERIMENTAL === 'true';
// O diagnóstico temporário, quando ativado, permanece restrito a um telefone.
const soundTestPhone = process.env.SOUND_STICKER_TEST_PHONE;
function soundEnabled(message: WAMessage): boolean {
  return soundEnabledFor(message, soundExperimental, allowedNumbers);
}
let outstandingChoices = 0;
const choiceTimers = new Set<ReturnType<typeof setTimeout>>();

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


/** Retoma decisões sem segurar a fila durante os 15 segundos de espera. */
function scheduleChoice(work: () => Promise<void>): void {
  const attempt = () => {
    if (stopping) { outstandingChoices--; return; }
    const reservation = jobs.reserve();
    if (reservation) { outstandingChoices--; reservation.submit(work); return; }
    const timer = setTimeout(() => { choiceTimers.delete(timer); attempt(); }, 500);
    choiceTimers.add(timer);
  };
  attempt();
}
async function withLinkedInput<T>(input: Buffer, action: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'daneel-linked-sound-'));
  try {
    const path = join(dir, 'video.mp4');
    await writeFile(path, input, { mode: 0o600 });
    return await action(path);
  } finally { await rm(dir, { recursive:true, force:true }); }
}
async function convertVideoSticker(input: Buffer, linked: boolean, original: WAMessage, wantsSound: boolean): Promise<void> {
  const jid = original.key.remoteJid!;
  const text = messageText(original);
  const options = stickerOptions(text);
  let sound = wantsSound && soundEnabled(original);
  if (wantsSound && !soundEnabled(original)) await socket.sendMessage(jid, { text:'O envio com som está desativado. Vou criar a figurinha sem som.' });
  await socket.sendMessage(jid, { text:'Vou preparar a figurinha animada. Isso pode levar alguns minutos.' });
  const profile = stickerProfile(text);
  const converted = linked
    ? await withLinkedInput(input, path => createLinkedVideoSticker(path, profile, false))
    : await createDirectAnimatedSticker(input, profile);
  if (converted.trimmed) await socket.sendMessage(jid, { text:'Para a figurinha, usei os primeiros 10 segundos do vídeo ou GIF.' }).catch(() => {});
  const playback = shouldOptimize(options.mode, sound) ? accelerateSticker(converted.sticker) : {sticker:converted.sticker,accelerated:false};
  if (playback.accelerated) await socket.sendMessage(jid, { text:'Acelerei a figurinha para deixar a animação mais fluida.' }).catch(() => {});
  if (sound) {
    try {
      const audio = await extractStickerAudio(input, converted.sticker, playback.sticker);
      await sendExperimentalSoundSticker(socket, jid, original, playback.sticker, audio, validateAnimatedSticker(playback.sticker).durationMs,
        !!(soundDiagnostics && soundTestPhone && !authorizationStatus(original, soundTestPhone.replace(/\D/g, ''))));
      return;
    } catch {
      sound = false;
      await socket.sendMessage(jid, { text:'Não consegui enviar a figurinha com som. Vou tentar enviar uma versão sem som.' }).catch(() => {});
    }
  }
  await socket.sendMessage(jid, { sticker:playback.sticker, isAnimated:true, width:512, height:512 }, { quoted:original });
}
async function prepareVideoSticker(input: Buffer, linked: boolean, original: WAMessage): Promise<void> {
  const jid = original.key.remoteJid!;
  const options = stickerOptions(messageText(original));
  const info = await inspectSoundSource(input);
  if (!info.hasAudio) {
    if (options.sound) await socket.sendMessage(jid, { text:'Esse vídeo ou GIF não tem áudio. Vou criar a figurinha sem som.' });
    await convertVideoSticker(input, linked, original, false);
    return;
  }
  if (options.sound) { await convertVideoSticker(input, linked, original, true); return; }
  if (!soundEnabled(original)) { await convertVideoSticker(input, linked, original, false); return; }
  if (outstandingChoices >= 3) {
    await socket.sendMessage(jid, { text:'Há muitas perguntas de áudio aguardando resposta. Reenvie este pedido em instantes.' }, { quoted:original });
    return;
  }
  outstandingChoices++;
  let prompt: WAMessage | undefined;
  try {
    prompt = await socket.sendMessage(jid, { text:'Quer a figurinha com som? Responda !som; qualquer outra resposta envia sem som. Aguardo 15 segundos.' }, { quoted:original });
  } catch { outstandingChoices--; await convertVideoSticker(input, linked, original, false); return; }
  if (!prompt?.key.id || !soundChoices.add(jid, prompt.key.id, (sound, expired) => {
    const notify = expired ? 'Tempo esgotado. Vou criar a figurinha sem som.' : 'Resposta recebida.';
    void socket.sendMessage(jid, { text:`${notify} Dica: envie !som junto do vídeo ou do comando para pular a pergunta.` }).catch(() => {});
    scheduleChoice(async () => {
      try { await convertVideoSticker(input, linked, original, sound); }
      catch { await socket.sendMessage(jid, { text:'Não consegui criar essa figurinha. Tente novamente com outro vídeo ou GIF.' }).catch(() => {}); }
    });
  })) {
    outstandingChoices--;
    await socket.sendMessage(jid, { text:'Não consegui aguardar sua resposta. Vou criar a figurinha sem som.' });
    await convertVideoSticker(input, linked, original, false);
  }
}

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
      if (soundDiagnostics && soundTestPhone && soundEnabled(message) && !authorizationStatus(message, soundTestPhone.replace(/\D/g, ''))) {
        const shape = soundShape(message.message);
        if (shape) console.log('Diagnóstico de figurinha sonora:', JSON.stringify(shape));
      }
      const status = requestStatus(message, allowedNumbers);
      if (!message.key.fromMe) console.log(`Recebimento: ${status}.`);
      const now = Date.now();
      for (const [key, timestamp] of seen) if (now - timestamp > 600_000) seen.delete(key);
      const key = `${message.key.remoteJid}:${message.key.id}`;
      if (seen.has(key)) { console.log('Pedido ignorado: repetido.'); continue; }
      const content = messageContent(message);
      const replyText = content?.conversation ?? content?.extendedTextMessage?.text;
      const isNewRequest = !!replyText && (requestedVideo(message) !== undefined || parseGifCommand(replyText) !== undefined);
      if (replyText && !isNewRequest && !authorizationStatus(message, allowedNumbers)) {
        const choice = soundChoices.respond(message.key.remoteJid!, replyText, content?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined);
        if (choice !== 'unmatched') {
          seen.set(key, now);
          if (choice === 'ambiguous') await current.sendMessage(message.key.remoteJid!, { text:'Há mais de uma pergunta pendente. Responda citando a pergunta do vídeo desejado.' }, { quoted:message }).catch(() => {});
          continue;
        }
      }
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
            if (stickerOptions(messageText(message)).sound) await current.sendMessage(jid, { text:'GIFs não contêm áudio. Vou criar a figurinha sem som.' });
            await sendGifResponse(gifUrl, {
              sticker: async sticker => { await current.sendMessage(jid, { sticker, isAnimated:true, width:512, height:512 }, { quoted:message }); },
              text: async text => { await current.sendMessage(jid, { text }); },
            }, undefined, undefined, stickerProfile(messageText(message)), shouldOptimize(stickerOptions(messageText(message)).mode, false));
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
            }, undefined, undefined, shouldOptimize(stickerOptions(messageText(message)).mode, false), async path => {
              await current.sendMessage(jid, { text:'Vou verificar o áudio e preparar a figurinha.' }).catch(() => {});
              const input = await readFile(path);
              if (input.length > 16 * 1024 * 1024) throw new Error('Vídeo maior que o limite.');
              await prepareVideoSticker(input, true, message);
            });
            console.log('Vídeo enviado.');
            return;
          }
          if (status === 'aceita') await current.sendMessage(jid, { text: 'Vou criar a figurinha desta foto.' }).catch(() => {});
          if (status === 'animação aceita') await current.sendMessage(jid, { text: 'Vou verificar o vídeo para preparar a figurinha.' });
          const stream = await downloadMediaMessage(message, 'stream', { options: { signal: AbortSignal.timeout(30_000) } }, {
            logger, reuploadRequest: current.updateMediaMessage
          });
          const input = await readBounded(stream, MAX_INPUT_BYTES);
          let sticker: Buffer;
          if (status === 'animação aceita') {
            await prepareVideoSticker(input, false, message);
            return;
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
  soundChoices.close();
  for (const pending of choiceTimers) clearTimeout(pending);
  choiceTimers.clear();
  socket?.end(undefined);
  void jobs.idle.finally(() => saveCreds()).then(() => process.exit(code), () => process.exit(1));
  setTimeout(() => process.exit(code), 5000).unref();
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
connect();
