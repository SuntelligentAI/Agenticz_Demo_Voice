import { readFileSync } from 'node:fs';
import path from 'node:path';

// Read the static template once at cold start. The HTML lives in public/ and
// is traced into the serverless bundle by Vercel's automatic file tracing.
const HTML_PATH = path.join(process.cwd(), 'public', 'web-bot', 'live.html');
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

function renderUnconfiguredPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="color-scheme" content="dark" />
    <title>Web Bot — Unavailable — Agenticz</title>
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
    </style>
  </head>
  <body>
    <div class="notice">
      <h1>Chat widget unavailable</h1>
      <p>reCAPTCHA is not configured on this deployment. An operator must set the <code>GOOGLE_RECAPTCHA_SITE_KEY</code> environment variable and redeploy.</p>
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
      '[web-bot/live] GOOGLE_RECAPTCHA_SITE_KEY not set — rendering unavailable page',
    );
    return res.status(200).send(renderUnconfiguredPage());
  }

  if (!TEMPLATE) {
    console.error('[web-bot/live] template not loaded');
    return res.status(500).send('Internal error');
  }

  const scriptTag =
    `<script src="${RECAPTCHA_ORIGIN}?render=${escapeAttr(siteKey)}"></script>`;

  // Inject BEFORE </head> so Google reCAPTCHA loads before the dashboard JS
  // (which later injects the Retell widget) runs.
  const html = TEMPLATE.replace('</head>', `    ${scriptTag}\n  </head>`);
  return res.status(200).send(html);
}
