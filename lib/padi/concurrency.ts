import "server-only";

// Small fixed-concurrency map -- no existing concurrency-limiter utility elsewhere in this repo,
// and pulling in a dependency for this isn't warranted. Shared by lib/padi/sync.ts and
// lib/padi/backup.ts, which both walk the same paginated PADI logbook detail endpoint.
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
