import type { WAMessage } from '@whiskeysockets/baileys';
import { authorizationStatus, isStickerCommand, messageContent, messageText } from './request.js';
import type { JobQueue, JobReservation } from './job-queue.js';

export const MAX_BATCH_PHOTOS = 10;
const MAX_OBSERVED_ITEMS = 1000;
export type PhotoBatch = {
  photos: WAMessage[];
  incomplete: boolean;
  overLimit: boolean;
  mixed: boolean;
};
export type AlbumClock = {
  now: () => number;
  set: (action: () => void, ms: number) => unknown;
  clear: (timer: unknown) => void;
};
const clock: AlbumClock = {
  now: Date.now,
  set: (action, ms) => setTimeout(action, ms),
  clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
type Photo = { message: WAMessage; index?: number; order: number };
type Album = {
  reservation: JobReservation;
  photos: Photo[];
  seen: Set<string>;
  photoCount: number;
  command: boolean;
  mixed: boolean;
  expected?: number;
  expectedImages?: number;
  quiet?: unknown;
  hard: unknown;
};

/** O vínculo explícito MEDIA_ALBUM é obrigatório; nunca agrupa por horário. */
function albumDescriptor(m: WAMessage) {
  const content = messageContent(m);
  if (!content) return;
  if (content.albumMessage) return { id: m.key.id!, header: content.albumMessage, index: undefined };
  if (!content.imageMessage && !content.videoMessage) return;
  let level = m.message;
  for (let depth = 0; depth <= 5; depth++) {
    const association = level?.messageContextInfo?.messageAssociation;
    if (association?.associationType === 1) {
      const parent = association.parentMessageKey;
      if (!parent?.id || parent.id.length > 256 || parent.fromMe || parent.id === m.key.id ||
          (parent.remoteJid && parent.remoteJid !== m.key.remoteJid && parent.remoteJid !== m.key.remoteJidAlt)) return;
      const index = association.messageIndex;
      return { id: parent.id, header: undefined,
        index: typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index < MAX_OBSERVED_ITEMS ? index : undefined };
    }
    const nested = level?.ephemeralMessage?.message ?? level?.documentWithCaptionMessage?.message ?? level?.associatedChildMessage?.message;
    if (!nested) return;
    level = nested;
  }
}
function validCount(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_OBSERVED_ITEMS;
}
function comparePhotos(a: Photo, b: Photo): number {
  return (a.index ?? a.order) - (b.index ?? b.order) || a.order - b.order;
}

export class PhotoAlbumCollector {
  private readonly albums = new Map<string, Album>();
  private readonly recent = new Map<string, { at: number; busy: boolean; warned: boolean }>();
  private stopped = false;
  constructor(private readonly allowed: readonly string[], private readonly queue: JobQueue,
    private readonly ready: (batch: PhotoBatch) => Promise<void>, private readonly busy: (message: WAMessage) => void,
    private readonly time: AlbumClock = clock) {}
  get collecting(): number { return this.albums.size; }

  /** true: mensagem pertence ao coletor. false: continuar no fluxo individual. */
  offer(message: WAMessage): boolean {
    if (this.stopped || authorizationStatus(message, this.allowed)) return false;
    const descriptor = albumDescriptor(message);
    if (!descriptor) return false;
    const content = messageContent(message)!;
    const photo = content.imageMessage && content.imageMessage.mimetype !== 'image/gif';
    const command = !!photo && isStickerCommand(content.imageMessage?.caption);
    const independent = !descriptor.header && messageText(message).trim().startsWith('!') && !command;
    const key = `${message.key.remoteJid}:${descriptor.id}`;
    for (const [id, value] of this.recent) if (this.time.now() - value.at > 600_000) this.recent.delete(id);
    const closed = this.recent.get(key);
    if (closed) {
      if (closed.busy && command && !closed.warned) { closed.warned = true; this.busy(message); }
      return !independent;
    }
    let album = this.albums.get(key);
    if (!album) {
      const reservation = this.queue.reserve();
      if (!reservation) {
        this.remember(key, true, command);
        if (command) this.busy(message);
        return !independent;
      }
      album = { reservation, photos: [], seen: new Set(), photoCount: 0, command: false, mixed: false,
        hard: this.time.set(() => this.finish(key), 15_000) };
      this.albums.set(key, album);
    }
    if (descriptor.header) {
      const images = descriptor.header.expectedImageCount;
      const videos = descriptor.header.expectedVideoCount ?? 0;
      if (validCount(images) && validCount(videos) && images + videos > 0 && images + videos <= MAX_OBSERVED_ITEMS) {
        album.expected = images + videos;
        album.expectedImages = images;
        album.mixed ||= videos > 0;
      }
    } else {
      if (album.seen.has(message.key.id!)) return !independent;
      if (album.seen.size >= MAX_OBSERVED_ITEMS) return !independent;
      album.seen.add(message.key.id!);
      if (photo && !independent) {
        album.photoCount++;
        album.command ||= command;
        const entry = { message, index: descriptor.index, order: album.seen.size };
        album.photos.push(entry);
        // Guarda só dez mensagens, mesmo em álbuns maiores.
        album.photos.sort(comparePhotos);
        album.photos.length = Math.min(album.photos.length, MAX_BATCH_PHOTOS);
      } else if (!photo) album.mixed = true;
    }
    if (album.expected !== undefined && album.seen.size >= album.expected) this.finish(key);
    else if (album.expected === undefined) {
      if (album.quiet !== undefined) this.time.clear(album.quiet);
      album.quiet = this.time.set(() => this.finish(key), 3000);
    } else if (album.quiet !== undefined) { this.time.clear(album.quiet); album.quiet = undefined; }
    return !independent;
  }
  private remember(key: string, busy: boolean, warned: boolean) {
    this.recent.set(key, { at: this.time.now(), busy, warned });
    if (this.recent.size > 300) this.recent.delete(this.recent.keys().next().value!);
  }
  private finish(key: string) {
    const album = this.albums.get(key);
    if (!album) return;
    this.albums.delete(key);
    this.time.clear(album.hard);
    if (album.quiet !== undefined) this.time.clear(album.quiet);
    this.remember(key, false, false);
    const photos = album.photos.sort(comparePhotos).map(photo => photo.message);
    if (!album.command || !photos.length) { album.reservation.cancel(); return; }
    const batch = { photos, mixed: album.mixed, incomplete: album.expected !== undefined && album.seen.size < album.expected,
      overLimit: album.photoCount > MAX_BATCH_PHOTOS || (album.expectedImages ?? 0) > MAX_BATCH_PHOTOS };
    album.reservation.submit(() => this.ready(batch));
  }
  close() {
    this.stopped = true;
    for (const album of this.albums.values()) {
      this.time.clear(album.hard);
      if (album.quiet !== undefined) this.time.clear(album.quiet);
      album.reservation.cancel();
    }
    this.albums.clear(); this.recent.clear();
  }
}

export async function sendPhotoBatch(batch: PhotoBatch, send: {
  text: (text: string) => Promise<void>;
  sticker: (sticker: Buffer, original: WAMessage) => Promise<void>;
}, prepare: (message: WAMessage) => Promise<Buffer>): Promise<void> {
  const notes = [batch.overLimit ? 'O limite é 10 fotos por lote; vou converter somente as primeiras 10 disponíveis.' : '',
    batch.mixed ? 'O lote converte somente fotos; envie vídeos/GIFs separadamente com o comando.' : '',
    batch.incomplete ? 'Nem todos os itens do álbum chegaram; vou processar as fotos recebidas.' : ''].filter(Boolean);
  await send.text(`Recebi ${batch.photos.length} foto(s). Vou criar uma figurinha por foto, uma de cada vez.${notes.length ? '\n' + notes.join('\n') : ''}`);
  let sent = 0;
  for (const [index, original] of batch.photos.entries()) {
    try { await send.sticker(await prepare(original), original); sent++; }
    catch { await send.text(`Não consegui converter ou enviar a foto ${index + 1} do lote. Vou continuar com as demais.`).catch(() => {}); }
  }
  if (sent < batch.photos.length) await send.text(`Lote concluído: ${sent} de ${batch.photos.length} figurinhas enviadas.`);
}
