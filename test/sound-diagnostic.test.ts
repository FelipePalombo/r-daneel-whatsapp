import test from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import { inspectSoundShape, installSoundDiagnostic, soundShape } from '../src/sound-diagnostic.js';
import { installExperimentalAudioEncoder } from '../src/sound-sticker.js';

function lengthDelimited(tag:number, body:Uint8Array):Buffer {
  function v(n:number) { const bytes:number[]=[]; do { const b=n%128;n=Math.floor(n/128);bytes.push(b|(n?128:0)); } while(n);return Buffer.from(bytes); }
  return Buffer.concat([v(tag*8+2),v(body.length),body]);
}
test('descreve somente campos do áudio incorporado ou do envelope', () => {
  installExperimentalAudioEncoder();
  const sticker={mimetype:'image/webp',audioMessage:{mimetype:'audio/ogg; codecs=opus',seconds:2,contextInfo:{forwardingScore:1}}};
  const payload=proto.Message.encode({stickerMessage:sticker}).finish();
  const shape=inspectSoundShape(payload)!;
  assert.ok(shape.messageFields.includes(26));
  assert.ok(shape.stickerFields?.includes(26));
  assert.ok(shape.audioFields?.includes(2));
  assert.ok(shape.audioContextFields?.includes(21));
  assert.ok(!JSON.stringify(shape).includes('audio/ogg'));
  const wrapped=lengthDelimited(134,lengthDelimited(1,payload));
  const wrapShape=inspectSoundShape(wrapped)!;
  assert.ok(wrapShape.messageFields.includes(134));
  assert.ok(wrapShape.wrappedStickerFields?.includes(26));
  assert.deepEqual(wrapShape.wrappedAudioFields,shape.audioFields);
  installSoundDiagnostic();
  const decoded=proto.Message.decode(wrapped);
  assert.deepEqual(soundShape(decoded),wrapShape);
  assert.equal(inspectSoundShape(Buffer.from([0xff])),undefined);
  assert.equal(inspectSoundShape(Buffer.alloc(1_048_577)),undefined);
});
