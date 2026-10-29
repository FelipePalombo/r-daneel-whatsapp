import { withVideo } from './video.js';
import { createLinkedVideoSticker } from './animated-sticker.js';
import type { VideoCommand } from './request.js';

type Sender = {
  video: (path: string, url: string) => Promise<void>;
  sticker: (data: Buffer) => Promise<void>;
  text: (text: string) => Promise<void>;
};
/** Falhas após envio do vídeo não acionam novo download nem são descritas como falha de download. */
export async function sendVideoResponse(request: VideoCommand, send: Sender,
  download = withVideo, convert = createLinkedVideoSticker): Promise<void> {
  await download(request.url, async path => {
    await send.video(path, request.url);
    if (!request.sticker) return;
    try {
      const result = await convert(path);
      if (result.trimmed) await send.text('Para a figurinha, usei os primeiros 10 segundos do vídeo.');
      await send.sticker(result.sticker);
    } catch {
      await send.text('O vídeo foi enviado, mas não consegui criar ou enviar a figurinha. Tente um trecho menor ou outro vídeo.');
    }
  }, undefined, { onRetry: async () => {
    const platform = request.url.includes('instagram.com/') ? 'O Instagram' : 'O Twitter/X';
    await send.text(`${platform} limitou o acesso. Vou aguardar alguns segundos e tentar mais uma vez.`);
  } });
}
