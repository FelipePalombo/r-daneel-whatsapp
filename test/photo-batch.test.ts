import test from 'node:test';
import assert from 'node:assert/strict';
import type { WAMessage } from '@whiskeysockets/baileys';
import sharp from 'sharp';
import { PhotoAlbumCollector, sendPhotoBatch, type AlbumClock, type PhotoBatch } from '../src/photo-batch.js';
import { JobQueue } from '../src/job-queue.js';
import { requestStatus } from '../src/request.js';
import { createSticker, MAX_INPUT_BYTES } from '../src/sticker.js';

const phone = '5511999999999';
const jid = phone + '@s.whatsapp.net';
function header(id: string, images?: number, videos = 0, chat = jid): WAMessage {
  return { key: { id, remoteJid: chat }, message: { albumMessage: { expectedImageCount: images, expectedVideoCount: videos } } };
}
function image(id: string, album: string, caption = '', index?: number, chat = jid): WAMessage {
  return { key: { id, remoteJid: chat }, message: { imageMessage: { caption, mimetype: 'image/jpeg' },
    messageContextInfo: { messageAssociation: { associationType: 1, parentMessageKey: { id: album, remoteJid: chat }, messageIndex: index } } } };
}
function video(id: string, album: string, caption = ''): WAMessage {
  const m = image(id, album);
  m.message!.videoMessage = { caption, gifPlayback: true };
  delete m.message!.imageMessage;
  return m;
}
class FakeClock implements AlbumClock {
  current = 10_000;
  next = 0;
  tasks = new Map<number, { at: number; action: () => void }>();
  now = () => this.current;
  set = (action: () => void, ms: number) => { const key = ++this.next; this.tasks.set(key, { at: this.current + ms, action }); return key; };
  clear = (key: unknown) => { this.tasks.delete(key as number); };
  advance(ms: number) {
    const end = this.current + ms;
    while (true) {
      const next = [...this.tasks.entries()].filter(([,task]) => task.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.tasks.delete(next[0]); this.current = next[1].at; next[1].action();
    }
    this.current = end;
  }
}
function setup(allowed = [phone]) {
  const queue = new JobQueue();
  const clock = new FakeClock();
  const batches: PhotoBatch[] = [];
  const busy: WAMessage[] = [];
  const collector = new PhotoAlbumCollector(allowed, queue, async batch => { batches.push(batch); }, m => busy.push(m), clock);
  return { queue, clock, batches, busy, collector };
}

test('álbuns de 2 e 10 fotos usam uma reserva e uma legenda, com saída na ordem dos índices', async () => {
  for (const size of [2,10]) {
    const {queue,clock,batches,collector} = setup();
    collector.offer(header('album',size));
    assert.equal(queue.pending,1);
    // Legenda só chega no último evento; fotos já recebidas permanecem no lote.
    for (let i=size-1;i>=0;i--) assert.equal(collector.offer(image(`photo-${i}`,'album',i===0?' !F ':'',i)),true);
    await queue.idle;
    assert.equal(batches.length,1);
    assert.equal(batches[0]!.photos.length,size);
    assert.deepEqual(batches[0]!.photos.map(m=>m.key.id),Array.from({length:size},(_,i)=>`photo-${i}`));
    assert.equal(queue.pending,0); assert.equal(collector.collecting,0); assert.equal(clock.tasks.size,0);
  }
});

test('filhos podem chegar antes do cabeçalho e duplicatas não completam nem repetem o lote',async()=>{
  const {queue,clock,batches,collector}=setup();
  const a=image('a','album','!figurinha',0), b=image('b','album','',1);
  collector.offer(a);collector.offer(a);collector.offer(header('album',2));
  await queue.idle;assert.equal(batches.length,0);
  collector.offer(b);await queue.idle;
  collector.offer(header('album',2));collector.offer(a);collector.offer(b);
  clock.advance(20_000);await queue.idle;
  assert.equal(batches.length,1);assert.equal(batches[0]!.photos.length,2);assert.equal(queue.pending,0);
});

test('limita excesso às primeiras dez por índice, mesmo se o comando estiver fora dessas dez',async()=>{
  const {queue,batches,collector}=setup();collector.offer(header('large',12));
  for(let i=11;i>=0;i--)collector.offer(image(`p-${i}`,'large',i===11?'!f':'',i));
  await queue.idle;
  assert.equal(batches[0]!.overLimit,true);
  assert.deepEqual(batches[0]!.photos.map(m=>m.key.id),Array.from({length:10},(_,i)=>`p-${i}`));
});

test('sem contagem usa silêncio de 3s e ordem de chegada; cabeçalho posterior ativa prazo máximo',async()=>{
  const {queue,clock,batches,collector}=setup();
  collector.offer(image('one','unknown','!f'));clock.advance(2000);
  collector.offer(image('two','unknown'));clock.advance(2999);await queue.idle;assert.equal(batches.length,0);
  clock.advance(1);await queue.idle;
  assert.deepEqual(batches[0]!.photos.map(m=>m.key.id),['one','two']);
  collector.offer(image('first','incomplete','!f'));
  collector.offer(header('incomplete',3));clock.advance(3000);await queue.idle;assert.equal(batches.length,1);
  clock.advance(12000);await queue.idle;assert.equal(batches[1]!.incomplete,true);assert.equal(queue.pending,0);
});

test('prazo máximo de 15s não é renovado e álbuns sem comando não baixam nem convertem',async()=>{
  const {queue,clock,batches,collector}=setup();
  collector.offer(image('start','stream','!f'));
  for(let i=1;i<=7;i++){clock.advance(2000);collector.offer(image(`stream-${i}`,'stream'));}
  clock.advance(1000);await queue.idle;assert.equal(batches.length,1);assert.equal(collector.collecting,0);
  collector.offer(header('ignored',2));collector.offer(image('n1','ignored'));collector.offer(image('n2','ignored'));
  await queue.idle;assert.equal(batches.length,1);assert.equal(queue.pending,0);assert.equal(clock.tasks.size,0);
});

test('lotes mistos só compartilham comando entre fotos, sem absorver comandos individuais',async()=>{
  const {queue,batches,collector}=setup();
  collector.offer(header('mixed',2,1));collector.offer(image('a','mixed','!f'));collector.offer(video('v','mixed'));collector.offer(image('b','mixed'));
  await queue.idle;assert.equal(batches[0]!.mixed,true);assert.deepEqual(batches[0]!.photos.map(m=>m.key.id),['a','b']);
  collector.offer(header('explicit',1,1));collector.offer(image('plain','explicit'));
  assert.equal(collector.offer(video('video-command','explicit','!f')),false);
  await queue.idle;assert.equal(batches.length,1);
  collector.offer(header('other-command',2));collector.offer(image('yes','other-command','!f'));
  assert.equal(collector.offer(image('other','other-command','!vf https://x.com/test/status/123')),false);
  await queue.idle;assert.deepEqual(batches[1]!.photos.map(m=>m.key.id),['yes']);
});

test('álbuns e conversas ficam isolados e mídia de visualização única nunca entra',async()=>{
  const other='5511888888888', otherJid=other+'@s.whatsapp.net';
  const {queue,clock,batches,collector}=setup([phone,other]);
  collector.offer(header('same',1));collector.offer(header('same',1,0,otherJid));
  collector.offer(image('mine','same','!f'));collector.offer(image('theirs','same','',undefined,otherJid));await queue.idle;
  assert.equal(batches.length,1);assert.equal(batches[0]!.photos[0]!.key.remoteJid,jid);
  const valid=image('secret','private','!f');
  for(const m of [
    {...valid,key:{...valid.key,remoteJid:'5511777777777@s.whatsapp.net'}},
    {...valid,key:{...valid.key,remoteJid:'group@g.us'}},
    {...valid,key:{...valid.key,fromMe:true}},
    {key:valid.key,message:{viewOnceMessage:{message:valid.message}}},
    {key:valid.key,message:{viewOnceMessageV2:{message:valid.message}}},
    {...valid,message:{...valid.message,imageMessage:{...valid.message!.imageMessage,viewOnce:true}}},
  ])assert.equal(collector.offer(m),false);
  assert.equal(queue.pending,0);clock.advance(20_000);assert.equal(collector.collecting,0);
});

test('reserva limite global inclui coleta, espera e execução; fila cheia avisa só uma vez por álbum',async()=>{
  const {queue,clock,batches,busy,collector}=setup();
  collector.offer(header('a',2));collector.offer(header('b',2));
  const ordinary=queue.reserve()!;
  let finish!:()=>void;ordinary.submit(()=>new Promise<void>(resolve=>{finish=resolve;}));
  await Promise.resolve();
  assert.equal(queue.pending,3);assert.equal(queue.reserve(),undefined);
  collector.offer(header('full',2));collector.offer(image('f1','full','!f'));collector.offer(image('f2','full','!f'));
  assert.equal(busy.length,1);assert.equal(collector.collecting,2);
  clock.advance(15_000);assert.equal(queue.pending,1);finish();await queue.idle;
  assert.equal(queue.pending,0);assert.equal(batches.length,0);
});

test('sem associação não há herança; aceita wrapper de álbum e descarta referências ao encerrar',async()=>{
  const {queue,clock,collector}=setup();
  const plain=image('solo','missing','!f');delete plain.message!.messageContextInfo;
  assert.equal(collector.offer(plain),false);assert.equal(requestStatus(plain,phone),'aceita');
  const uncaptioned={...plain,key:{...plain.key,id:'other'},message:{imageMessage:{mimetype:'image/jpeg'}}};
  assert.equal(collector.offer(uncaptioned),false);assert.notEqual(requestStatus(uncaptioned,phone),'aceita');
  const nested=image('wrapped','album','!f');
  assert.equal(collector.offer({key:nested.key,message:{messageContextInfo:nested.message!.messageContextInfo,associatedChildMessage:{message:{imageMessage:nested.message!.imageMessage}}}}),true);
  assert.equal(queue.pending,1);collector.close();collector.close();clock.advance(30_000);await queue.idle;
  assert.equal(collector.collecting,0);assert.equal(queue.pending,0);assert.equal(clock.tasks.size,0);
});

test('envio sequencial de fotos reais continua após entrada inválida ou grande e informa falha parcial',async()=>{
  const photos=[image('one','batch','!f'),image('bad','batch'),image('large','batch'),image('last','batch')];
  const input=await sharp({create:{width:24,height:60,channels:3,background:'red'}}).png().toBuffer();
  const events:string[]=[];let active=0;
  await sendPhotoBatch({photos,overLimit:true,mixed:true,incomplete:true},{
    text:async text=>{events.push(text);},
    sticker:async(sticker,m)=>{assert.equal(active,0);assert.ok(sticker.length<=100_000);events.push('sent:'+m.key.id);},
  },async m=>{
    active++;assert.equal(active,1);events.push('prepare:'+m.key.id);
    try{return await createSticker(m.key.id==='bad'?Buffer.from('invalid'):m.key.id==='large'?Buffer.alloc(MAX_INPUT_BYTES+1):input);}
    finally{active--;}
  });
  assert.ok(events[0]!.includes('4 foto'));assert.ok(events[0]!.includes('10 fotos'));assert.ok(events[0]!.includes('somente fotos'));
  assert.deepEqual(events.filter(e=>e.startsWith('sent:')),['sent:one','sent:last']);
  assert.ok(events.some(e=>e.includes('foto 2')));assert.ok(events.some(e=>e.includes('foto 3')));
  assert.equal(events.at(-1),'Lote concluído: 2 de 4 figurinhas enviadas.');
});

test('fila serial continua após falha e cancelamento/liberação duplicados não alteram capacidade',async()=>{
  let errors=0;const q=new JobQueue(3,()=>{errors++;});const order:number[]=[];
  const first=q.reserve()!,second=q.reserve()!,third=q.reserve()!;
  third.cancel();third.cancel();third.submit(async()=>assert.fail());
  first.submit(async()=>{order.push(1);throw new Error('failure');});first.submit(async()=>assert.fail());first.cancel();
  second.submit(async()=>{order.push(2);});await q.idle;
  assert.deepEqual(order,[1,2]);assert.equal(errors,1);assert.equal(q.pending,0);
});
