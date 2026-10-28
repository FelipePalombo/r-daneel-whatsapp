export type JobReservation = { submit: (work: () => Promise<void>) => void; cancel: () => void };

/** Reservas incluem lotes em coleta, tarefas aguardando e a tarefa em execução. */
export class JobQueue {
  private count = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly limit = 3, private readonly onError: () => void = () => {}) {}
  get pending(): number { return this.count; }
  get idle(): Promise<void> { return this.tail; }
  reserve(): JobReservation | undefined {
    if (this.count >= this.limit) return;
    this.count++;
    let state: 'reserved' | 'submitted' | 'released' = 'reserved';
    return {
      submit: work => {
        if (state !== 'reserved') return;
        state = 'submitted';
        this.tail = this.tail.then(work).catch(() => { this.onError(); }).finally(() => { this.count--; });
      },
      cancel: () => { if (state === 'reserved') { state = 'released'; this.count--; } },
    };
  }
}
