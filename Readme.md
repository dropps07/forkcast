# forkcast

AI meal planning for Indian kitchens. Generate a personalised multi-day meal plan, browse full recipes sourced from real cooking sites, track what's in your pantry, and turn the plan into a shopping checklist with one-click search links to Blinkit, BigBasket and Instamart.

**Live demo:** [forkcast-frontend.onrender.com](https://forkcast-frontend.onrender.com)

[![CI](https://github.com/dropps07/forkcast/actions/workflows/ci.yml/badge.svg)](https://github.com/dropps07/forkcast/actions/workflows/ci.yml)

## What makes this different

Forkcast is built around how Indian households actually cook and shop:

- **Indian grocery links** — every shopping-list item links straight to Blinkit, BigBasket or Instamart search, so the plan turns into a real order in one tap.
- **Real recipes, retrieved not invented** — Web Search mode finds the actual recipe on a cooking site (vegrecipesofindia.com, hebbarskitchen.com and others), pulls its real ingredients and steps from the page's Schema.org data, and only then has the AI write the final recipe from that content. The recipe you get matches the source.
- **Pantry-first planning** — tell it what's in your fridge and it plans around those ingredients, then skips them when building the shopping list.
- **Fast by design** — day generation is ~95% faster than the first version (130s → 6s per day), and days stream in live as they're written.
- **Reliable on the free tier** — generation runs through a model chain (Gemini flash → lite → Groq), so a plan still completes when one model hits its daily quota.

## Features

- **AI meal planning**: generate 1-7 days of meals starting on any date, with full recipe details (ingredients, steps, macros, source links)
- **Two ways to plan**
  - **Web Search**: plans recipes with Gemini, finds the real recipe on a cooking site through Tavily, then writes the final recipe from that real content
  - **AI Generated**: skips the web and has Gemini write each recipe from its own training knowledge. Faster, but not sourced from a real page
- **Preferences**: cuisines, vegetarian / vegan, allergens, sodium / sugar / macro targets, prep and cook time limits, equipment, and meals per day. Vegetarian is on by default
- **Leftovers**: tell forkcast what's in your fridge and it works those ingredients into the plan
- **Selective regeneration**: swap out individual meals without regenerating the whole plan
- **Favorites and pinning**: star recipes to save them, and pin favorites so they appear in your next plan
- **Recent recipes**: avoids repeating recent meals
- **Pantry**: log what you already have. Pantry items are skipped when the shopping list is built
- **Shopping list**: a combined ingredient checklist with quantity estimates. Each item has a search link for Blinkit, BigBasket or Instamart (you pick the retailer), a "Copy list" button, and a checked state that persists between visits
- **Live progress**: days stream in as they're written, with a per-day checklist and a timer, so you can watch the plan come together instead of waiting on a spinner
- **Dark and light mode**

forkcast does not scrape retailers and does not use any cart API. The links just open the retailer's own search page for the item, in your own browser session.

## Tech stack

| Layer         | Tech                                                  |
| ------------- | ----------------------------------------------------- |
| Frontend      | React 19, TypeScript, Vite, Zustand                   |
| Backend       | Node.js, Express, TypeScript (ESM)                    |
| AI            | Google Gemini (`@google/genai`), free tier compatible |
| Recipe search | Tavily (`@tavily/core`)                               |
| Grocery       | Retailer search links (Blinkit, BigBasket, Instamart) |

## How it works

### Recipe generation

Both modes stream progress to the browser over Server-Sent Events (SSE), so the UI can show messages like "Writing your meal plan... (2/7)".

**Web Search**

1. **Plan.** Gemini decides which recipes fit your preferences and picks a source site for each (for Indian dishes it prefers sites such as vegrecipesofindia.com and hebbarskitchen.com).
2. **Retrieve.** The backend searches for each recipe with Tavily (or Keenable when no Tavily key is set), restricted to that site, and extracts the real ingredient list and steps. It prefers the page's embedded Schema.org Recipe data (JSON-LD) and falls back to the search provider's content extraction.
3. **Write.** Gemini produces the final structured recipe (macros, steps, ingredients) from the retrieved content, one day at a time, so it can't contradict the real recipe.

**AI Generated**: one Gemini call per day, written entirely from the model's own knowledge. These recipes carry no source link.

Both modes apply to full-plan generation and to regenerating individual meals.

### Reliability

- Days are generated in parallel (up to 3 at a time) and stream to the browser as each one finishes, so the plan appears day by day instead of all at once
- Generation runs through a model chain — Gemini flash, then the faster lite model, then Groq — so a plan still completes when one model hits its daily quota or goes down
- A daily-quota 429 fails fast and moves to the next model instead of burning retries on a quota that won't reset until tomorrow
- Gemini calls retry on overloads (HTTP 503) with increasing waits, and each attempt has a timeout so a hung call can't stall the plan
- Every generation attempt is counted per model per day, so you can see exactly how much of the free quota a plan used
- Every model response is validated against a zod schema before it reaches the UI — a bad recipe (missing fields, wrong types, impossible macros) fails that attempt and the chain moves to the next model, instead of serving garbage. Malformed or empty responses fail immediately instead of retrying
- 37 tests cover the validation schemas, the date helpers and the ingredient merging, and run on every push via GitHub Actions CI

### Performance

- Day generation is **~95% faster**: a day of meals now takes **3.6–8.6s** on `gemini-3.5-flash-lite`, down from **93–167s** on `gemini-3.8-flash` (a 10–46× speedup). The win came from switching the primary model to lite, turning off thinking for synthesis calls, and synthesising days in parallel (concurrency 3) with SSE streaming so days render as they arrive.
- A 2-day web plan completes in **~32s** end to end
- The binding constraint is Gemini's **20 requests/day per-model quota**, not speed — the app fails fast on quota errors and falls through the model chain rather than retrying a limit that won't lift until tomorrow

### Shopping list

The list is built in the browser from the generated plan:

1. Ingredients from every recipe are merged under a canonical key (plural / singular variants and hyphenation collapse into one row)
2. Anything in your pantry is moved to its own section instead of the to-buy list
3. Each item carries a `searchTerm` written the way a shopper would type it into an Indian grocery app (for example `paneer`, `atta`, `curd`, `toor dal`)
4. You tick items off as you buy them, and the checked state is saved locally

### Usage limits

The generation endpoints are rate limited per IP to protect the AI quota. In production the limit is 2 requests per day, and a shared access code (`FULL_ACCESS_CODE`) raises it to 10 for trusted users. In development the limit is effectively off.

## Project structure

```
forkcast/
  package.json            npm workspace root
  render.yaml             Render Blueprint (backend + frontend)
  DEPLOY.md               Deploy steps for Render
  frontend/               React + Vite app
    src/
      components/         UI (meal plan, modals, shared UI)
      stores/             Zustand stores (preferences, meal plan, pantry, usage)
      services/           API client and SSE streaming
      utils/              date, ingredient, export and error helpers
  backend/                Express API
    src/
      index.ts            server, rate limiting, image proxy
      routes/             meal plan (streaming) and access routes
      services/           aiService (Gemini), recipeSearch (web pipeline), recipeExtract (JSON-LD),
                          tavilyService / keenableService (search adapters), utils, usageTracker
```

## Local development

### Prerequisites

- Node.js 22+
- A [Google AI Studio](https://aistudio.google.com) API key (free tier is enough)
- For Web Search mode only: a [Tavily](https://tavily.com) API key, or the [Keenable](https://docs.keenable.ai) fallback (keyed with `KEENABLE_API_KEY`, or keyless by default; set `KEENABLE_KEYLESS=false` to opt out)

### Setup

```bash
git clone https://github.com/dropps07/forkcast.git
cd forkcast
npm install
```

Create the backend environment file and add your keys:

```bash
cp backend/.env.example backend/.env
```

```env
GEMINI_API_KEY=your-gemini-key
TAVILY_API_KEY=your-tavily-key
PORT=3001
```

Never commit `backend/.env`. It is gitignored, and `.env.example` should only ever hold placeholders.

Start the backend and frontend in two terminals:

```bash
npm run dev -w backend
npm run dev -w frontend
```

The app runs at `http://localhost:5173`. The Vite dev server proxies `/api` to the Express backend on port 3001. To check the backend on its own:

```bash
curl http://localhost:3001/health
```

### Build

```bash
npm run build -w backend     # compiles to backend/dist
npm run build -w frontend    # builds to frontend/dist
npm run start -w backend     # runs the compiled backend
```

## Deploy

The repo ships a Render Blueprint (`render.yaml`): a Node web service for the backend and a static site for the frontend. See [DEPLOY.md](DEPLOY.md) for the steps — connect the repo, set `GEMINI_API_KEY` (and `GROQ_API_KEY` if you have one), and deploy. The frontend talks to the backend through `VITE_API_URL`. Free-tier services sleep after 15 minutes idle; the first visit takes ~30–60s to wake.

## Environment variables

| Variable                | Required   | Default                 | Description                                                                                            |
| ----------------------- | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `GEMINI_API_KEY`        | Yes        | none                    | Google Gemini API key                                                                                  |
| `TAVILY_API_KEY`        | No         | none                    | Tavily search and extract API key. Web Search mode uses Tavily whenever it is set                      |
| `KEENABLE_API_KEY`      | No         | none                    | Keenable key, the Web Search fallback when no Tavily key is set                                        |
| `KEENABLE_KEYLESS`      | No         | on (no Tavily key)      | `false` turns off the keyless Keenable fallback. Rate limited per IP; keyed and keyless requests are both logged under the default policy (docs.keenable.ai/data-privacy) |
| `GEMINI_MODEL`          | No         | set in `aiService.ts`   | Main Gemini model                                                                                      |
| `GEMINI_FALLBACK_MODEL` | No         | set in `aiService.ts`   | Lighter model used after a 503                                                                         |
| `GEMINI_RETRY_MS`       | No         | `10000`                 | Base wait between retries (attempt n waits n x this)                                                   |
| `GEMINI_TIMEOUT_MS`     | No         | `180000`                | Per-attempt timeout for generation calls                                                               |
| `GROQ_API_KEY`          | No         | none                    | Groq API key — enables the Groq fallback link in the model chain                                        |
| `GROQ_MODEL`            | No         | set in `aiService.ts`   | Groq model for the fallback link                                                                       |
| `PORT`                  | No         | `3001`                  | Backend port                                                                                           |
| `CORS_ORIGIN`           | No         | `http://localhost:5173` | Allowed CORS origin in development                                                                     |
| `NODE_ENV`              | No         | none                    | Set to `production` to enable the strict rate limit                                                    |
| `FULL_ACCESS_CODE`      | No         | none                    | Shared passphrase; visiting `/<code>` or `?access=<code>` raises the daily limit to 10                 |
| `COOKIE_SIGNING_SECRET` | No         | none                    | Signs the access cookie; generate with `openssl rand -hex 32`. Required for `FULL_ACCESS_CODE` to work |
| `APP_URL`               | Production | none                    | Public URL of the deployed app (marks the access cookie as secure)                                     |

## Roadmap

- A built-in sample plan, so visitors can browse a full week and shopping list without API keys or using the daily quota

## License

MIT — see [LICENSE](LICENSE).
