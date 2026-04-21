# Agenticz Demo Voice

Private back-office dashboard for triggering live AI voice demo calls through Retell.

- **Final domain:** demo.agenticz.io
- **Stack:** static HTML + Vercel serverless functions (Node.js, ES modules). No framework, no build step.
- **Status:** Phase 1 — email + password auth (JWT sessions, Turso-backed users, rate-limited login).

## Project layout

```
Agenticz_Demo_Voice/
├── public/
│   ├── index.html          # Landing — redirects to /login or /dashboard
│   ├── login.html
│   ├── dashboard.html      # Placeholder (Phase 2 coming)
│   └── assets/
│       ├── brand.css
│       ├── index.js
│       ├── login.js
│       └── dashboard.js
├── api/
│   ├── health.js           # GET /api/health
│   └── auth/
│       ├── login.js        # POST /api/auth/login
│       ├── logout.js       # POST /api/auth/logout
│       └── me.js           # GET  /api/auth/me
├── lib/
│   ├── db.js               # Turso client singleton
│   └── auth.js             # bcrypt, JWT, cookie helpers, rate limiter, performLogin
├── scripts/
│   ├── migrate.js          # Creates the users table
│   └── seed-user.js        # Seeds the single admin user from env
├── tests/
│   ├── health.test.js
│   └── auth.test.js
├── .env.example
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

## Prerequisites

- Node.js 20.6+ (supports `node --env-file=.env`)
- npm 10+
- Vercel CLI (installed via `npm install`)
- Turso CLI + a hosted Turso database (see below)

## Turso setup

One-time, local machine:

```bash
# 1. Install the Turso CLI
brew install tursodatabase/tap/turso

# 2. Sign in (or signup if new)
turso auth login

# 3. Create the database
turso db create agenticz-demo-voice

# 4. Get the connection URL
turso db show agenticz-demo-voice --url

# 5. Create a database auth token
turso db tokens create agenticz-demo-voice

# 6. Generate a JWT secret (64+ random chars)
openssl rand -base64 48
```

## Local env

Create `.env` in the project root (ignored by git):

```bash
cp .env.example .env
```

Then fill in:

```
TURSO_DATABASE_URL=libsql://...turso.io
TURSO_AUTH_TOKEN=<token from turso db tokens create>

AUTH_JWT_SECRET=<openssl rand -base64 48>
AUTH_COOKIE_NAME=agenticz_session
AUTH_SESSION_TTL_SECONDS=28800

ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<12+ character strong password>
```

On Vercel, set the same variables in Project Settings → Environment Variables for all environments (Production, Preview, Development).

## Migrate + seed

After the `.env` file is filled in:

```bash
npm run db:migrate    # creates the users table
npm run db:seed       # inserts / updates the admin user
```

Re-running `npm run db:seed` with a new `ADMIN_PASSWORD` rotates the password in place.

## Run locally

```bash
npm run dev
```

Runs `vercel dev` on http://localhost:3000.

- `/` → redirects to `/login` or `/dashboard`
- `/login` → sign-in form
- `/dashboard` → placeholder after login
- `/api/health` → `{ "ok": true }`
- `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`

The first time you run `vercel dev` the CLI may prompt you to link the directory to a Vercel project. Link it to `agenticz-demo-voice`.

## Tests

```bash
npm test           # single run
npm run test:watch # watch mode
```

The auth suite covers:
- bcrypt hash / verify round-trip and rejection of wrong passwords
- JWT (HS256) sign / verify + tamper rejection
- `performLogin`: bad password, unknown email, good credentials, email normalization
- Rate limiter: 5 attempts per IP per 5 min, per-IP isolation

DB-backed tests use an in-memory fake client, so `npm test` does not require Turso credentials.

## Auth design

- **Passwords:** bcrypt, cost factor 12. Constant-time compare via `bcryptjs`.
- **Sessions:** HS256 JWT containing `{ email }`, 8-hour expiry (`AUTH_SESSION_TTL_SECONDS`).
- **Cookie:** `agenticz_session`, `HttpOnly; Secure; SameSite=Strict; Path=/`.
- **Rate limit:** max 5 login attempts per IP per 5-minute sliding window. In-memory map (per-instance), flagged with a `TODO` to move to Upstash Redis in Phase 6 hardening.
- **Generic errors:** every failure returns `Invalid email or password`, never leaking whether the email exists.
- **Timing:** on unknown email, a dummy bcrypt compare runs to keep response time similar to the valid-user path.
- **`/api/auth/me`:** returns `{ email }` only — never the DB id or hash.

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

Production deploys run on Vercel via `git push` to `main`. Before the first Phase 1 deploy, make sure all seven env vars are set in Vercel Project Settings; the serverless functions will throw at cold start otherwise.

## Roadmap

- **Phase 0:** Foundation scaffold, security headers, health check.
- **Phase 1 (this commit):** Auth — login, logout, `/api/auth/me`, Turso-backed users, JWT sessions, rate limiting.
- **Phase 2+:** Retell voice demo orchestration.
