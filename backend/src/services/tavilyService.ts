// Thin Tavily adapter: search and extract only. Built by getSearchProvider
// when Web Search mode runs and TAVILY_API_KEY is set, so the backend starts
// (and AI Generated mode works) without a Tavily key.
import { tavily } from '@tavily/core';
import type { SearchProvider } from './recipeSearch.js';

export function createTavilyProvider(apiKey: string): SearchProvider {
  const client = tavily({ apiKey });
  return {
    name: 'Tavily',
    failureHint: 'Check TAVILY_API_KEY and your Tavily credits.',
    // Errors are NOT swallowed here: the caller needs to tell "no result found"
    // (null) apart from "Tavily is broken" (bad key, out of credits, rate limited).
    async searchUrl(query, domain) {
      const res = await client.search(query, {
        maxResults: 1,
        searchDepth: 'basic',
        ...(domain ? { includeDomains: [domain] } : {}),
      });
      return res.results[0]?.url ?? null;
    },
    async extract(url) {
      try {
        const res = await client.extract([url]);
        return res.results[0]?.rawContent || null;
      } catch {
        return null;
      }
    },
  };
}
