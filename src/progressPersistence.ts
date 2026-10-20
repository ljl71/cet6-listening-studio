import type { Progress } from './types';

const contentKey = (progress: Progress) => JSON.stringify([
  progress.position, progress.rate, progress.sentenceId ?? null, progress.loopMode ?? 'off',
]);

/** Deduplicate against confirmed disk writes, never optimistic UI state.
 * Queued saves compare at execution time so pause/ticker duplicates can merge
 * only after an earlier write actually succeeds. Failed requests remain retryable. */
export function createProgressPersistence(
  send: (progress: Progress, immediate: boolean) => Promise<void>,
  onFailure: (error: unknown) => void,
) {
  const successful = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();
  const initialize = (records: Progress[]) => {
    for (const record of records) if (!successful.has(record.paperId)) successful.set(record.paperId, contentKey(record));
  };
  const reset = (records: Progress[]) => { successful.clear(); initialize(records); };
  const save = (progress: Progress, immediate = false): Promise<void> => {
    // Snapshot caller-owned data: a queued write always describes the exact
    // position observed when it was requested, even if the caller later edits it.
    const snapshot = { ...progress }, key = contentKey(snapshot);
    const write = async () => {
      if (successful.get(snapshot.paperId) === key) return;
      try { await send(snapshot, immediate); successful.set(snapshot.paperId, key); }
      catch (error) { onFailure(error); }
    };
    // pagehide keepalive must start promptly rather than wait behind a fetch
    // whose completion could occur after the page is gone.
    if (immediate) return write();
    queue = queue.then(write, write); return queue;
  };
  return { initialize, reset, save };
}
