import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { enrichRecipes, requireSearchProvider, type RecipeSlot, type EnrichedRecipe } from './recipeSearch.js';
import { mapWithLimit, timingLog } from './utils.js';
import { usageTracker } from './usageTracker.js';
import {
  DayMealSchema,
  RegenMealSchema,
  RecipeSlotSchema,
  type LlmRecipe,
} from './recipeSchema.js';

// Fail fast with a clear message instead of an obscure error on the first request.
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is not set (see .env.example)');

const client = new GoogleGenAI({ apiKey });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Used after the main model answers "overloaded" (HTTP 503). Pick a lighter model from AI Studio.
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
// Base wait between retries; attempt n waits n x this. (Only lower it when testing.)
const RETRY_BASE_MS = Number(process.env.GEMINI_RETRY_MS) || 10_000;
// One Gemini attempt gets this long before it counts as failed. A hung call
// used to block the whole plan forever; now it fails as a retryable error
// and goes through the same retry/backoff path as a 429/503.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 180_000;

export interface SlotToGenerate {
  day: string;
  date: string;
  mealType: string;
}

interface ExistingMeal {
  mealType: string;
  name: string;
  macros: { calories: number; carbohydrates: number; protein: number; fats: number; sugar: number };
}

interface DayContext {
  day: string;
  meals: ExistingMeal[];
}

export interface MealPlanRequest {
  cuisines: string[];
  equipment: string[];
  macros: { maxCalories: number; maxCarbs: number; maxFats: number; minFiber: number; minProtein: number };
  dietary: {
    maxSodium: number;
    allergens: string[];
    isVegetarian: boolean;
    isVegan: boolean;
    // Optional: older clients may not send these.
    isNonVegetarian?: boolean;
    isHalal?: boolean;
    isKosher?: boolean;
    maxSugar: number;
  };
  maxPrepTime: number;
  maxCookTime: number;
  mealsPerDay: number;
  leftovers: string;
  otherPreferences: string;
  blacklist: string[];
  startDate?: string;
  numDays?: number;
  pinnedRecipes?: { name: string; cuisineHint: string; mealType: string }[];
  slotsToGenerate?: SlotToGenerate[];
  existingDayMeals?: DayContext[];
  searchMode?: 'web' | 'training';
}

// The recipe after the backend enriches it (source/image URLs from the
// web pipeline, or the aiGenerated stamp from the training pipeline).
// The zod schema validates the core LLM shape; these fields are added
// after validation, so they are optional here.
type ValidatedRecipe = LlmRecipe & {
  sourceUrl?: string | null;
  imageUrl?: string | null;
  aiGenerated?: boolean;
};

interface DayMeal {
  mealType: string;
  recipe: ValidatedRecipe;
}

interface PlannedDay {
  day: string;
  date: string;
  meals: DayMeal[];
}

interface RegenMeal {
  day: string;
  date: string;
  mealType: string;
  recipe: ValidatedRecipe;
}

export interface MealPlanResult {
  weekOf: string;
  mealPlan: PlannedDay[];
  shoppingList: unknown[];
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function getMealTypes(mealsPerDay: number): string[] {
  const plans: Record<number, string[]> = {
    1: ['dinner'],
    2: ['breakfast', 'dinner'],
    3: ['breakfast', 'lunch', 'dinner'],
    4: ['breakfast', 'lunch', 'snack', 'dinner'],
    5: ['breakfast', 'morning snack', 'lunch', 'afternoon snack', 'dinner'],
    6: ['breakfast', 'morning snack', 'lunch', 'afternoon snack', 'dinner', 'evening snack'],
  };
  return plans[mealsPerDay] ?? ['breakfast', 'lunch', 'dinner'];
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Works in UTC throughout so the server's timezone can't shift a date by a day.
export function getPlanDates(startDate?: string, numDays?: number) {
  const count = Math.min(Math.max(numDays ?? 7, 1), 7);
  const [y, m, d] = startDate ? startDate.split('-').map(Number) : [];
  const now = new Date();
  const start = new Date(Date.UTC(y ?? now.getFullYear(), (m ?? now.getMonth() + 1) - 1, d ?? now.getDate()));
  const days = Array.from({ length: count }, (_, i) => {
    const x = new Date(start);
    x.setUTCDate(x.getUTCDate() + i);
    return { day: DAY_NAMES[x.getUTCDay()] ?? 'Monday', date: x.toISOString().split('T')[0] ?? '' };
  });
  return { weekOf: days[0]?.date ?? '', days };
}

function preferenceSummary(req: MealPlanRequest): string {
  const dietaryFlags = [
    req.dietary.isVegan && 'Vegan',
    req.dietary.isVegetarian && !req.dietary.isVegan && 'Vegetarian',
    req.dietary.isNonVegetarian && !req.dietary.isVegetarian && !req.dietary.isVegan && 'Non-vegetarian',
    req.dietary.isHalal && 'Halal',
    req.dietary.isKosher && 'Kosher',
  ].filter(Boolean);

  return [
    `Cuisine: ${req.cuisines.length ? req.cuisines.join(', ') : 'Any'}`,
    `Equipment: ${req.equipment.length ? req.equipment.join(', ') : 'Standard kitchen'}`,
    `Daily calorie limit: ${req.macros.maxCalories} kcal`,
    `Daily protein: ≥${req.macros.minProtein}g | Daily carbs: ≤${req.macros.maxCarbs}g | Daily fat: ≤${req.macros.maxFats}g | Daily fiber: ≥${req.macros.minFiber}g`,
    `Daily sodium: ≤${req.dietary.maxSodium}mg | Daily sugar: ≤${req.dietary.maxSugar}g`,
    dietaryFlags.length ? `Diet: ${dietaryFlags.join(', ')}` : '',
    `Max prep time per recipe: ${req.maxPrepTime} min | Max cook time per recipe: ${req.maxCookTime} min`,
    req.leftovers ? `Ingredients to use up (include each in 1–2 recipes across the week, not in every meal): ${req.leftovers}` : '',
    req.otherPreferences ? `Other preferences: ${req.otherPreferences}` : '',
    req.blacklist.length ? `Do NOT use these recent recipes: ${req.blacklist.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export function parseJSON(text: string): unknown {
  let t = text.trim();

  // Strip markdown code fences
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  // If there's prose before the JSON, find the first structural character
  const firstBracket = t.indexOf('[');
  const firstBrace   = t.indexOf('{');
  const jsonStart =
    firstBracket === -1 ? firstBrace :
    firstBrace   === -1 ? firstBracket :
    Math.min(firstBracket, firstBrace);

  if (jsonStart > 0) t = t.slice(jsonStart);

  // Trim any trailing prose after the closing bracket/brace
  const lastBracket = t.lastIndexOf(']');
  const lastBrace   = t.lastIndexOf('}');
  const jsonEnd = Math.max(lastBracket, lastBrace);
  if (jsonEnd !== -1 && jsonEnd < t.length - 1) t = t.slice(0, jsonEnd + 1);

  try {
    return JSON.parse(t);
  } catch {
    throw new SyntaxError(`JSON parse failed. Raw response:\n\n${t}`);
  }
}

// ── Model chain ─────────────────────────────────────────────────────────────
// One request is tried against each link in order. On a retryable failure
// (429, 503, timeout) the next attempt uses the NEXT link, never the same
// model — a daily-quota 429 is not transient, so it advances immediately
// instead of retrying the exhausted model. When every link has failed, the
// call fails fast with the models tried; the chain never cycles back to
// the start and never keeps retrying into the wall. The Gemini daily quota
// (20/day per model) resets at midnight PT.
export type ChainLink =
  | { provider: 'gemini'; model: string }
  | { provider: 'groq'; model: string };

// Gemini links, in order. GEMINI_MODELS is a comma-separated list; when it
// is unset the two existing vars are used (primary, then fallback).
// Duplicates are dropped, so a primary that equals the fallback (as on
// Ajey's Mac right now, where both are the lite model) is only tried once.
const GEMINI_MODELS: string[] = (process.env.GEMINI_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const geminiModels =
  GEMINI_MODELS.length > 0
    ? [...new Set(GEMINI_MODELS)]
    : [...new Set([GEMINI_MODEL, GEMINI_FALLBACK_MODEL])];

const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Build the chain from its parts. Exported so the harness can check the
// order and the Groq-skip rule without re-importing the module.
export function buildChain(geminiModels: string[], groqModel: string, groqApiKey?: string): ChainLink[] {
  const links: ChainLink[] = geminiModels.map((model) => ({ provider: 'gemini', model }));
  if (groqApiKey) links.push({ provider: 'groq', model: groqModel });
  return links;
}

const CHAIN: ChainLink[] = buildChain(geminiModels, GROQ_MODEL, GROQ_API_KEY);
console.log(`[chain] Model chain: ${CHAIN.map((l) => l.model).join(' → ')}`);
if (!GROQ_API_KEY) {
  console.log('[chain] Groq link skipped — GROQ_API_KEY is not set. Set it to add the Groq model as the final backup.');
}

// A validation failure means the model returned well-formed JSON that
// doesn't match the expected shape (bad macros, missing fields, absurd
// values). The next link may do better, so treat it like a 503: advance
// the chain instead of failing outright.
const VALIDATION_FAILED = /validation failed/i;

// Gemini answers 429 when you pass the free tier's rate limit and 503 when
// the model is overloaded; Groq answers the same codes. Both pass, so wait
// and advance to the next link. A 400 is fatal — the request itself is bad,
// so another model would not help (and the lite-model thinkingConfig 400
// is already handled by thinkingConfigFor, not by switching).
const RETRYABLE = /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE/;
const OVERLOADED = /\b503\b|UNAVAILABLE/;
const TIMEOUT = /timed out after \d+ms/;

export type FailureKind = 'timeout' | '503' | '429' | 'fatal';

// Classify a failure message from any link in the chain. Exported for the
// harness.
export function classifyFailure(message: string): FailureKind {
  if (TIMEOUT.test(message)) return 'timeout';
  if (VALIDATION_FAILED.test(message)) return '503';
  if (!RETRYABLE.test(message)) return 'fatal';
  return OVERLOADED.test(message) ? '503' : '429';
}

// A daily-quota 429: the free tier's per-day request cap for that model
// (Gemini's message says "per day limit exceeded"). Unlike a per-minute
// 429, waiting does not help — the model is done until the quota resets.
export function isDailyQuotaError(message: string): boolean {
  return /\b429\b/.test(message) && /per day/i.test(message);
}

// Races a promise against a timer. The loser keeps running in the background
// (the SDK call has no cancel), but its result is discarded. Exported so the
// timeout behaviour can be verified without calling the real API.
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`AI call timed out after ${ms}ms (${label})`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// thinkingConfig is only ever sent to full flash models. The *-flash-lite
// models reject it with 400 INVALID_ARGUMENT — seen live three times on
// 2026-11-15: twice on the fallback attempt after a 503, and again once
// the lite model became the primary. The trigger is the model, not the
// role — so the check is on the model name, not on primary-vs-fallback
// (the earlier role-based check was wrong and the model switch exposed it).
export function thinkingConfigFor(model: string, thinkingOff?: boolean) {
  return thinkingOff && !model.includes('lite')
    ? { thinkingConfig: { thinkingBudget: 0 } }
    : {};
}

// Groq, the final link in the chain. It speaks the OpenAI chat-completions
// API, so plain fetch is enough — no SDK. No response_format is sent:
// every caller expects a top-level JSON ARRAY (the prompts say so), and
// json_object mode rejects arrays — seen live 16 Nov 17:39, when Groq
// answered 400 json_validate_failed with an empty-array failed_generation
// after Gemini 503'd. The callers' parseJSON + zod validation already
// handle fences/prose and reject bad shapes, so strict mode buys nothing
// here. thinkingConfig is Gemini-only and is never sent here. Exported for
// the harness (it drives this with a stubbed fetch).
export async function callGroq(
  system: string,
  contents: string,
  maxOutputTokens: number,
  model: string,
  label: string
): Promise<string> {
  const response = await withTimeout(
    fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: contents },
        ],
        max_tokens: maxOutputTokens,
      }),
    }),
    GEMINI_TIMEOUT_MS,
    label
  );
  if (!response.ok) {
    // The status code is kept in the message so classifyFailure() can tell
    // a retryable 429/503 from a fatal 400.
    const body = await response.text().catch(() => '');
    throw new Error(`Groq API error ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from Groq');
  return text;
}

// One attempt against one chain link. Returns the JSON text. Exported for
// the harness (it drives the Groq path with a stubbed fetch).
export async function dispatchLink(
  link: ChainLink,
  system: string,
  contents: string,
  maxOutputTokens: number,
  opts: { thinkingOff?: boolean },
  label: string
): Promise<string> {
  // Count every dispatched attempt against the free-tier daily quota — a
  // retry is a new request, so it counts too. Logged at dispatch, which is
  // when the provider counts it. NOTE: the tracker's limit
  // (GEMINI_DAILY_LIMIT, default 20) is the Gemini free-tier number.
  // Groq's own free-tier cap differs and is not tracked here — Groq
  // attempts are counted by model name only, and their log line does not
  // claim the 20/day limit or the midnight-PT reset.
  const usage = usageTracker.record(link.model);
  if (link.provider === 'groq') {
    console.log(`[usage] ${link.model}: ${usage.count} dispatched today (Groq free-tier limit not tracked)`);
    return callGroq(system, contents, maxOutputTokens, link.model, label);
  }
  console.log(`[usage] ${link.model}: ${usage.count}/${usage.limit} today (resets midnight PT)`);
  const response = await withTimeout(
    client.models.generateContent({
      model: link.model,
      contents,
      config: {
        systemInstruction: system,
        maxOutputTokens,
        responseMimeType: 'application/json',
        ...thinkingConfigFor(link.model, opts.thinkingOff),
      },
    }),
    GEMINI_TIMEOUT_MS,
    label
  );
  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

// Try each link in the chain in order, advancing on retryable failures.
// `dispatch` performs one attempt against one link and returns the JSON
// text. Exported for the harness (production passes dispatchLink).
// A 400 (or any non-retryable error) is fatal: it throws immediately
// without trying the next link. When every link has failed, throws an
// error naming the models tried — the chain never cycles back to the
// start and never keeps retrying into the wall.
export async function attemptChain(
  links: ChainLink[],
  dispatch: (link: ChainLink) => Promise<string>,
  label: string
): Promise<{ text: string; attempts: number; tried: string[] }> {
  if (links.length === 0) {
    throw new Error('Model chain is empty — no Gemini models and no Groq key configured.');
  }
  const tried: string[] = [];
  let lastError: unknown;
  let dailyQuotaHit = false;
  for (const [i, link] of links.entries()) {
    tried.push(link.model);
    try {
      const text = await dispatch(link);
      return { text, attempts: i + 1, tried };
    } catch (err) {
      lastError = err;
      const message = String(err);
      const kind = classifyFailure(message);
      if (kind === 'fatal') throw err;
      if (isDailyQuotaError(message)) dailyQuotaHit = true;
      const next = links[i + 1];
      if (!next) break;
      const waitMs = RETRY_BASE_MS * (i + 1);
      console.log(
        `[retry] ${label}: attempt ${i + 1} failed (${kind}${isDailyQuotaError(message) ? ', daily quota' : ''}) on ${link.model}, switching to ${next.model}, retrying in ${waitMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error(
    `All model links failed (${tried.join(', ')}) after ${tried.length} attempt(s).` +
      (dailyQuotaHit ? ' A Gemini daily quota was hit; the daily quota resets at midnight PT.' : '') +
      ` Last error: ${String(lastError).slice(0, 200)}`
  );
}

// The one place that talks to the models.
// `label` is what the [timing]/[retry] logs call this request (e.g.
// 'day-synthesis Monday'). `thinkingOff` disables the model's reasoning
// pass (thinkingConfig thinkingBudget 0, supported by the installed SDK) —
// for the synthesis calls, which mostly format content into JSON, thinking
// is likely the biggest per-call cost. The planning call keeps thinking on:
// that is the reasoning-heavy one (allergen/macro checks). The request is
// tried against the model chain (see attemptChain); callers see the same
// JSON shape whichever link answers.
// `schema`, when given, validates the model's output before it reaches the
// caller. Validation runs inside the chain's dispatch, so a bad recipe
// throws here and attemptChain advances to the next link (classifyFailure
// maps it to a 503) instead of an invalid recipe flowing into the plan.
async function callGemini<T>(
  system: string,
  contents: string,
  maxOutputTokens: number,
  opts: { thinkingOff?: boolean; label?: string; schema?: z.ZodType } = {}
): Promise<T> {
  const label = opts.label ?? 'gemini';
  const startedAt = Date.now();
  try {
    const { text, attempts } = await attemptChain(
      CHAIN,
      async (link) => {
        const raw = await dispatchLink(link, system, contents, maxOutputTokens, opts, label);
        if (opts.schema) {
          const parsed = parseJSON(raw);
          const result = opts.schema.safeParse(parsed);
          if (!result.success) {
            const issues = result.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; ');
            throw new Error(`Recipe validation failed: ${issues}`);
          }
        }
        return raw;
      },
      label
    );
    timingLog(label, startedAt, ` (attempts: ${attempts})`);
    // The dispatch above already validated this exact text when a schema
    // was given, so this parse just returns the object.
    return parseJSON(text) as T;
  } catch (err) {
    console.log(`[timing] ${label}: FAILED — ${String(err).slice(0, 300)}`);
    throw err;
  }
}

// ── Per-meal macro budget ─────────────────────────────────────────────────────

const MEAL_WEIGHTS: Record<string, number> = {
  breakfast: 3.0,
  'morning snack': 1.0,
  lunch: 3.5,
  snack: 1.5,
  'afternoon snack': 1.0,
  dinner: 4.0,
  'evening snack': 1.0,
};

function perMealTargetsSection(req: MealPlanRequest): string {
  if (req.existingDayMeals?.length) return '';

  const mealTypes = req.slotsToGenerate
    ? [...new Set(req.slotsToGenerate.map((s) => s.mealType))]
    : getMealTypes(req.mealsPerDay);

  const totalWeight = mealTypes.reduce((sum, mt) => sum + (MEAL_WEIGHTS[mt] ?? 2.0), 0);

  const lines = mealTypes.map((mt) => {
    const ratio = (MEAL_WEIGHTS[mt] ?? 2.0) / totalWeight;
    const cal     = Math.round(req.macros.maxCalories  * ratio);
    const protein = Math.round(req.macros.minProtein   * ratio);
    const carb    = Math.round(req.macros.maxCarbs     * ratio);
    const fat     = Math.round(req.macros.maxFats      * ratio);
    const sug     = Math.round(req.dietary.maxSugar    * ratio);
    return `  ${mt.padEnd(18)}: ≤${cal} kcal | ≥${protein}g protein | ≤${carb}g carbs | ≤${fat}g fat | ≤${sug}g sugar`;
  });

  return `\nPER-MEAL MACRO LIMITS (each individual recipe must stay within these):\n${lines.join('\n')}`;
}

// ── Allergen guard ────────────────────────────────────────────────────────────

const ALLERGEN_TRAPS: Record<string, string> = {
  Peanuts:      'NO Kung Pao Chicken, Pad Thai, Satay, Dan Dan Noodles, or any peanut sauce dish',
  'Tree Nuts':  'NO cashew chicken, walnut dishes, pine-nut dishes',
  Soy:          'NO tofu, edamame, soy sauce, teriyaki — nearly all Chinese/Asian recipes use soy sauce, so choose carefully',
  Shellfish:    'NO shrimp, crab, lobster, scallops, oysters, prawns',
  Fish:         'NO fish sauce (extremely common in Thai cooking), anchovy, fish fillets',
  Gluten:       'NO regular soy sauce (contains wheat), wheat noodles, dumpling/gyoza wrappers',
  Dairy:        'NO butter, cream, cheese, milk-based sauces',
  Eggs:         'NO fried rice with egg, egg drop soup, egg noodles, egg-based dishes',
};

function allergenGuardSection(allergens: string[]): string {
  if (!allergens.length) return '';

  const lines = allergens.map((a) => {
    const trap = ALLERGEN_TRAPS[a];
    return trap ? `  • ${a}: ${trap}` : `  • ${a}: avoid all dishes that commonly contain ${a.toLowerCase()}`;
  });

  return `\nALLERGEN CHECK — before finalising each recipe name, verify it does not contain:\n${lines.join('\n')}`;
}

// ── Day context for regen ─────────────────────────────────────────────────────

function dayContextSection(req: MealPlanRequest): string {
  if (!req.existingDayMeals?.length) return '';

  const blocks = req.existingDayMeals.map(({ day, meals }) => {
    const mealLines = meals.map((m) =>
      `    - ${m.mealType}: "${m.name}" → ${m.macros.calories} kcal | ${m.macros.protein}g protein | ${m.macros.sugar}g sugar | ${m.macros.fats}g fat | ${m.macros.carbohydrates}g carbs`
    ).join('\n');

    const usedCal     = meals.reduce((s, m) => s + m.macros.calories, 0);
    const usedProtein = meals.reduce((s, m) => s + m.macros.protein, 0);
    const usedSug     = meals.reduce((s, m) => s + m.macros.sugar, 0);
    const usedFat     = meals.reduce((s, m) => s + m.macros.fats, 0);
    const usedCarb    = meals.reduce((s, m) => s + m.macros.carbohydrates, 0);

    const remCal     = Math.max(0, req.macros.maxCalories - usedCal);
    const remProtein = Math.max(0, req.macros.minProtein  - usedProtein);
    const remSug     = Math.max(0, req.dietary.maxSugar   - usedSug);
    const remFat     = Math.max(0, req.macros.maxFats     - usedFat);
    const remCarb    = Math.max(0, req.macros.maxCarbs    - usedCarb);

    return [
      `  ${day} — meals already set:`,
      mealLines,
      `  Remaining daily budget for the new meal(s): ≤${remCal} kcal | ≥${remProtein}g protein still needed | ≤${remSug}g sugar | ≤${remFat}g fat | ≤${remCarb}g carbs`,
    ].join('\n');
  });

  return `\nDAY CONTEXT — the new recipe(s) must fit within the remaining daily budget below:\n${blocks.join('\n\n')}`;
}

// ── Shared prompts ────────────────────────────────────────────────────────────

const PLANNING_SYSTEM = `You are a meal planning assistant. Return ONLY a valid JSON array of meal slots — no prose, no markdown, just raw JSON starting with [ and ending with ].

Each object must have exactly these fields:
{
  "day": "Monday",
  "date": "YYYY-MM-DD",
  "mealType": "breakfast" | "lunch" | "dinner" | "snack" | "morning snack" | "afternoon snack" | "evening snack",
  "recipeName": "Exact Recipe Name",
  "cuisineHint": "Cuisine Type",
  "sourceSite": "bare domain of the most authoritative website for this specific recipe (no https:// and no path). For Indian dishes prefer vegrecipesofindia.com, hebbarskitchen.com, archanaskitchen.com or cookwithmanali.com. For other cuisines e.g. seriouseats.com, bbcgoodfood.com, allrecipes.com, foodnetwork.com, bonappetit.com"
}

Before finalising each recipe name:
1. Check it fits within the per-meal macro limits provided.
2. Check it respects the prep/cook time limits.
3. Check it does not contain any excluded allergens — reason through the ingredient list in your head.
4. Check it can be made with only the listed equipment.
5. If "Ingredients to use up" were specified, each such ingredient should appear in at most 1–2 recipes across the entire week — do not repeat them in every meal of the same type.
Only then add it to your output.`;

const RECIPE_SCHEMA = `{
  "id": "kebab-case-unique-id",
  "name": "Recipe Name",
  "cuisine": "Cuisine Type",
  "prepTime": 10,
  "cookTime": 20,
  "servings": 2,
  "macros": { "calories": 450, "carbohydrates": 52, "protein": 28, "fats": 14, "fiber": 6, "sodium": 820, "sugar": 8 },
  "dietaryTags": ["vegetarian"],
  "equipment": ["oven"],
  "ingredients": [{ "name": "...", "quantity": 1, "unit": "cup", "searchTerm": "what a shopper would type into an Indian grocery app, e.g. paneer, atta, curd, toor dal" }],
  "steps": ["Step 1.", "Step 2."],
  "notes": "Optional tip.",
  "sourceSite": "allrecipes.com"
}`;

const SYNTHESIS_RULES = `CRITICAL RULES:
1. Return ONLY raw valid JSON. No prose, no markdown, no code fences.
2. Use the real retrieved content for ingredients, steps, and notes. Do not contradict real content.
3. Set "sourceSite" to just the domain from the Source URL (e.g. "seriouseats.com"). If no URL was found, use the suggested site.
4. Estimate macros accurately from real ingredient quantities.
5. Strictly respect all dietary restrictions, allergen exclusions, per-meal macro limits (including minimum protein targets), and the remaining day budget where provided.
6. Never include any blacklisted recipe.`;

function buildRecipeBlocks(enriched: EnrichedRecipe[]): string {
  return enriched.map((r) => {
    const header = `=== ${r.day.toUpperCase()} — ${r.mealType.toUpperCase()}: ${r.recipeName} ===`;
    const urlLine = r.sourceUrl
      ? `Source URL: ${r.sourceUrl}`
      : `Source URL: not found — use ${r.sourceSite} as sourceSite`;
    const contentBlock = r.content
      ? `Content:\n${r.content}`
      : `[No web content retrieved — use training knowledge for this recipe]`;
    return `${header}\n${urlLine}\n${contentBlock}`;
  }).join('\n\n');
}

function buildPlanningMessage(req: MealPlanRequest): string {
  const { days } = getPlanDates(req.startDate, req.numDays);
  const slots = req.slotsToGenerate
    ? req.slotsToGenerate.map((s) => `${s.day} ${s.date} — ${s.mealType}`)
    : days.flatMap(({ day, date }) =>
        getMealTypes(req.mealsPerDay).map((mealType) => `${day} ${date} — ${mealType}`)
      );

  const pinnedSection = req.pinnedRecipes?.length
    ? `\nREQUIRED RECIPES TO INCLUDE (assign these to appropriate slots):\n${req.pinnedRecipes.map((p) => `- "${p.name}" (${p.cuisineHint}) as ${p.mealType}`).join('\n')}`
    : '';

  const dayCount = req.slotsToGenerate ? 'partial' : `${days.length}-day`;
  return `Plan a ${dayCount} meal schedule.

MEAL SLOTS TO FILL:
${slots.join('\n')}
${pinnedSection}

USER PREFERENCES:
${preferenceSummary(req)}
${perMealTargetsSection(req)}
${allergenGuardSection(req.dietary.allergens)}
${dayContextSection(req)}`;
}

// ── Web pipeline: plan → web search → write one day at a time ─────────────────

const DAY_SYNTHESIS_SYSTEM = `You are a professional chef and meal planner. You have been given real recipe content retrieved from cooking websites.

${SYNTHESIS_RULES}

Return a JSON ARRAY of meal objects for the day — one entry per meal slot:
[
  { "mealType": "breakfast", "recipe": ${RECIPE_SCHEMA} }
]`;

function buildDaySynthesisMessage(
  req: MealPlanRequest,
  day: { day: string; date: string },
  enriched: EnrichedRecipe[]
): string {
  return `Generate recipe JSON for ${day.day} (${day.date}).

USER PREFERENCES:
${preferenceSummary(req)}
${perMealTargetsSection(req)}
${allergenGuardSection(req.dietary.allergens)}

REAL RECIPE DATA RETRIEVED FROM THE WEB:
${buildRecipeBlocks(enriched)}`;
}

export async function generateMealPlan(
  req: MealPlanRequest,
  onProgress: (msg: string) => void = () => {},
  // Called with each day as soon as its recipes are written, so the client
  // can render days as they arrive instead of waiting for the whole plan.
  onDay: (day: PlannedDay) => void = () => {}
): Promise<MealPlanResult> {
  if (req.searchMode === 'training') return generateMealPlanFromTraining(req, onProgress, onDay);
  // Fail before the planning call when no search provider is configured.
  const provider = requireSearchProvider();
  const startedAt = Date.now();

  // Phase 1 — Plan which recipes to use
  onProgress('Choosing recipes based on your preferences…');
  const slots = await callGemini<RecipeSlot[]>(PLANNING_SYSTEM, buildPlanningMessage(req), 3000, { label: 'planning', schema: z.array(RecipeSlotSchema) });
  onProgress(`Selected ${slots.length} recipes — searching the web…`);

  // Phase 2 — web search + extract for every recipe
  const enrichStarted = Date.now();
  const enriched = await enrichRecipes(slots, provider, onProgress);
  timingLog(`${provider.name.toLowerCase()} enrich`, enrichStarted);

  // Phase 3 — Write the days, three at a time. Three concurrent day calls
  // stay comfortably under the free tier's requests-per-minute limit (each
  // call lasts tens of seconds), and callGemini's retries still cover
  // 429/503. mapWithLimit keeps the returned array in day order; onDay
  // fires in completion order, which is what the client streams.
  onProgress('Writing your meal plan…');
  const { weekOf, days } = getPlanDates(req.startDate, req.numDays);
  let written = 0;
  const mealPlan = await mapWithLimit(days, 3, async (d) => {
    // Match on the date only: it's unambiguous, while the day-name text comes back from the model.
    const dayEnriched = enriched.filter((r: EnrichedRecipe) => r.date === d.date);
    const meals = await callGemini<DayMeal[]>(
      DAY_SYNTHESIS_SYSTEM,
      buildDaySynthesisMessage(req, d, dayEnriched),
      8000,
      { thinkingOff: true, label: `day-synthesis ${d.day}`, schema: z.array(DayMealSchema) }
    );
    const dayPlan: PlannedDay = {
      day: d.day,
      date: d.date,
      meals: meals.map((meal) => {
        const src = dayEnriched.find((r: EnrichedRecipe) => r.mealType === meal.mealType);
        return {
          ...meal,
          recipe: { ...meal.recipe, sourceUrl: src?.sourceUrl ?? null, imageUrl: src?.imageUrl ?? null },
        };
      }),
    };
    written++;
    onDay(dayPlan);
    onProgress(`Writing your meal plan… (${written}/${days.length})`);
    return dayPlan;
  });

  timingLog('total', startedAt);
  return { weekOf, mealPlan, shoppingList: [] };
}

// ── Selective regeneration (web) ──────────────────────────────────────────────

const REGEN_SYNTHESIS_SYSTEM = `You are a professional chef and meal planner. You have been given real recipe content retrieved from cooking websites.

${SYNTHESIS_RULES}

Return a JSON ARRAY (not an object) matching EXACTLY this schema:
[
  {
    "day": "Monday",
    "date": "YYYY-MM-DD",
    "mealType": "breakfast",
    "recipe": ${RECIPE_SCHEMA}
  }
]`;

function buildRegenSynthesisMessage(req: MealPlanRequest, enriched: EnrichedRecipe[]): string {
  return `Generate replacement recipes for the specific meal slots listed below.

USER PREFERENCES:
${preferenceSummary(req)}
${allergenGuardSection(req.dietary.allergens)}
${dayContextSection(req)}

REAL RECIPE DATA RETRIEVED FROM THE WEB:
${buildRecipeBlocks(enriched)}`;
}

export async function regenerateMeals(
  req: MealPlanRequest,
  onProgress: (msg: string) => void = () => {}
): Promise<RegenMeal[]> {
  if (req.searchMode === 'training') return regenerateMealsFromTraining(req, onProgress);
  if (!req.slotsToGenerate?.length) throw new Error('No slots specified for regeneration');
  const provider = requireSearchProvider();

  // Phase 1 — Plan only the specified slots
  onProgress('Choosing replacement recipes…');
  const slots = await callGemini<RecipeSlot[]>(PLANNING_SYSTEM, buildPlanningMessage(req), 2000, { label: 'regen-planning', schema: z.array(RecipeSlotSchema) });
  onProgress(`Selected ${slots.length} replacement recipe${slots.length === 1 ? '' : 's'} — searching the web…`);

  // Phase 2 — web search + extract for those slots
  const enriched = await enrichRecipes(slots, provider, onProgress);

  // Phase 3 — Write just the requested meals
  onProgress('Writing your updated meals…');
  const regenMeals = await callGemini<RegenMeal[]>(
    REGEN_SYNTHESIS_SYSTEM,
    buildRegenSynthesisMessage(req, enriched),
    8000,
    { thinkingOff: true, label: 'regen-synthesis', schema: z.array(RegenMealSchema) }
  );

  return regenMeals.map((m) => {
    const src = enriched.find((r: EnrichedRecipe) => r.day === m.day && r.mealType === m.mealType);
    return { ...m, recipe: { ...m.recipe, sourceUrl: src?.sourceUrl ?? null, imageUrl: src?.imageUrl ?? null } };
  });
}

// ── Training-only pipeline — Gemini writes recipes from its own knowledge ─────

const TRAINING_RULES = `CRITICAL RULES:
1. Return ONLY raw valid JSON. No prose, no markdown, no code fences.
2. Invent each recipe yourself from your own training knowledge — do not claim to have searched or retrieved anything from the web.
3. Set "sourceSite" to "Gemini" for every recipe.
4. Estimate macros accurately and consistently with the ingredient quantities you specify.
5. Strictly respect all dietary restrictions, allergen exclusions, per-meal macro limits (including minimum protein targets), and the remaining day budget where provided.
6. Never include any blacklisted recipe.`;

const TRAINING_DAY_SYSTEM = `You are a professional chef and meal planner. You do not have web access for this task — invent realistic, cookable recipes entirely from your own training knowledge.

${TRAINING_RULES}

Return a JSON ARRAY of meal objects for the day — one entry per meal slot:
[
  { "mealType": "breakfast", "recipe": ${RECIPE_SCHEMA} }
]`;

const TRAINING_REGEN_SYSTEM = `You are a professional chef and meal planner. You do not have web access for this task — invent realistic, cookable recipes entirely from your own training knowledge.

${TRAINING_RULES}

Return a JSON ARRAY (not an object) matching EXACTLY this schema:
[
  {
    "day": "Monday",
    "date": "YYYY-MM-DD",
    "mealType": "breakfast",
    "recipe": ${RECIPE_SCHEMA}
  }
]`;

type PinnedRecipe = { name: string; cuisineHint: string; mealType: string };

function assignPinnedToDays(
  pinnedRecipes: PinnedRecipe[] | undefined,
  days: { day: string; date: string }[]
): Map<string, PinnedRecipe[]> {
  const byDay = new Map<string, PinnedRecipe[]>();
  if (!pinnedRecipes?.length) return byDay;

  const usedDaysForType = new Map<string, Set<string>>();
  for (const pinned of pinnedRecipes) {
    const usedDays = usedDaysForType.get(pinned.mealType) ?? new Set<string>();
    const target = days.find((d) => !usedDays.has(d.day));
    if (!target) continue;
    usedDays.add(target.day);
    usedDaysForType.set(pinned.mealType, usedDays);
    byDay.set(target.day, [...(byDay.get(target.day) ?? []), pinned]);
  }
  return byDay;
}

function buildTrainingDayMessage(
  req: MealPlanRequest,
  day: { day: string; date: string },
  pinnedForDay: PinnedRecipe[]
): string {
  const mealTypes = getMealTypes(req.mealsPerDay);
  const pinnedSection = pinnedForDay.length
    ? `\nREQUIRED RECIPES TO INCLUDE (assign to the matching meal type; still write full original content for it):\n${pinnedForDay.map((p) => `- "${p.name}" (${p.cuisineHint}) as ${p.mealType}`).join('\n')}`
    : '';

  return `Generate a full day of meals for ${day.day} (${day.date}). Meal slots: ${mealTypes.join(', ')}.
${pinnedSection}

USER PREFERENCES:
${preferenceSummary(req)}
${perMealTargetsSection(req)}
${allergenGuardSection(req.dietary.allergens)}`;
}

function stampAiGenerated(recipe: LlmRecipe): ValidatedRecipe {
  return { ...recipe, sourceSite: 'Gemini', sourceUrl: null, imageUrl: null, aiGenerated: true };
}

export async function generateMealPlanFromTraining(
  req: MealPlanRequest,
  onProgress: (msg: string) => void = () => {},
  // Called with each day as soon as its recipes are written, so the client
  // can render days as they arrive instead of waiting for the whole plan.
  onDay: (day: PlannedDay) => void = () => {}
): Promise<MealPlanResult> {
  onProgress('Generating recipes from training knowledge…');
  const startedAt = Date.now();
  const { weekOf, days } = getPlanDates(req.startDate, req.numDays);
  const pinnedByDay = assignPinnedToDays(req.pinnedRecipes, days);

  // Three at a time, same as the web pipeline: comfortably under the free
  // tier's requests-per-minute limit, retries still cover 429/503.
  // mapWithLimit keeps the returned array in day order; onDay fires in
  // completion order, which is what the client streams.
  let written = 0;
  const mealPlan = await mapWithLimit(days, 3, async (d) => {
    const meals = await callGemini<DayMeal[]>(
      TRAINING_DAY_SYSTEM,
      buildTrainingDayMessage(req, d, pinnedByDay.get(d.day) ?? []),
      8000,
      { thinkingOff: true, label: `day-synthesis ${d.day}`, schema: z.array(DayMealSchema) }
    );
    const dayPlan: PlannedDay = {
      day: d.day,
      date: d.date,
      meals: meals.map((meal) => ({ ...meal, recipe: stampAiGenerated(meal.recipe) })),
    };
    written++;
    onDay(dayPlan);
    onProgress(`Generating recipes… (${written}/${days.length})`);
    return dayPlan;
  });

  timingLog('total', startedAt);
  return { weekOf, mealPlan, shoppingList: [] };
}

function buildTrainingRegenMessage(req: MealPlanRequest): string {
  const slots = req.slotsToGenerate ?? [];
  return `Generate replacement recipes for the specific meal slots listed below.

MEAL SLOTS TO FILL:
${slots.map((s) => `${s.day} ${s.date} — ${s.mealType}`).join('\n')}

USER PREFERENCES:
${preferenceSummary(req)}
${allergenGuardSection(req.dietary.allergens)}
${dayContextSection(req)}`;
}

export async function regenerateMealsFromTraining(
  req: MealPlanRequest,
  onProgress: (msg: string) => void = () => {}
): Promise<RegenMeal[]> {
  if (!req.slotsToGenerate?.length) throw new Error('No slots specified for regeneration');

  onProgress('Generating replacement recipes from training knowledge…');
  const regenMeals = await callGemini<RegenMeal[]>(TRAINING_REGEN_SYSTEM, buildTrainingRegenMessage(req), 8000, { thinkingOff: true, label: 'training-regen-synthesis', schema: z.array(RegenMealSchema) });
  return regenMeals.map((m) => ({ ...m, recipe: stampAiGenerated(m.recipe) }));
}