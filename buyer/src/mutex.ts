/**
 * buyer/src/mutex.ts — minimal async mutex for chain-touching critical sections.
 *
 * The shared transaction builder cannot pin wallet inputs, so two in-flight
 * transactions from one wallet can select the same UTxO. Callers that spend
 * from the buyer wallet run their Post → supplier → Accept sequence inside
 * `run` to keep those transactions serial.
 */

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive but swallow errors so one failure doesn't poison
    // the queue; callers observe the real result/throw via `result`.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
