# Deploying Forkcast on Render

Forkcast deploys as two free Render services from this repo's `render.yaml`
(Blueprint): the Express backend and the Vite frontend. Everything the
deploy needs lives in `render.yaml` — the services, the build commands,
and the environment variables — so a Blueprint apply configures both
services with no manual dashboard steps beyond filling in the secrets.

| Service | Type | URL |
|---|---|---|
| `forkcast-backend` | Node web service (`backend/`) | https://forkcast-backend-s16w.onrender.com |
| `forkcast-frontend` | Static site (`frontend/`, publishes `dist/`) | Shown in the Render dashboard after deploy |

Render may suffix a service's hostname if the plain name is taken (the
backend got `-s16w`). The URLs above are the live ones; if a service is
recreated and its hostname changes, `render.yaml` resolves the other
service's host with `fromService`, so no code change is needed.

## Steps

1. **Commit and push** this repo to GitHub (default branch), including
   `render.yaml`.
2. **Render dashboard → New → Blueprint.** Connect the
   `dropps07/forkcast` repo. Render detects `render.yaml` and shows both
   services. Click **Apply**.
3. **Set the API keys** in the backend service (Environment tab). They are
   declared `sync: false` in `render.yaml`, so Render leaves them empty
   until you fill them in:
   - `GEMINI_API_KEY` — **required**. Meal generation does not work without it.
   - `TAVILY_API_KEY` — for Web Search mode. Without it the backend still
     starts and AI Generated mode works; Web Search then falls back to
     Keenable (`KEENABLE_API_KEY`, or the keyless endpoints by default).
     Set `KEENABLE_KEYLESS=false` to opt out of the keyless fallback.
   - `GROQ_API_KEY` — optional. Only for the Groq fallback link in the
     model chain; the app runs fine without it (that link is skipped).
   Save — Render redeploys the backend.
   `GEMINI_MODEL` is already set in `render.yaml` to
   `gemini-3.5-flash-lite` (the fast model, ~95% faster per day than
   flash). If you change it, the backend restarts with the new model.
4. **Wait for both services to show "Live".** The first build takes a few
   minutes. The frontend build explicitly installs Vite's native Linux
   bindings (`@rolldown/binding-linux-x64-gnu`,
   `lightningcss-linux-x64-gnu`); without them npm skips the optional deps
   and `vite build` fails with "Cannot find native binding".
5. **Open the frontend URL** from the Render dashboard and generate a plan
   to confirm days stream in.

## How the frontend reaches the backend

The frontend calls the backend **directly**. At build time Render sets
`VITE_API_URL` from the backend service's host (`fromService`, property
`host`), and Vite bakes it into the bundle, so the browser fetches
`https://forkcast-backend-s16w.onrender.com/api/...`. The backend's
`CORS_ORIGIN` is set the same way from the frontend service's host, and
the backend prepends `https://` if it gets a bare hostname, so CORS stays
correct even if Render suffixes either hostname. There is deliberately
**no** static-site rewrite proxy in front of the API: Render's static-site
rewrites buffer streaming responses (confirmed by Render support — the fix
they give is to call the web service directly), and Forkcast's meal-plan
stream is SSE. A rewrite would make days arrive in clumps instead of
streaming live.

Because the URL is baked in at build time, **if the backend URL ever
changes, redeploy the frontend** so it picks up the new `VITE_API_URL`.

## Free-tier notes

- Both services sleep after **15 minutes idle**. The first visit after a
  sleep takes **~30–60s** to wake. That is expected on the free tier.
- Do **not** add a keep-alive pinger: two services awake 24/7 would burn
  through Render's 750 free instance-hours/month.
- The backend waking also delays the first meal-plan generation of a
  session (wake + generation).

## Known limitation: full-access code

The trusted-access cookie (`FULL_ACCESS_CODE`) is a same-origin feature:
the backend sets an httpOnly `SameSite=Lax` cookie. With the frontend and
backend on separate Render origins, that cookie does not flow
cross-origin, so the full-access code grant has no effect from the
frontend origin. The core app (2 plans/day anonymous) is unaffected. If
full access matters in production, the follow-up is to serve the frontend
from the backend itself (it already has `express.static` for that) or
rework the cookie to `SameSite=None; Secure` with credentialed fetches.
