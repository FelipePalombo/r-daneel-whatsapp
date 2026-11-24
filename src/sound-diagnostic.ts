import { proto } from '@whiskeysockets/baileys';

/** Somente números de campos protobuf; nunca armazena bytes, URLs, áudio ou chaves. */
export type SoundShape = { messageFields:number[]; stickerFields?:number[]; audioFields?:number[]; wrapperFields?:number[]; wrappedMessageFields?:number[]; wrappedStickerFields?:number[]; wrappedAudioFields?:number[]; messageContextFields?:number[]; stickerContextFields?:number[]; audioContextFields?:number[] };
type Field = {number:number; bytes?:Uint8Array};
const annotation = Symbol('sound-sticker-shape');
function fields(data: Uint8Array): Field[] {
  if (data.length > 1_048_576) throw new Error('Mensagem grande demais');
  let pos=0;
  function varint():number {
    let n=0, factor=1;
    for(let i=0;i<10;i++) { if(pos>=data.length)throw Error('protobuf truncado'); const b=data[pos++]!; n+=(b&127)*factor; if(!(b&128))return n; factor*=128; }
    throw Error('varint inválido');
  }
  const out:Field[]=[];
  while(pos<data.length) {
    if(out.length>=512)throw Error('campos demais');
    const tag=varint(), number=Math.floor(tag/8), wire=tag%8;
    if(!number)throw Error('campo inválido');
    if(wire===0) {varint();out.push({number});}
    else if(wire===1 || wire===5) {pos+=wire===1?8:4;if(pos>data.length)throw Error('protobuf truncado');out.push({number});}
    else if(wire===2) {const len=varint();if(!Number.isSafeInteger(len)||len<0||pos+len>data.length)throw Error('tamanho inválido');out.push({number,bytes:data.subarray(pos,pos+len)});pos+=len;}
    else throw Error('wire desconhecido');
  }
  return out;
}
function nums(value:Field[]):number[] {return [...new Set(value.map(f=>f.number))].sort((a,b)=>a-b);}
function nested(value:Field[], id:number):Field[]|undefined {const v=value.find(f=>f.number===id)?.bytes;return v ? fields(v) : undefined;}
export function inspectSoundShape(input:Uint8Array):SoundShape|undefined {
  try {
    const top=fields(input), sticker=nested(top,26), wrapper=nested(top,134);
    if(!sticker && !wrapper)return;
    const audio=sticker && nested(sticker,26);
    const wrapped=wrapper && nested(wrapper,1), wrappedSticker=wrapped && nested(wrapped,26);
    const wrappedAudio=wrappedSticker && nested(wrappedSticker,26);
    const context=nested(top,35);
    const selectedSticker=wrappedSticker ?? sticker, selectedAudio=wrappedAudio ?? audio;
    const stickerContext=selectedSticker && nested(selectedSticker,17);
    const audioContext=selectedAudio && nested(selectedAudio,17);
    return {messageFields:nums(top),...(sticker&&{stickerFields:nums(sticker)}),...(audio&&{audioFields:nums(audio)}),
      ...(wrapper&&{wrapperFields:nums(wrapper)}),...(wrapped&&{wrappedMessageFields:nums(wrapped)}),
      ...(wrappedSticker&&{wrappedStickerFields:nums(wrappedSticker)}),...(wrappedAudio&&{wrappedAudioFields:nums(wrappedAudio)}),
      ...(context&&{messageContextFields:nums(context)}),...(stickerContext&&{stickerContextFields:nums(stickerContext)}),
      ...(audioContext&&{audioContextFields:nums(audioContext)})};
  } catch {return;}
}
/** Anexa somente metadados numéricos ao objeto decodificado; o chamador decide se pode registrar. */
export function installSoundDiagnostic():void {
  const original=proto.Message.decode;
  proto.Message.decode=((reader: Parameters<typeof original>[0], length?:number) => {
    const raw=reader instanceof Uint8Array ? reader.subarray(0,length) : reader.buf.subarray(reader.pos,length===undefined?reader.len:reader.pos+length);
    const shape=inspectSoundShape(raw);
    const message=original(reader,length);
    if(shape)Object.defineProperty(message,annotation,{value:shape,enumerable:true});
    return message;
  }) as typeof original;
}
export function soundShape(message:unknown):SoundShape|undefined {
  return message && typeof message==='object' ? (message as {[annotation]?:SoundShape})[annotation] : undefined;
}
