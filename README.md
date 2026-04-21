# Agenticz Demo Voice

Private back-office dashboard for triggering live AI voice demo calls through Retell.

- **Final domain:** demo.agenticz.io
- **Stack:** static HTML + Vercel serverless functions (Node.js, ES modules). No framework, no build step.
- **Status:** Phase 0 — foundation scaffold only. No auth, no database, no Retell logic yet.

## Project layout

```
Agenticz_Demo_Voice/
├── public/
│   └── index.html          # Admin landing placeholder
├── api/
│   └── health.js           # GET /api/health → { ok: true }
├── tests/
│   └── health.test.js      # Vitest test for the health endpoint
├── .env.example
├── .gitignore
├── package.json
├── vercel.json             # Routing + security headers
└── README.md
```

## Prerequisites

- Node.js 20+ (ES modules)
- npm 10+
- Vercel CLI (installed as a dev dependency by `npm install`, or globally via `npm i -g vercel`)

## Setup

```bash
git clone https://github.com/SuntelligentAI/Agenticz_Demo_Voice.git
cd Agenticz_Demo_Voice
npm install
cp .env.example .env           # empty for now — real values come in later phases
```

## Run locally

```bash
npm run dev
```

This runs `vercel dev` on http://localhost:3000.

- Landing page: http://localhost:3000
- Health check: http://localhost:3000/api/health → `{ "ok": true }`

> The first time you run `vercel dev` the CLI may prompt you to link the directory to a Vercel project. Link it to the `agenticz-demo-voice` project (or create a new one) when prompted.

## Tests

```bash
npm test           # single run
npm run test:watch # watch mode
```

The Phase 0 suite invokes the `/api/health` handler directly with a mock response object and asserts status `200` and body `{ ok: true }`.

## Security headers

All routes return the following headers (configured in `vercel.json`):

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`

## Deploying

Production deploys run on Vercel via `git push` to `main` (once the GitHub repo is linked to the Vercel project). No manual steps required for this phase.

## Roadmap

- **Phase 0 (this commit):** Foundation scaffold, security headers, health check.
- **Phase 1:** Authentication.
- **Phase 2+:** Retell voice demo orchestration.
