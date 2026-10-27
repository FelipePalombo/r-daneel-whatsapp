import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {downloadAnimation,directAnimationUrl,publicAddress,type GifNetwork} from '../src/gif-download.js';
import {createGifSticker,sendGifResponse} from '../src/gif-sticker.js';
import {validateAnimatedSticker,MAX_ANIMATED_INPUT_BYTES} from '../src/animated-sticker.js';
import {parseGifCommand,requestStatus} from '../src/request.js';

function animation(format:'gif'|'webp',delay=100,frames=3,width=24,height=12) {
  const data=Buffer.alloc(width*height*frames*4);
  for(let f=0;f<frames;f++)for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++) {
    const i=((f*height+y)*width+x)*4;data[i+f%3]=255;data[i+3]=255;
  }
  return sharp(data,{raw:{width,height:height*frames,channels:4,pageHeight:height}})
    .toFormat(format,{delay:Array(frames).fill(delay),loop:0}).toBuffer();
}
test('comandos gf, aliases, autorização e mensagens embrulhadas',()=>{
  const url='https://example.com/path/4x.avif?format=webp';
  for(const command of ['!gf','!GIFIGURINHA'])assert.equal(parseGifCommand(` ${command} ${url} `),url);
  for(const value of ['!gf','!gf errado',`!gf ${url} extra`,url,'!gfoo '+url])assert.equal(parseGifCommand(value),undefined);
  const phone='5511999999999',key={id:'gif',remoteJid:`${phone}@s.whatsapp.net`};
  const message={key,message:{ephemeralMessage:{message:{conversation:`!gf ${url}`}}}};
  assert.equal(requestStatus(message,phone),'gif por link aceito');
  assert.equal(requestStatus(message,'5511888888888'),'remetente não autorizado');
  assert.equal(requestStatus({...message,key:{...key,remoteJid:'group@g.us'}},phone),'conversa não permitida');
  assert.equal(requestStatus({key,message:{conversation:'!gf'}},phone),'comando de gif inválido');
});
test('URLs e endereços públicos bloqueiam redes internas, locais e reservadas',()=>{
  for(const url of ['http://example.com/a','https://user:pass@example.com/a','https://example.com:444/a','https://example.com/a texto','file:///tmp/a'])assert.equal(directAnimationUrl(url),undefined);
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::','3fff::1','192.88.99.1'])assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
});
function fake(responses:{status:number;location?:string;length?:string;chunks?:Buffer[]}[],addresses=['1.1.1.1']) {
  let calls=0,closed=0;
  const io:GifNetwork={resolve:async()=>addresses.map(address=>({address,family:4})),get:async(_url,address)=>{
    assert.equal(address.address,'1.1.1.1');const item=responses[calls++]!;
    return {...item,body:(async function*(){yield* item.chunks ?? [Buffer.from('GIF89a')];})(),close:()=>{closed++;}};
  }};
  return {io,counts:()=>({calls,closed})};
}
test('download único com redirecionamentos, limite real e encerramento das respostas',async()=>{
  const ok=fake([{status:302,location:'/next'},{status:200}]);
  assert.equal((await downloadAnimation('https://example.com/a',ok.io)).toString(),'GIF89a');
  assert.deepEqual(ok.counts(),{calls:2,closed:2});
  for(const response of [{status:403},{status:200,length:String(MAX_ANIMATED_INPUT_BYTES+1)},
    {status:200,chunks:[Buffer.alloc(MAX_ANIMATED_INPUT_BYTES),Buffer.from('x')]},
    {status:200,chunks:[]},{status:302,location:'http://example.com/a'}]) {
    const io=fake([response]);await assert.rejects(downloadAnimation('https://example.com/a',io.io));assert.equal(io.counts().closed,1);
  }
  const loop=fake(Array(4).fill({status:302,location:'/next'}));
  await assert.rejects(downloadAnimation('https://example.com/a',loop.io),/redirecionamentos/);assert.equal(loop.counts().calls,4);
});
test('bloqueia DNS privado e valida novamente cada redirecionamento',async()=>{
  const privateDns=fake([{status:200}],['127.0.0.1']);
  await assert.rejects(downloadAnimation('https://example.com/a',privateDns.io),/bloqueado/);assert.equal(privateDns.counts().calls,0);
  const redirect=fake([{status:302,location:'https://127.0.0.1/a'}]);
  await assert.rejects(downloadAnimation('https://example.com/a',redirect.io),/bloqueado/);assert.equal(redirect.counts().calls,1);
  const mixed=fake([{status:200}],['1.1.1.1','10.0.0.1']);
  await assert.rejects(downloadAnimation('https://example.com/a',mixed.io),/bloqueado/);
  await assert.rejects(downloadAnimation('https://example.com/a',{resolve:async()=>new Promise(()=>{}),get:privateDns.io.get},10),/tempo/);
  await assert.rejects(downloadAnimation('https://example.com/a',{resolve:async()=>[{address:'1.1.1.1',family:4}],get:async()=>new Promise(()=>{})},10),/tempo/);
  await assert.rejects(downloadAnimation('https://example.com/a',{resolve:async()=>{throw new Error('DNS');},get:privateDns.io.get}),/baixar/);
});
test('GIF e WebP preservam movimento, transparência, tamanho e duração',async()=>{
  for(const format of ['gif','webp'] as const) {
    const result=await createGifSticker(await animation(format));
    assert.equal(result.trimmed,false);
    const meta=validateAnimatedSticker(result.sticker);assert.ok(meta.frames>=2);
    const {data,info}=await sharp(result.sticker,{animated:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.width,512);assert.equal(info.pageHeight,512);assert.equal(data[3],0);
    const page=512*512*4;assert.notDeepEqual(data.subarray(0,page),data.subarray(page,page*2));
  }
});
test('recorta 10 segundos e recusa estáticos, formatos inválidos e excesso de quadros',async()=>{
  const before=(await readdir(tmpdir())).filter(name=>name.startsWith('r-daneel-gif-')).sort();
  const result=await createGifSticker(await animation('webp',4000));
  assert.equal(result.trimmed,true);assert.ok(validateAnimatedSticker(result.sticker).durationMs<=10000);
  await assert.rejects(createGifSticker(await sharp({create:{width:4,height:4,channels:4,background:'red'}}).webp().toBuffer()),/estático/);
  await assert.rejects(createGifSticker(Buffer.from('pagina html')),/Formato/);
  await assert.rejects(createGifSticker(Buffer.alloc(MAX_ANIMATED_INPUT_BYTES+1)),/10 MiB/);
  await assert.rejects(createGifSticker(await animation('webp',10,301)),/300 quadros/);
  await assert.rejects(createGifSticker(Buffer.from('GIF89a corrompido')));
  const after=(await readdir(tmpdir())).filter(name=>name.startsWith('r-daneel-gif-')).sort();assert.deepEqual(after,before);
});
test('envia somente figurinha, avisa recorte e não repete download após falha de envio',async()=>{
  let downloads=0;const events:string[]=[];
  await assert.rejects(sendGifResponse('https://example.com/a',{
    text:async()=>{events.push('trim');},sticker:async()=>{events.push('sticker');throw new Error('envio');},
  },async()=>{downloads++;return Buffer.from('fixture');},async()=>({sticker:Buffer.from('result'),trimmed:true})));
  assert.equal(downloads,1);assert.deepEqual(events,['trim','sticker']);
});

test('links AVIF de emotes 7TV usam a versão WebP sem alterar outros hosts ou caminhos', async()=>{
  const path='/emote/01JQ8HG9PWF9Z56JPFSPHG0J0E/4x';
  const original=`https://cdn.7tv.app${path}.avif`;
  const expected=`https://cdn.7tv.app${path}.webp`;
  assert.equal(parseGifCommand(`!gf ${original}`),expected);
  assert.equal(parseGifCommand(`!gifigurinha ${original}?tracking=1`),expected);
  for(const host of ['example.com','cdn.7tv.app.evil.test']) {
    const url=`https://${host}${path}.avif`;
    assert.equal(directAnimationUrl(url)?.href,url);
  }
  assert.equal(directAnimationUrl('https://cdn.7tv.app/other/4x.avif')?.pathname,'/other/4x.avif');
  const io:GifNetwork={resolve:async()=>[{address:'1.1.1.1',family:4}],get:async(url)=>{
    assert.equal(url.href,expected);
    return {status:200,body:(async function*(){yield Buffer.from('fixture');})(),close:()=>{}};
  }};
  await downloadAnimation(original,io);
});
