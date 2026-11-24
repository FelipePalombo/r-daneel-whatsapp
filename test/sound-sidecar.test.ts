import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { encryptedStream, getMediaKeys } from '@whiskeysockets/baileys';
import { createAudioSidecar } from '../src/sound-sidecar.js';

test('sidecar acompanha exatamente os blocos cifrados pelo Baileys', async () => {
  for (const size of [1, 65_519, 65_536, 140_000]) {
    const audio=randomBytes(size), uploaded=await encryptedStream(audio,'audio');
    try {
      const ciphertextWithMac=await readFile(uploaded.encFilePath);
      const ciphertext=ciphertextWithMac.subarray(0,-10);
      const keys=await getMediaKeys(uploaded.mediaKey,'audio');
      assert.ok(keys.iv && keys.macKey);
      const expected:Buffer[]=[];
      for(let start=0;start<ciphertext.length;start+=65_536) {
        const previous=start?ciphertext.subarray(start-16,start):keys.iv;
        expected.push(createHmac('sha256',keys.macKey).update(previous).update(ciphertext.subarray(start,start+65_536)).digest().subarray(0,10));
      }
      const sidecar=await createAudioSidecar(audio,uploaded.mediaKey,uploaded.fileEncSha256);
      assert.deepEqual(sidecar,Buffer.concat(expected));
      if(ciphertext.length<=65_536) assert.deepEqual(sidecar,ciphertextWithMac.subarray(-10));
      const invalid=Buffer.from(uploaded.fileEncSha256);invalid[0]^=1;
      await assert.rejects(createAudioSidecar(audio,uploaded.mediaKey,invalid));
    } finally {await unlink(uploaded.encFilePath);}
  }
});
