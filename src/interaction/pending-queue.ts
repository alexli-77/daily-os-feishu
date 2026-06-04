export class PendingQueue<T> {
  private readonly batches = new Map<string, T[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly blocked = new Set<string>();

  constructor(
    private readonly debounceMs: number,
    private readonly onFlush: (scope: string, batch: T[]) => void,
  ) {}

  push(scope: string, item: T): number {
    const batch = this.batches.get(scope) ?? [];
    batch.push(item);
    this.batches.set(scope, batch);
    if (!this.blocked.has(scope)) this.arm(scope);
    return batch.length;
  }

  block(scope: string): void {
    this.blocked.add(scope);
    this.clearTimer(scope);
  }

  unblock(scope: string): void {
    this.blocked.delete(scope);
    if ((this.batches.get(scope)?.length ?? 0) > 0) this.arm(scope);
  }

  private arm(scope: string): void {
    this.clearTimer(scope);
    this.timers.set(
      scope,
      setTimeout(() => {
        this.timers.delete(scope);
        if (this.blocked.has(scope)) return;
        const batch = this.batches.get(scope) ?? [];
        this.batches.delete(scope);
        if (batch.length > 0) this.onFlush(scope, batch);
      }, this.debounceMs),
    );
  }

  private clearTimer(scope: string): void {
    const timer = this.timers.get(scope);
    if (timer) clearTimeout(timer);
    this.timers.delete(scope);
  }
}
