/**
 * Per-match serial execution queue (T-12, reused by T-17).
 *
 * There is exactly one queue implementation. T-17 integrates this queue into
 * the runtime registry; it must not create a second one.
 *
 * Tasks for the same key run one after another in submission order. Different
 * keys run independently. A rejected task does not break the chain.
 */

export type MatchQueueTask<T> = () => Promise<T>;

/** Minimal serial queue contract used by the pipeline and the registry. */
export interface SerialQueue {
  run<T>(key: string, task: MatchQueueTask<T>): Promise<T>;
}

export class MatchQueue implements SerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: MatchQueueTask<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);

    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return result;
  }

  /** Number of matches with queued or running tasks. */
  get size(): number {
    return this.tails.size;
  }

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}

/** Shared default queue used by the action pipeline and runtime registry. */
export const matchQueue = new MatchQueue();
