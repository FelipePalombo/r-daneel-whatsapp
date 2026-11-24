import { proto } from '@whiskeysockets/baileys';

/** Protótipo de serialização do campo 26; não envia nem altera o Baileys globalmente.
 * O formato é baseado em engenharia reversa e ainda exige teste no WhatsApp. */
export function encodeSoundStickerPrototype(sticker: proto.Message.IStickerMessage, audio: proto.Message.IAudioMessage): Uint8Array {
  const visual = proto.Message.StickerMessage.encode(sticker).finish();
  const sound = proto.Message.AudioMessage.encode(audio).finish();
  const size: number[] = [];
  let remaining = sound.length;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    size.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.concat([visual, Buffer.from([0xd2, 0x01, ...size]), sound]);
}
