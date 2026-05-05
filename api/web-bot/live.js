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
let TEMPLATE_LOAD_ERROR = null;
try {
  TEMPLATE = readFileSync(HTML_PATH, 'utf8');
} catch (err) {
  TEMPLATE_LOAD_ERROR = err?.message || String(err);
  console.error('[web-bot/live] failed to read template:', TEMPLATE_LOAD_ERROR);
}

const SITE_KEY_PLACEHOLDER = '{{RECAPTCHA_SITE_KEY}}';

function renderUnconfiguredPage() {
  return '<!doctype html>\n'
    + '<html lang="en">\n'
    + '  <head>\n'
    + '    <meta charset="utf-8" />\n'
    + '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n'
    + '    <meta name="robots" content="noindex, nofollow" />\n'
    + '    <meta name="color-scheme" content="dark" />\n'
    + '    <title>Web Bot — reCAPTCHA not configured — Agenticz</title>\n'
    + '    <link rel="stylesheet" href="/assets/brand.css" />\n'
    + '    <style>\n'
    + '      body { display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 40px 20px; }\n'
    + '      .notice { max-width: 520px; padding: 32px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 14px; color: var(--fg); text-align: center; }\n'
    + '      .notice h1 { margin: 0 0 12px; font-family: "Outfit", sans-serif; font-weight: 500; font-size: 22px; }\n'
    + '      .notice p { margin: 0; color: var(--muted); line-height: 1.6; }\n'
    + '      code { color: var(--gold); }\n'
    + '    </style>\n'
    + '  </head>\n'
    + '  <body>\n'
    + '    <div class="notice">\n'
    + '      <h1>reCAPTCHA not configured</h1>\n'
    + '      <p>The environment variable <code>GOOGLE_RECAPTCHA_SITE_KEY</code> is not set on this deployment. An operator must set it (Production + Preview + Development) and redeploy.</p>\n'
    + '    </div>\n'
    + '  </body>\n'
    + '</html>\n';
}

export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const siteKey = process.env.GOOGLE_RECAPTCHA_SITE_KEY;

  // Diagnostic: log whether the env var is set (boolean only, never the
  // value), whether the template was loaded from disk, and its byte length.
  // This makes Vercel log inspection sufficient to diagnose whichever of the
  // two failure modes is live at the moment.
  console.info(
    '[web-bot/live] diag',
    JSON.stringify({
      envSet: Boolean(siteKey),
      templateFound: TEMPLATE !== null,
      templateBytes: TEMPLATE ? TEMPLATE.length : 0,
      templatePath: HTML_PATH,
      templateLoadError: TEMPLATE_LOAD_ERROR,
      cwd: process.cwd(),
    }),
  );

  if (!siteKey) {
    console.warn(
      '[web-bot/live] GOOGLE_RECAPTCHA_SITE_KEY not set — returning 500',
    );
    return res.status(500).send(renderUnconfiguredPage());
  }

  if (!TEMPLATE) {
    console.error('[web-bot/live] template not loaded');
    return res
      .status(500)
      .send('<!doctype html><html><body>Internal error: template missing.</body></html>');
  }

  // Safe string replacement — no regex, so there's no way a Unicode char in
  // the key can break parsing. URL-encode the key for the script src and
  // the meta tag content attribute.
  const urlSafeKey = encodeURIComponent(siteKey);

  const html = TEMPLATE
    .split(SITE_KEY_PLACEHOLDER).join(urlSafeKey);

  return res.status(200).send(html);
}
