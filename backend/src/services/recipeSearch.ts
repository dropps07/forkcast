// Web Search mode: find each planned recipe on its source site, then pull the
// recipe out of the page. The search vendor is a plug (SearchProvider); the
// pipeline here does not import any vendor SDK.

import { createKeenableProvider } from './keenableService.js';
import { extractRecipeContent, NOTHING_EXTRACTED } from './recipeExtract.js';
import { createTavilyProvider } from './tavilyService.js';
import { mapWithLimit, timingLog } from './utils.js';

// How many searches / page downloads run at once. Keeps us inside the
// provider's rate limits and stops us hitting a recipe site with 20 requests
// in the same instant.
const SEARCH_CONCURRENCY = 5;
const EXTRACT_CONCURRENCY = 5;

export interface SearchProvider {
  name: string;
  // Best URL for the query on `domain` (empty = any site), or null when
  // nothing was found. Throws when the provider itself fails (bad key, no
  // credits, rate limited), so the caller can tell the two apart.
  searchUrl(query: string, domain: string): Promise<string | null>;
  // Page text for sites without JSON-LD, or null. Never throws.
  extract(url: string): Promise<string | null>;
  // Shown when every search failed.
  failureHint: string;
}

export interface RecipeSlot {
  day: string;
  date: string;
  mealType: string;
  recipeName: string;
  cuisineHint: string;
  sourceSite: string;
}

export interface EnrichedRecipe extends RecipeSlot {
  sourceUrl: string | null;
  imageUrl: string | null;
  content: string | null;
}

// Gemini may answer "https://www.seriouseats.com/recipes" where a site filter wants "seriouseats.com".
export function normalizeDomain(site: string): string {
  return site
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0] ?? '';
}

function isOff(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes((value ?? '').trim().toLowerCase());
}

// Built only when Web Search mode runs. Tavily whenever TAVILY_API_KEY is set;
// otherwise Keenable as the fallback plug, with KEENABLE_API_KEY or, by default,
// the keyless endpoints. Set KEENABLE_KEYLESS=false to opt out. null only
// when the user has opted out (AI Generated mode never needs a provider).
export function getSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider | null {
  const tavilyKey = env.TAVILY_API_KEY?.trim();
  if (tavilyKey) return createTavilyProvider(tavilyKey);
  const keenableKey = env.KEENABLE_API_KEY?.trim();
  if (keenableKey) return createKeenableProvider({ apiKey: keenableKey });
  if (!isOff(env.KEENABLE_KEYLESS)) return createKeenableProvider({});
  return null;
}

export const NO_PROVIDER_MESSAGE =
  'Web Search mode has no search provider: set TAVILY_API_KEY or KEENABLE_API_KEY, ' +
  'or leave KEENABLE_KEYLESS at its default. See backend/.env.example.';

export function requireSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  const provider = getSearchProvider(env);
  if (!provider) throw new Error(NO_PROVIDER_MESSAGE);
  return provider;
}

export async function enrichRecipes(
  slots: RecipeSlot[],
  provider: SearchProvider,
  onProgress?: (msg: string) => void
): Promise<EnrichedRecipe[]> {
  const total = slots.length;

  // Wave 1: find a recipe URL for every slot (a few at a time)
  let searched = 0;
  let failedSearches = 0;
  const searchStarted = Date.now();
  const urls = await mapWithLimit(slots, SEARCH_CONCURRENCY, async (slot) => {
    let url: string | null = null;
    try {
      url = await provider.searchUrl(`${slot.recipeName} recipe`, normalizeDomain(slot.sourceSite));
    } catch (err) {
      failedSearches++;
      console.warn(`${provider.name} search failed for "${slot.recipeName}":`, err instanceof Error ? err.message : err);
    }
    onProgress?.(`Searching recipes… (${++searched}/${total})`);
    return url;
  });
  timingLog(`${provider.name.toLowerCase()} search`, searchStarted, ` (${urls.filter(Boolean).length}/${total} urls, ${failedSearches} failed)`);

  // One failed search is fine (that meal falls back to Gemini's own knowledge).
  // But if EVERY search failed, something is wrong with the key, the credits or
  // the rate limit: say so instead of quietly returning an AI-only plan.
  if (total > 0 && failedSearches === total) {
    throw new Error(`Recipe search failed for every recipe. ${provider.failureHint}`);
  }

  // Wave 2: download + extract each found page (a few at a time)
  onProgress?.('Retrieving recipe details…');
  let retrieved = 0;
  const extractStarted = Date.now();
  const extracted = await mapWithLimit(urls, EXTRACT_CONCURRENCY, async (url) => {
    const result = url
      ? await extractRecipeContent(url, { extractFallback: provider.extract }).catch(() => NOTHING_EXTRACTED)
      : NOTHING_EXTRACTED;
    onProgress?.(`Retrieving recipe details… (${++retrieved}/${total})`);
    return result;
  });
  timingLog(`${provider.name.toLowerCase()} extract`, extractStarted);

  return slots.map((slot, i) => ({
    ...slot,
    sourceUrl: urls[i] ?? null,
    imageUrl: extracted[i]?.imageUrl ?? null,
    content: extracted[i]?.content ?? null,
  }));
}
