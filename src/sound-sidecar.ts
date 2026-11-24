import { createCipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getMediaKeys } from '@whiskeysockets/baileys';

/** Autentica blocos de 64 KiB do áudio cifrado, usando a mesma chave do upload. */
export async function createAudioSidecar(audio: Buffer, mediaKey: Uint8Array, expectedEncryptedHash: Uint8Array): Promise<Buffer> {
  if (!audio.length || audio.length > 256_000 || mediaKey.length !== 32 || expectedEncryptedHash.length !== 32)
    throw new Error('Áudio inválido para verificação por blocos.');
  const { iv, cipherKey, macKey } = await getMediaKeys(Buffer.from(mediaKey), 'audio');
  if (!iv || !cipherKey || !macKey) throw new Error('Chaves de áudio inválidas.');
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(audio), cipher.final()]);
  const fullMac = createHmac('sha256', macKey).update(iv).update(encrypted).digest().subarray(0, 10);
  const actualHash = createHash('sha256').update(encrypted).update(fullMac).digest();
  if (!timingSafeEqual(actualHash, Buffer.from(expectedEncryptedHash))) throw new Error('A verificação do áudio cifrado falhou.');
  const sidecars: Buffer[] = [];
  for (let start = 0; start < encrypted.length; start += 65_536) {
    const previous = start === 0 ? iv : encrypted.subarray(start - 16, start);
    const chunk = encrypted.subarray(start, Math.min(start + 65_536, encrypted.length));
    sidecars.push(createHmac('sha256', macKey).update(previous).update(chunk).digest().subarray(0, 10));
  }
  return Buffer.concat(sidecars);
}
