import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import makeWASocket, { generateWAMessageFromContent, prepareWAMessageMedia, proto, type WAMessage } from '@whiskeysockets/baileys';
import { validateAnimatedSticker } from './animated-sticker.js';
import { inspectSoundShape } from './sound-diagnostic.js';
import { createAudioSidecar } from './sound-sidecar.js';

const exec = promisify(execFile);
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
type StickerWithAudio = proto.Message.IStickerMessage & { audioMessage?: proto.Message.IAudioMessage };
const audioStickerEnvelope = Symbol('audio-sticker-envelope');
type MessageWithAudioSticker = proto.IMessage & { [audioStickerEnvelope]?: boolean };

/** Executa FFmpeg somente em arquivo local temporário, privado e de tamanho limitado. */
async function withSource<T>(input: Buffer, run: (path: string, dir: string) => Promise<T>): Promise<T> {
  if (!input.length || input.length > MAX_SOURCE_BYTES) throw new Error('Vídeo excede o tamanho permitido.');
  const dir = await mkdtemp(join(tmpdir(), 'daneel-audio-'));
  try {
    const path = join(dir, 'source');
    await writeFile(path, input, { mode: 0o600 });
    return await run(path, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function ffprobe(path: string): Promise<{ hasAudio: boolean; duration: number }> {
  const result = await exec('ffprobe', ['-v','error','-protocol_whitelist','file,pipe','-show_entries',
    'format=duration:stream=codec_type','-of','json',path], { timeout: 10_000, maxBuffer: 128 * 1024 });
  const data = JSON.parse(result.stdout) as { streams?: {codec_type?: string}[]; format?: {duration?: string} };
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !data.streams?.some(s => s.codec_type === 'video')) throw new Error('Vídeo inválido.');
  return { hasAudio: data.streams.some(s => s.codec_type === 'audio'), duration };
}
export async function inspectSoundSource(input: Buffer): Promise<{hasAudio:boolean;duration:number}> {
  return withSource(input, path => ffprobe(path));
}
/** Conserva o trecho inicial e ajusta o áudio à duração final da figurinha. */
export async function extractStickerAudio(input: Buffer, originalSticker: Buffer, finalSticker: Buffer): Promise<Buffer> {
  const original = validateAnimatedSticker(originalSticker).durationMs;
  const final = validateAnimatedSticker(finalSticker).durationMs;
  const factor = original / final;
  if (factor < 0.99 || factor > 1.51) throw new Error('A velocidade da figurinha é incompatível com o áudio.');
  return withSource(input, async (path, dir) => {
    const info = await ffprobe(path);
    if (!info.hasAudio) throw new Error('Este vídeo não tem áudio.');
    const output = join(dir, 'audio.ogg');
    await exec('ffmpeg', ['-hide_banner','-loglevel','error','-nostdin','-y','-protocol_whitelist','file,pipe',
      '-t',String(Math.min(10, info.duration, original / 1000)), '-i',path, '-map','0:a:0','-vn','-sn','-dn',
      '-af',`atempo=${factor.toFixed(6)}`, '-ac','1','-c:a','libopus','-b:a','48k','-map_metadata','-1',output],
      { timeout: 30_000, maxBuffer: 128 * 1024 });
    const audio = await readFile(output);
    if (!audio.length || audio.length > 256_000) throw new Error('Não consegui preparar o áudio dentro do limite.');
    return audio;
  });
}

let encoderInstalled = false;
/** Compatibilidade pequena e reproduzível com o campo ainda ausente no Baileys rc14. */
export function installExperimentalAudioEncoder(): void {
  if (encoderInstalled) return;
  const original = proto.Message.StickerMessage.encode;
  const originalMessage = proto.Message.encode;
  proto.Message.StickerMessage.encode = ((message: StickerWithAudio, writer?: Parameters<typeof original>[1]) => {
    const result = original(message, writer);
    if (message.audioMessage) proto.Message.AudioMessage.encode(message.audioMessage, result.uint32(210).fork()).ldelim();
    return result;
  }) as typeof original;
  // O objeto mantém stickerMessage para o Baileys identificar mediatype=sticker.
  // No wire, o campo 134 contém FutureProofMessage.message.stickerMessage.
  proto.Message.encode = ((message: MessageWithAudioSticker, writer?: Parameters<typeof originalMessage>[1]) => {
    if (!message[audioStickerEnvelope]) return originalMessage(message, writer);
    if (!message.stickerMessage) throw new Error('Figurinha sonora sem conteúdo.');
    const { stickerMessage, ...otherFields } = message;
    const output = originalMessage(otherFields, writer);
    proto.Message.FutureProofMessage.encode({ message: { stickerMessage } }, output.uint32(1074).fork()).ldelim();
    return output;
  }) as typeof originalMessage;
  encoderInstalled = true;
}
/** Não prova reprodução: somente upload e envio experimentais ao protocolo. */
export async function sendExperimentalSoundSticker(socket: ReturnType<typeof makeWASocket>, jid: string,
  quoted: WAMessage, sticker: Buffer, audio: Buffer, durationMs: number, diagnostic = false): Promise<void> {
  validateAnimatedSticker(sticker);
  if (!audio.length || audio.length > 256_000 || !socket.user?.id) throw new Error('Áudio indisponível.');
  const options = { upload: socket.waUploadToServer, mediaUploadTimeoutMs: 30_000 };
  const visual = await prepareWAMessageMedia({ sticker, isAnimated:true, width:512, height:512 }, options);
  const sound = await prepareWAMessageMedia({ audio, mimetype:'audio/ogg; codecs=opus', seconds:Math.ceil(durationMs/1000) }, options);
  if (!visual.stickerMessage || !sound.audioMessage?.mediaKey || !sound.audioMessage.fileEncSha256) throw new Error('Falha ao preparar mídia.');
  sound.audioMessage.streamingSidecar = await createAudioSidecar(audio, sound.audioMessage.mediaKey, sound.audioMessage.fileEncSha256);
  const message = generateWAMessageFromContent(jid, visual, { userJid:socket.user.id, quoted });
  if (!message.message?.stickerMessage || !message.key.id) throw new Error('Falha ao preparar mensagem.');
  (message.message.stickerMessage as StickerWithAudio).audioMessage = sound.audioMessage;
  Object.defineProperty(message.message, audioStickerEnvelope, { value:true });
  installExperimentalAudioEncoder();
  if (diagnostic) {
    const shape = inspectSoundShape(proto.Message.encode(message.message).finish());
    console.log('Diagnóstico de envio sonoro:', JSON.stringify(shape));
  }
  await socket.relayMessage(jid, message.message, { messageId:message.key.id });
}
