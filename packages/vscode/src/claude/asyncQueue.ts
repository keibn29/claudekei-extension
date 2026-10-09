/** Minimal async queue used as the streaming-input prompt iterable of a Query. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  /** Pushes an item. Ignored after `end()`. */
  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  /** Ends the iteration once queued items are consumed. */
  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/** Prompt iterable that never yields and never ends: keeps a streaming query alive without a user message. */
export function neverYieldingPrompt<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<T>>(() => undefined) };
    },
  };
}
