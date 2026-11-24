import { withVideo, videoPlatformName } from './video.js';
import { InstagramPhotoAvailable } from './snapinsta.js';
import { createSticker } from './sticker.js';
import { createLinkedVideoSticker } from './animated-sticker.js';
import type { VideoCommand } from './request.js';

type Sender = {
  video: (path: string, url: string) => Promise<void>;
  image?: (data: Buffer, mimetype: string) => Promise<void>;
  sticker: (data: Buffer) => Promise<void>;
  text: (text: string) => Promise<void>;
};
/** Falhas após envio do vídeo não acionam novo download nem são descritas como falha de download. */
export async function sendVideoResponse(request: VideoCommand, send: Sender,
  download = withVideo, convert = createLinkedVideoSticker, optimize = true,
  handleSticker?: (path: string) => Promise<void>): Promise<void> {
  let sending = false;
  try { await download(request.url, async path => {
    sending = true;
    await send.video(path, request.url);
    if (!request.sticker) return;
    try {
      if (handleSticker) { await handleSticker(path); return; }
      await send.text('Agora vou criar a figurinha animada. Isso pode levar alguns minutos.').catch(() => {});
      const result = await convert(path, request.profile, optimize);
      if (result.trimmed) await send.text('Para a figurinha, usei os primeiros 10 segundos do vídeo.');
      if (result.accelerated) await send.text('Acelerei a figurinha para deixar a animação mais fluida.').catch(() => {});
      await send.sticker(result.sticker);
    } catch {
      await send.text('O vídeo foi enviado, mas não consegui criar ou enviar a figurinha. Tente um trecho menor ou outro vídeo.');
    }
  }, undefined, { onRetry: async () => {
    const platform = videoPlatformName(request.url);
    await send.text(`${platform} limitou o acesso. Vou aguardar alguns segundos e tentar mais uma vez.`);
  }, onCompression: async () => {
    await send.text('O vídeo é grande; vou compactar para caber no WhatsApp. Isso pode levar alguns minutos.');
  }, onExternalFallback: async () => {
    await send.text('O download principal falhou. Vou tentar um serviço alternativo; pode levar até mais um minuto.');
  } }); } catch (error) {
    if (sending || !(error instanceof InstagramPhotoAvailable) || !send.image) throw error;
    try { await send.image(error.image, error.mimetype); }
    catch { await send.text('Encontrei a imagem, mas não consegui enviá-la. Tente novamente.').catch(() => {}); return; }
    try {
      await send.text('Agora vou criar uma figurinha dessa imagem.').catch(() => {});
      await send.sticker(await createSticker(error.image));
    } catch {
      await send.text('Enviei a imagem, mas não consegui criar ou enviar a figurinha.').catch(() => {});
    }
  }
}
