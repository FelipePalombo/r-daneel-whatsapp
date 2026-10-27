import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { AnimatedStickerError, MAX_ANIMATED_INPUT_BYTES } from './animated-sticker.js';

export function directAnimationUrl(value: string): URL | undefined {
  if (/\s/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash) return url;
  } catch { /* Entrada inválida. */ }
}
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) blocked.addSubnet(address,prefix,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
blocked.addSubnet('2001::',23,'ipv6'); blocked.addSubnet('2001:db8::',32,'ipv6'); blocked.addSubnet('2002::',16,'ipv6'); blocked.addSubnet('3fff::',20,'ipv6');
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address,'ipv4') : family === 6 && global6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
export type Address = { address: string; family: number };
export type GifResponse = { status: number; location?: string; length?: string; body: AsyncIterable<Uint8Array>; close: () => void };
export type GifNetwork = {
  resolve: (hostname: string) => Promise<Address[]>;
  get: (url: URL, address: Address, signal: AbortSignal) => Promise<GifResponse>;
};
const network: GifNetwork = {
  resolve: hostname => lookup(hostname,{all:true,verbatim:true}),
  get: (url,address,signal) => new Promise((resolve,reject) => {
    // DNS validado e fixado nesta conexão; TLS continua validando o hostname original.
    const req = request(url,{signal,agent:false,lookup: (_host,_options,callback) => {
      if(_options.all) (callback as unknown as (error:null,addresses:Address[])=>void)(null,[address]);
      else callback(null,address.address,address.family);
    }},res => {
      resolve({status:res.statusCode ?? 0,location:res.headers.location,length:res.headers['content-length'],body:res,close:()=>res.destroy()});
    });
    req.on('error',reject); req.end();
  }),
};
export async function downloadAnimation(value: string, io: GifNetwork = network, timeoutMs = 30_000): Promise<Buffer> {
  let url = directAnimationUrl(value);
  if (!url) throw new AnimatedStickerError('Link inválido. Use !gf <link HTTPS direto de GIF ou WebP animado>.');
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeoutMs);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_,reject)=>{
    abortListener=()=>reject(new AnimatedStickerError('O download da animação excedeu o tempo permitido.'));
    controller.signal.addEventListener('abort',abortListener,{once:true});
  });
  const work = async () => {
    for (let redirects=0; redirects<=3; redirects++) {
      const hostname=url!.hostname.replace(/^\[|\]$/g,'');
      const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await io.resolve(hostname);
      if(controller.signal.aborted) throw new Error('Timeout');
      if(!addresses.length || addresses.some(item=>!publicAddress(item.address))) throw new AnimatedStickerError('Esse link aponta para um endereço bloqueado. Use um link público HTTPS.');
      const response=await io.get(url!,addresses[0]!,controller.signal);
      try {
        if([301,302,303,307,308].includes(response.status)) {
          if(redirects===3 || !response.location) throw new AnimatedStickerError('O link excedeu o limite de redirecionamentos.');
          const next=directAnimationUrl(new URL(response.location,url).href);
          if(!next) throw new AnimatedStickerError('O link redireciona para um endereço inválido.');
          url=next; continue;
        }
        if(response.status!==200) throw new AnimatedStickerError('Não consegui baixar a animação. Use um link direto público, sem login.');
        if(Number(response.length)>MAX_ANIMATED_INPUT_BYTES) throw new AnimatedStickerError('A animação ultrapassa 10 MiB.');
        const chunks:Buffer[]=[];let bytes=0;
        for await(const chunk of response.body) {
          bytes+=chunk.length;
          if(bytes>MAX_ANIMATED_INPUT_BYTES) throw new AnimatedStickerError('A animação ultrapassa 10 MiB.');
          chunks.push(Buffer.from(chunk));
        }
        if(!bytes) throw new AnimatedStickerError('O arquivo da animação está vazio.');
        return Buffer.concat(chunks);
      } finally {response.close();}
    }
    throw new Error('Redirect');
  };
  try {return await Promise.race([work(),aborted]);}
  catch(error) {
    if(error instanceof AnimatedStickerError) throw error;
    throw new AnimatedStickerError('Não consegui baixar a animação. Confira se o link é direto e público.');
  } finally {clearTimeout(timer);if(abortListener)controller.signal.removeEventListener('abort',abortListener);}
}
