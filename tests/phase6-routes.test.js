import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const CAL_URL = 'https://cal.com/suntelligent-ai/discovery-call';

let vercelConfig;

beforeAll(() => {
  vercelConfig = JSON.parse(
    readFileSync(join(ROOT, 'vercel.json'), 'utf8'),
  );
});

const PUBLIC_MARKETING_PAGES = [
  { path: 'index.html', title: 'Agenticz Demos' },
  { path: 'voice.html', title: 'Voice AI demos' },
  { path: 'voice/speed-to-lead.html', title: 'Speed To Lead' },
  { path: 'voice/receptionist.html', title: 'Receptionist' },
  { path: 'voice/website-voice-bot.html', title: 'Website Voice Bot' },
  { path: 'web-bot.html', title: 'Web Bot' },
  { path: 'talentsift.html', title: 'TalentSift' },
  { path: 'dashboard-demo.html', title: 'Command Dashboard' },
];

describe('public marketing pages', () => {
  it.each(PUBLIC_MARKETING_PAGES)(
    '$path exists and has the expected title',
    ({ path, title }) => {
      const full = join(PUBLIC_DIR, path);
      expect(existsSync(full), `${path} should exist`).toBe(true);
      const html = readFileSync(full, 'utf8');
      expect(html).toContain(title);
    },
  );

  it('all 7 marketing pages (6 leaf + landing) include the Cal.com CTA', () => {
    const pagesWithCalCta = [
      'voice/speed-to-lead.html',
      'voice/receptionist.html',
      'voice/website-voice-bot.html',
      'web-bot.html',
      'talentsift.html',
      'dashboard-demo.html',
    ];
    for (const p of pagesWithCalCta) {
      const html = readFileSync(join(PUBLIC_DIR, p), 'utf8');
      expect(html, `${p} should contain the Cal.com URL`).toContain(CAL_URL);
      expect(html, `${p} Cal.com link must open in a new tab`).toMatch(
        /target="_blank"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*target="_blank"/,
      );
    }
  });

  it('none of the marketing pages still reference the old agenticz.io/book URL', () => {
    for (const { path } of PUBLIC_MARKETING_PAGES) {
      const html = readFileSync(join(PUBLIC_DIR, path), 'utf8');
      expect(html, `${path} still contains agenticz.io/book`).not.toContain(
        'agenticz.io/book',
      );
    }
  });
});

describe('tile icons on landing + voice sub', () => {
  it('the 4-tile landing page has 4 inline <svg> icons, one per tile', () => {
    const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
    const tileSvgMatches = html.match(/class="tile"[^>]*>[\s\S]*?<svg\b/g) || [];
    expect(tileSvgMatches.length).toBe(4);
  });

  it('the 3-tile voice page has 3 inline <svg> icons, one per tile', () => {
    const html = readFileSync(join(PUBLIC_DIR, 'voice.html'), 'utf8');
    const tileSvgMatches = html.match(/class="tile"[^>]*>[\s\S]*?<svg\b/g) || [];
    expect(tileSvgMatches.length).toBe(3);
  });

  it('every tile SVG uses currentColor stroke and no fill', () => {
    for (const p of ['index.html', 'voice.html']) {
      const html = readFileSync(join(PUBLIC_DIR, p), 'utf8');
      const svgBlocks = html.match(/<svg\b[^>]*>/g) || [];
      for (const svg of svgBlocks) {
        expect(svg, `${p} <svg> should have stroke="currentColor"`).toContain(
          'stroke="currentColor"',
        );
        expect(svg, `${p} <svg> should have fill="none"`).toContain(
          'fill="none"',
        );
      }
    }
  });
});

describe('gated live routes (vercel.json)', () => {
  const GATED_LIVE_PATHS = [
    '/voice/speed-to-lead/live',
    '/voice/speed-to-lead/live/history',
    '/voice/speed-to-lead/live/calls/:id',
    '/voice/receptionist/live',
    '/voice/website-voice-bot/live',
    '/web-bot/live',
    '/talentsift/live',
    '/dashboard-demo/live',
  ];

  it.each(GATED_LIVE_PATHS)(
    '%s has a "missing agenticz_session cookie" redirect to /login with next',
    (path) => {
      const redirect = vercelConfig.redirects.find((r) => r.source === path);
      expect(redirect, `no redirect configured for ${path}`).toBeTruthy();
      expect(redirect.missing).toEqual([
        { type: 'cookie', key: 'agenticz_session' },
      ]);
      expect(redirect.destination).toContain('/login?next=');
      expect(redirect.destination).toContain(path);
    },
  );

  it('dashboard.html has moved to /voice/speed-to-lead/live.html', () => {
    expect(existsSync(join(PUBLIC_DIR, 'voice/speed-to-lead/live.html'))).toBe(
      true,
    );
    expect(existsSync(join(PUBLIC_DIR, 'dashboard.html'))).toBe(false);
  });

  it('history.html + calls.html moved under /voice/speed-to-lead/live/', () => {
    expect(
      existsSync(join(PUBLIC_DIR, 'voice/speed-to-lead/live/history.html')),
    ).toBe(true);
    expect(
      existsSync(join(PUBLIC_DIR, 'voice/speed-to-lead/live/calls.html')),
    ).toBe(true);
    expect(existsSync(join(PUBLIC_DIR, 'history.html'))).toBe(false);
    expect(existsSync(join(PUBLIC_DIR, 'calls.html'))).toBe(false);
  });

  it('/voice/speed-to-lead/live/calls/:id rewrites to the static calls page', () => {
    const rewrite = vercelConfig.rewrites.find(
      (r) => r.source === '/voice/speed-to-lead/live/calls/:id',
    );
    expect(rewrite).toBeTruthy();
    expect(rewrite.destination).toBe(
      '/voice/speed-to-lead/live/calls.html',
    );
  });
});

describe('coming-soon shared page', () => {
  // Receptionist (Phase 7) and Website Voice Bot (Phase 8) both graduated
  // from coming-soon to real live dashboards. Three products still share
  // coming-soon.html.
  const COMING_SOON_LIVE_PATHS = [
    { path: '/web-bot/live', product: 'web-bot' },
    { path: '/talentsift/live', product: 'talentsift' },
    { path: '/dashboard-demo/live', product: 'dashboard-demo' },
  ];

  it('shared coming-soon.html exists', () => {
    expect(existsSync(join(PUBLIC_DIR, 'coming-soon.html'))).toBe(true);
  });

  it('coming-soon.html includes the Cal.com CTA (opens in new tab)', () => {
    const html = readFileSync(join(PUBLIC_DIR, 'coming-soon.html'), 'utf8');
    expect(html).toContain(CAL_URL);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Launching soon');
  });

  it.each(COMING_SOON_LIVE_PATHS)(
    '$path rewrites to /coming-soon.html?product=$product',
    ({ path, product }) => {
      const rewrite = vercelConfig.rewrites.find((r) => r.source === path);
      expect(rewrite, `no rewrite for ${path}`).toBeTruthy();
      expect(rewrite.destination).toBe(`/coming-soon.html?product=${product}`);
    },
  );

  it('coming-soon.js knows about every coming-soon product rewrite', () => {
    const js = readFileSync(
      join(PUBLIC_DIR, 'assets/coming-soon.js'),
      'utf8',
    );
    for (const { product } of COMING_SOON_LIVE_PATHS) {
      const re = new RegExp(
        `(?:['"])?${product.replace(/-/g, '\\-')}(?:['"])?\\s*:`,
      );
      expect(js, `coming-soon.js missing product "${product}"`).toMatch(re);
    }
  });
});
