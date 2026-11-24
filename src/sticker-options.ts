import type { StickerProfile } from './animated-sticker.js';

export type StickerMode = 'normal' | 'otimizar' | 'qualidade';
export type StickerOptions = { sound: boolean; mode?: StickerMode; text: string; valid: boolean };
/** Opções podem acompanhar comandos existentes em qualquer ordem; URLs não são alteradas. */
export function stickerOptions(input: string): StickerOptions {
  const tokens=input.trim().split(/\s+/).filter(Boolean);let sound=false;let mode:StickerMode|undefined;let valid=true;
  const kept:string[]=[];
  for(const token of tokens) {
    const value=token.toLowerCase();
    if(value==='!som') {if(sound)valid=false;sound=true;continue;}
    if(value==='!normal'||value==='!otimizar'||value==='!qualidade') {
      if(mode)valid=false;mode=value.slice(1) as StickerMode;continue;
    }
    kept.push(token);
  }
  return {sound,mode,text:kept.join(' '),valid};
}
export function chooseProfile(profile:StickerProfile, mode?:StickerMode):StickerProfile {return mode==='qualidade'?'nitida':profile;}
export function shouldOptimize(mode:StickerMode|undefined, withSound:boolean):boolean {return mode==='otimizar'||(!mode&&!withSound);}
