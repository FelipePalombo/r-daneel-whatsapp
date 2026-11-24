import test from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import { encodeSoundStickerPrototype } from '../src/sound-sticker-prototype.js';

test('anexa o AudioMessage codificado ao campo experimental 26', () => {
  const visual = { mimetype: 'image/webp', isAnimated: true };
  const audio = { mimetype: 'audio/ogg; codecs=opus', seconds: 2, ptt: true };
  const base = Buffer.from(proto.Message.StickerMessage.encode(visual).finish());
  const encoded = Buffer.from(encodeSoundStickerPrototype(visual, audio));
  assert.deepEqual(encoded.subarray(0, base.length), base);
  assert.deepEqual([...encoded.subarray(base.length, base.length + 2)], [0xd2, 0x01]);
  const body = encoded.subarray(base.length + 3);
  assert.equal(encoded[base.length + 2], body.length);
  const decoded = proto.Message.AudioMessage.decode(body);
  assert.equal(decoded.mimetype, audio.mimetype);
  assert.equal(decoded.seconds, 2);
  assert.equal(decoded.ptt, true);
});
