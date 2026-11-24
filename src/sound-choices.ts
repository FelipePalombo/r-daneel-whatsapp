/** A espera por resposta não ocupa a fila de conversão. */
export class SoundChoices {
  private readonly pending = new Map<string, { chat: string; timer: ReturnType<typeof setTimeout>; resolve: (sound: boolean, expired: boolean) => void }>();
  constructor(private readonly limit = 3, private readonly timeoutMs = 15_000) {}
  get size(): number { return this.pending.size; }
  add(chat: string, questionId: string, resolve: (sound: boolean, expired: boolean) => void): boolean {
    const key = `${chat}\u0000${questionId}`;
    if (!chat || !questionId || this.pending.size >= this.limit || this.pending.has(key)) return false;
    const timer = setTimeout(() => this.finish(key, false, true), this.timeoutMs);
    this.pending.set(key, { chat, timer, resolve });
    return true;
  }
  respond(chat: string, text: string, quotedId?: string): 'accepted' | 'ambiguous' | 'unmatched' {
    const candidates = [...this.pending.entries()].filter(([, value]) => value.chat === chat);
    if (!candidates.length) return 'unmatched';
    let entry: (typeof candidates)[number] | undefined;
    if (quotedId) entry = candidates.find(([key]) => key === `${chat}\u0000${quotedId}`);
    else if (candidates.length === 1) entry = candidates[0];
    else return 'ambiguous';
    if (!entry) return 'unmatched';
    this.finish(entry[0], text.trim().toLowerCase() === '!som', false);
    return 'accepted';
  }
  close(): void {
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.pending.clear();
  }
  private finish(key: string, sound: boolean, expired: boolean): void {
    const item = this.pending.get(key);
    if (!item) return;
    clearTimeout(item.timer);
    this.pending.delete(key);
    item.resolve(sound, expired);
  }
}
