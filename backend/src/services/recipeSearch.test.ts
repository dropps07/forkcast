import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichRecipes,
  getSearchProvider,
  normalizeDomain,
  requireSearchProvider,
  type RecipeSlot,
  type SearchProvider,
} from './recipeSearch.js';
import { createKeenableProvider } from './keenableService.js';
import { extractRecipeContent, windowRecipeText, EXTRACT_WINDOW } from './recipeExtract.js';
import { mapWithLimit } from './utils.js';

// Importing aiService must work without any search key (AI Generated mode).
// The npm test script sets only GEMINI_API_KEY.
import './aiService.js';

const slot = (recipeName: string, sourceSite = 'https://www.example.com/recipes'): RecipeSlot => ({
  day: 'Monday', date: '2026-11-30', mealType: 'dinner', recipeName, cuisineHint: '', sourceSite,
});

function stubProvider(overrides: Partial<SearchProvider> = {}): SearchProvider & { queries: [string, string][] } {
  const queries: [string, string][] = [];
  return {
    name: 'Stub',
    failureHint: 'Check the stub.',
    queries,
    async searchUrl(query, domain) { queries.push([query, domain]); return null; },
    async extract() { return null; },
    ...overrides,
  };
}

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500, body: null };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('getSearchProvider', () => {
  it('falls back to keyless Keenable with no keys, so a fresh clone can use Web Search', () => {
    assert.equal(getSearchProvider({})?.name, 'Keenable');
    assert.equal(requireSearchProvider({}).name, 'Keenable');
  });
  it('prefers Tavily whenever TAVILY_API_KEY is set', () => {
    assert.equal(getSearchProvider({ TAVILY_API_KEY: 't', KEENABLE_API_KEY: 'k' })?.name, 'Tavily');
  });
  it('falls back to keyed Keenable', () => {
    const p = getSearchProvider({ KEENABLE_API_KEY: 'k' });
    assert.equal(p?.name, 'Keenable');
    assert.match(p?.failureHint ?? '', /KEENABLE_API_KEY/);
  });
  it('opts out of keyless Keenable when KEENABLE_KEYLESS is false', () => {
    assert.equal(getSearchProvider({ KEENABLE_KEYLESS: 'false' }), null);
    assert.throws(() => requireSearchProvider({ KEENABLE_KEYLESS: 'false' }), /KEENABLE_KEYLESS/);
    assert.equal(getSearchProvider({ KEENABLE_KEYLESS: 'true' })?.name, 'Keenable');
  });
});

describe('Keenable adapter', () => {
  it('keyed search posts to /v1/search with the site filter', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { results: [{ url: 'https://example.com/r' }] } }]);
    const p = createKeenableProvider({ apiKey: 'k', fetchImpl: impl });
    assert.equal(await p.searchUrl('dal recipe', 'example.com'), 'https://example.com/r');
    assert.equal(calls[0]?.url, 'https://api.keenable.ai/v1/search');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['X-API-Key'], 'k');
    assert.equal(headers['X-Keenable-Title'], undefined);
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { query: 'dal recipe', max_results: 1, site: 'example.com' });
  });
  it('keyless search uses /public and the title header', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { results: [] } }]);
    const p = createKeenableProvider({ fetchImpl: impl });
    assert.equal(await p.searchUrl('dal recipe', ''), null);
    assert.equal(calls[0]?.url, 'https://api.keenable.ai/v1/search/public');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['X-Keenable-Title'], 'forkcast');
    assert.equal(headers['X-API-Key'], undefined);
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { query: 'dal recipe', max_results: 1 });
  });
  it('search throws on a provider error so enrichRecipes can count it', async () => {
    const { impl } = fakeFetch([{ status: 429, body: { error: 'rate limited' } }]);
    await assert.rejects(createKeenableProvider({ fetchImpl: impl }).searchUrl('q', ''), /HTTP 429/);
  });
  it('extract posts {urls} and returns content', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { results: [{ url: 'u', content: 'Ingredients: dal' }] } }]);
    const p = createKeenableProvider({ apiKey: 'k', fetchImpl: impl });
    assert.equal(await p.extract('https://example.com/r'), 'Ingredients: dal');
    assert.equal(calls[0]?.url, 'https://api.keenable.ai/v1/fetch');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { urls: ['https://example.com/r'] });
  });
  it('extract treats a per-URL error inside HTTP 200 as no content', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { results: [{ url: 'u', error: 'Not found' }] } }]);
    assert.equal(await createKeenableProvider({ fetchImpl: impl }).extract('https://example.com/r'), null);
  });
});

describe('enrichRecipes', () => {
  it('uses the given provider with a normalized domain', async () => {
    const provider = stubProvider();
    const out = await enrichRecipes([slot('Dal')], provider);
    assert.deepEqual(provider.queries, [['Dal recipe', 'example.com']]);
    assert.equal(out[0]?.sourceUrl, null);
    assert.equal(out[0]?.content, null);
  });
  it('throws with the provider hint when every search fails', async () => {
    const provider = stubProvider({ async searchUrl() { throw new Error('401'); } });
    await assert.rejects(enrichRecipes([slot('A'), slot('B')], provider), /every recipe\. Check the stub\./);
  });
});

describe('recipeExtract', () => {
  const jsonLd = (recipe: object) =>
    `<html><script type="application/ld+json">${JSON.stringify(recipe)}</script></html>`;

  it('prefers JSON-LD and skips the fallback', async () => {
    let fallbackCalls = 0;
    const html = jsonLd({
      '@type': 'Recipe', name: 'Dal', image: 'https://img.example.com/dal.jpg',
      recipeIngredient: ['1 cup toor dal', '2 cups water', '1 tsp turmeric'],
      recipeInstructions: [{ '@type': 'HowToStep', text: 'Boil the dal with water and turmeric.' }],
    });
    const out = await extractRecipeContent('https://example.com/r', {
      fetchHtml: async () => html,
      extractFallback: async () => { fallbackCalls++; return 'x'; },
    });
    assert.match(out.content ?? '', /Ingredients:\n- 1 cup toor dal/);
    assert.equal(out.imageUrl, 'https://img.example.com/dal.jpg');
    assert.equal(fallbackCalls, 0);
  });
  it('uses the fallback text when there is no JSON-LD, and none without a fallback', async () => {
    const opts = { fetchHtml: async () => '<html></html>' };
    assert.equal((await extractRecipeContent('https://e.com', { ...opts, extractFallback: async () => 'Ingredients: rice' })).content, 'Ingredients: rice');
    assert.equal((await extractRecipeContent('https://e.com', opts)).content, null);
  });
  it('windows long fallback text around the ingredients', () => {
    const text = 'a'.repeat(10000) + 'Ingredients' + 'b'.repeat(10000);
    const out = windowRecipeText(text) ?? '';
    assert.equal(out.length, EXTRACT_WINDOW);
    assert.ok(out.includes('Ingredients'));
    assert.equal(normalizeDomain('https://www.Example.com/recipes'), 'example.com');
  });
});

describe('mapWithLimit', () => {
  it('keeps order and never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithLimit([3, 1, 2, 5, 4], 2, async (n) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    assert.deepEqual(out, [30, 10, 20, 50, 40]);
    assert.ok(peak <= 2);
  });
});
