# Forkcast 
### Find Meals You Didn't Know You Were Looking For.

> Generate a personalised multi-day meal plan, browse full recipes from real cooking sites, track what's in your pantry, and turn the plan into a shopping checklist with one-click search links to Blinkit, BigBasket and Instamart.

**Live demo:** https://forkcast-frontend.onrender.com

No account needed. Open the demo, answer a few questions about diet, budget and time, and get a full multi-day plan with recipes. A Demo Mode with a sample plan is built in, so the app works even without an AI key.


## Features

- **Personalised meal plans** — multi-day plans generated for your diet, cuisine, budget and cooking time, streamed live as they are built.
- **Real recipes** — every meal links to a full recipe from a real cooking site, not a generated summary.
- **Two generation modes** — AI Generated (pure model output) and Web Search (recipes found on the live web via Tavily).
- **Pantry tracking** — keep a list of what you already have, and the planner cooks around it.
- **Shopping checklist** — turn a plan into a checklist with one-click search links to Blinkit, BigBasket and Instamart.
- **Demo Mode** — a sample plan ships with the app, so visitors can try everything without waiting on the AI.

## How it works

The frontend talks directly to the Express backend over SSE (server-sent events), so the plan streams in day by day instead of making you wait for one big response. There is deliberately no proxy in front of the API: Render's static-site rewrites buffer streaming responses, and the direct call keeps the stream unbuffered.

The AI chain is Gemini first, Groq second. The default model is `gemini-3.5-flash-lite`, which is roughly 95 percent faster per day than the full flash model (about 4 to 9 seconds a day versus 90 to 170). If Gemini is overloaded or fails, the request falls back to Groq's `openai/gpt-oss-20b` automatically.

Every AI response is validated with Zod before it reaches the frontend, and recipe images go through an SSRF-safe proxy, so the backend never fetches an arbitrary URL the model invented.

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Zustand |
| Backend | Node.js, Express 5, TypeScript |
| AI | Google Gemini (`gemini-3.5-flash-lite`), Groq (`openai/gpt-oss-20b`), Tavily web search |
| Validation | Zod |
| Tests | Vitest (52 tests across frontend and backend) |
| Deploy | Render Blueprint (`render.yaml`): Express web service + Vite static site |

## Project structure

```text
forkcast/
  frontend/     React + Vite app (Zustand state, SSE plan streaming)
  backend/      Express 5 API (plan generation, recipes, pantry, rate limiting)
  render.yaml   Render Blueprint for both services
  DEPLOY.md     Full deployment steps
```

## Run locally

```bash
# Backend (needs GEMINI_API_KEY, and GROQ_API_KEY for the fallback)
cd backend
npm install
npm run dev

# Frontend
cd frontend
npm install
npm run dev
```

The backend runs on `http://localhost:3000` and the frontend on Vite's dev server. Set `VITE_API_URL` to the backend URL if it differs.

## Environment variables

| Variable | Where | Required |
| --- | --- | --- |
| `GEMINI_API_KEY` | Backend | Yes, for AI generation |
| `GROQ_API_KEY` | Backend | For the fallback model |
| `TAVILY_API_KEY` | Backend | For Web Search mode only |
| `KEENABLE_API_KEY` / `KEENABLE_KEYLESS` | Backend | Web Search fallback when no Tavily key is set. Keyless is on by default; set `KEENABLE_KEYLESS=false` to opt out |
| `VITE_API_URL` | Frontend | Yes, full backend URL |
| `CORS_ORIGIN` | Backend | Yes, full frontend URL |

Secrets are set in the Render dashboard, never in `render.yaml`. Note that Render's `fromService` host returns just the service name, not a URL — always use the full `https://` URL for `VITE_API_URL` and `CORS_ORIGIN`.

## Deploy

This repo ships a Render Blueprint. In the Render dashboard: New → Blueprint → connect `dropps07/forkcast` → Apply. See `DEPLOY.md` for the full steps.

Both services run on Render's free tier, so they sleep when idle — the first visit after a while can take a minute to wake up.

## Rate limits

Generation is capped to protect the shared Gemini key (free tier: 20 requests a day per model across all visitors):

- Anonymous: 5 generations per IP per day
- With an access code: 10 per day
- Development: 1000 per day

Counts are stored in memory on the backend, so a redeploy resets them.

## Roadmap

- A database backend, so plans, pantry and preferences persist across devices and redeploys (currently everything lives in the browser and in-memory server state). Accounts stay optional, generating a plan never needs a login.
- Saved and favourite recipes.
- Plan history and sharing.

## License

MIT
