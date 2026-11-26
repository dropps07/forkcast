// Keenable adapter (https://docs.keenable.ai/api-reference/search), the
// fallback plug when TAVILY_API_KEY is not set. Keyed with KEENABLE_API_KEY;
// otherwise the keyless endpoints are used by default (opt out with KEENABLE_KEYLESS=false).
// Keyless requests are rate limited per IP (docs.keenable.ai/rate-limits).
// Keyed and keyless requests are both logged under Keenable's default data
// policy; only Enterprise zero data retention differs (docs.keenable.ai/data-privacy).
import type { SearchProvider } from './recipeSearch.js';

const BASE_URL = 'https://api.keenable.ai';
const APP_TITLE = 'forkcast';
const TIMEOUT_MS = 15000;

interface KeenableSearchResponse {
  results?: { url?: string }[];
}

interface KeenableFetchResponse {
  // A page that could not be read comes back with `error` inside an HTTP 200.
  results?: { content?: string; error?: unknown }[];
}

export function createKeenableProvider(
  options: { apiKey?: string; fetchImpl?: typeof fetch } = {}
): SearchProvider {
  const { apiKey } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const suffix = apiKey ? '' : '/public';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  else headers['X-Keenable-Title'] = APP_TITLE;

  async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T | null }> {
    const res = await doFetch(`${BASE_URL}${path}${suffix}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, data };
  }

  return {
    name: 'Keenable',
    failureHint: apiKey
      ? 'Check KEENABLE_API_KEY and your Keenable balance.'
      : 'Keenable keyless search is rate limited per IP; try again later or set KEENABLE_API_KEY.',
    async searchUrl(query, domain) {
      const { status, data } = await post<KeenableSearchResponse>('/v1/search', {
        query,
        max_results: 1,
        ...(domain ? { site: domain } : {}),
      });
      if (status !== 200 || !data) throw new Error(`Keenable search failed: HTTP ${status}`);
      return data.results?.find((r) => r.url)?.url ?? null;
    },
    async extract(url) {
      try {
        const { status, data } = await post<KeenableFetchResponse>('/v1/fetch', { urls: [url] });
        const page = data?.results?.[0];
        if (status !== 200 || !page || page.error) return null;
        return page.content || null;
      } catch {
        return null;
      }
    },
  };
}
