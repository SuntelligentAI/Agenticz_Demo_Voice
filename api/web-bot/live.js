import { readFileSync } from 'node:fs';
import path from 'node:path';

// Template lives OUTSIDE public/ on purpose. If it were under public/ then
// Vercel's static file handler would serve the raw HTML at /web-bot/live
// BEFORE our rewrite could forward the request to this serverless function
// (rewrites are only applied when no static file or function matches). The
// file is read once per cold start; Vercel's automatic file tracing bundles
// it alongside this function.
const HTML_PATH = path.join(process.cwd(), 'templates', 'web-bot', 'live.html');
let TEMPLATE = null;
try {
  TEMPLATE = readFileSync(HTML_PATH, 'utf8');
} catch (err) {
  console.error('[web-bot/live] failed to read template:', err?.message || err);
}

const RECAPTCHA_ORIGIN = 'https://www.google.com/recaptcha/api.js';

function escapeAttr(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function escapeForJsString(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/ /g, '\\u2028')
    .replace(/ /g, '\\u2029');
}

function renderUnconfiguredPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="color-scheme" content="dark" />
    <title>Web Bot — reCAPTCHA not configured — Agenticz</title>
    <link rel="stylesheet" href="/assets/brand.css" />
    <style>
      body { display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 40px 20px; }
      .notice {
        max-width: 520px; padding: 32px;
        background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 14px; color: var(--fg); text-align: center;
      }
      .notice h1 { margin: 0 0 12px; font-family: "Outfit", sans-serif; font-weight: 500; font-size: 22px; }
      .notice p { margin: 0; color: var(--muted); line-height: 1.6; }
      code { color: var(--gold); }
    </style>
  </head>
  <body>
    <div class="notice">
      <h1>reCAPTCHA not configured</h1>
      <p>The environment variable <code>GOOGLE_RECAPTCHA_SITE_KEY</code> is not set on this deployment. An operator must set it (Production + Preview + Development) and redeploy.</p>
    </div>
  </body>
</html>
`;
}

export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const siteKey = process.env.GOOGLE_RECAPTCHA_SITE_KEY;

  if (!siteKey) {
    console.warn(
      '[web-bot/live] GOOGLE_RECAPTCHA_SITE_KEY not set — returning 500',
    );
    return res.status(500).send(renderUnconfiguredPage());
  }

  if (!TEMPLATE) {
    console.error('[web-bot/live] template not loaded');
    return res.status(500).send('<!doctype html><html><body>Internal error: template missing.</body></html>');
  }

  // Inject BEFORE </head>:
  //   1. Google reCAPTCHA api.js loader, keyed with the site key from env
  //   2. An inline script that sets window.__RECAPTCHA_SITE_KEY__ so the
  //      dashboard JS can set data-recaptcha-key on the widget without
  //      fetching the key from an API.
  const injected =
    `<script src="${RECAPTCHA_ORIGIN}?render=${escapeAttr(siteKey)}"></script>\n` +
    `    <script>window.__RECAPTCHA_SITE_KEY__ = "${escapeForJsString(siteKey)}";</script>`;

  const html = TEMPLATE.replace('</head>', `    ${injected}\n  </head>`);
  return res.status(200).send(html);
}
