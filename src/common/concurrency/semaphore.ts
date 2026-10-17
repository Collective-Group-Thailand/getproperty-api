/**
 * A FIFO counting semaphore for in-process work that holds a pooled database connection while it waits on a row
 * lock (B4.3: invoice issues queue on the gapless series row; their transactions also read settings through other
 * connections, so letting every request in at once can exhaust the pool).
 */
export class Semaphore {
  private readonly waiting: (() => void)[] = [];
  private active = 0;

  constructor(private readonly slots: number) {
    if (slots < 1) throw new RangeError('a semaphore needs at least one slot');
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.slots) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
