// Shared helpers used by the web pipeline and aiService. Nothing here knows
// about a search vendor.

// ── Timing logs ─────────────────────────────────────────────────────────────
// Every phase logs in one greppable format: `[timing] <phase>: 12.3s (12341ms)`.
// A slow run can then be diagnosed from the server log instead of guessed at.
export function timingLog(label: string, startedAt: number, extra = ''): void {
  const ms = Date.now() - startedAt;
  console.log(`[timing] ${label}: ${(ms / 1000).toFixed(1)}s (${ms}ms)${extra}`);
}

// Like Promise.all(items.map(fn)), but never runs more than `limit` at a time.
// Results keep the order of `items`.
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
