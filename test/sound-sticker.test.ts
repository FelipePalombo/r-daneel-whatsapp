import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto } from '@whiskeysockets/baileys';
import { accelerateSticker, createDirectAnimatedSticker, validateAnimatedSticker } from '../src/animated-sticker.js';
import { extractStickerAudio, inspectSoundSource, installExperimentalAudioEncoder, sendExperimentalSoundSticker } from '../src/sound-sticker.js';
import makeWASocket from '@whiskeysockets/baileys';
import { inspectSoundShape } from '../src/sound-diagnostic.js';
const exec = promisify(execFile);

test('o encoder usado pelo Baileys transmite o campo 26 com AudioMessage', () => {
  installExperimentalAudioEncoder();
  const sticker = {mimetype:'image/webp', audioMessage:{mimetype:'audio/ogg; codecs=opus',seconds:2}};
  const bytes = Buffer.from(proto.Message.encode({stickerMessage:sticker}).finish());
  const nested = Buffer.from(proto.Message.StickerMessage.encode(sticker).finish());
  assert.ok(bytes.includes(nested));
  assert.ok(nested.includes(Buffer.from([0xd2,0x01])));
  const silent = Buffer.from(proto.Message.StickerMessage.encode({mimetype:'image/webp'}).finish());
  assert.ok(!silent.includes(Buffer.from([0xd2,0x01])));
});

test('áudio Opus acompanha a figurinha e vídeo sem áudio é detectado', async () => {
  const dir = await mkdtemp(join(tmpdir(),'daneel-sound-test-'));
  try {
    const path=join(dir,'video.mp4');
    await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=120x120:rate=6:duration=2',
      '-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-shortest',path],{timeout:15000});
    const input=await readFile(path), info=await inspectSoundSource(input);
    assert.equal(info.hasAudio,true);
    const visual=(await createDirectAnimatedSticker(input)).sticker;
    const faster=accelerateSticker(visual).sticker;
    const audio=await extractStickerAudio(input,visual,faster);
    const audioPath=join(dir,'audio.ogg'); await writeFile(audioPath,audio);
    const probe=await exec('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name','-of','json',audioPath]);
    const result=JSON.parse(probe.stdout);
    assert.equal(result.streams[0].codec_name,'opus');
    const uploads: string[] = []; let relayed = Buffer.alloc(0);
    const socket = {
      user: {id:'5511999999999@s.whatsapp.net'},
      waUploadToServer: async (_path: string, opts: {mediaType:string}) => {
        uploads.push(opts.mediaType); return {mediaUrl:'https://example.invalid/media',directPath:'/media'};
      },
      relayMessage: async (_jid: string, msg: proto.IMessage) => {
        relayed = Buffer.from(proto.Message.encode(msg).finish());
        const copy = Buffer.from(proto.Message.encode({deviceSentMessage:{destinationJid:_jid,message:msg}}).finish());
        assert.ok(copy.includes(relayed));
        return 'id';
      },
    } as unknown as ReturnType<typeof makeWASocket>;
    await sendExperimentalSoundSticker(socket,'5511888888888@s.whatsapp.net',
      {key:{id:'original',remoteJid:'5511888888888@s.whatsapp.net'},message:{videoMessage:{}}},faster,audio,validateAnimatedSticker(faster).durationMs);
    assert.deepEqual(uploads,['sticker','audio']);
    const shape=inspectSoundShape(relayed);
    assert.ok(shape?.messageFields.includes(134));
    assert.ok(!shape?.messageFields.includes(26));
    assert.deepEqual(shape?.wrapperFields,[1]);
    assert.ok(shape?.wrappedMessageFields?.includes(26));
    assert.ok(shape?.wrappedStickerFields?.includes(26));
    assert.ok(shape?.wrappedAudioFields?.includes(2));
    assert.ok(shape?.wrappedAudioFields?.includes(18));
    assert.ok(!shape?.wrappedAudioFields?.includes(6));
    assert.ok(Math.abs(Number(result.format.duration)-validateAnimatedSticker(faster).durationMs/1000)<0.25);
    const silentPath=join(dir,'silent.mp4');
    await exec('ffmpeg',['-v','error','-i',path,'-map','0:v','-c','copy',silentPath]);
    assert.equal((await inspectSoundSource(await readFile(silentPath))).hasAudio,false);
    await assert.rejects(extractStickerAudio(await readFile(silentPath),visual,faster));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
