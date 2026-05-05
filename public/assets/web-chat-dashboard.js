// Web Bot live dashboard.
// - Master line toggle (web_chat_enabled)
// - Stage create/view/clear (15-min TTL)
// - Retell chat widget mount with dynamic business context
// - Cal.com iframe handoff after session
// - Live feed polling /api/calls?product=web_bot

// Diagnostic: intercept POST to Retell create-chat so we can log the
// response body when reCAPTCHA verification fails. Must install before
// the widget runs. The dashboard script is `defer`red and the widget is
// injected even later, so this wrapper is live for every widget request.
(function installCreateChatDiagnostic() {
  if (typeof window === 'undefined' || !window.fetch) return;
  if (window.__agenticzChatFetchWrapped) return;
  window.__agenticzChatFetchWrapped = true;
  const orig = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const resp = await orig(input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('api.retellai.com/create-chat')) {
        if (!resp.ok) {
          const body = await resp.clone().text().catch(() => '<unreadable>');
          console.warn(
            '[recaptcha-debug] POST /create-chat failed',
            resp.status,
            body,
          );
        } else {
          console.info('[recaptcha-debug] POST /create-chat ok', resp.status);
        }
      }
    } catch {}
    return resp;
  };
})();

const RULES = {
  agentName: { min: 2, max: 40, pattern: /^[\p{L}\s'\-]+$/u, label: 'Agent name' },
  companyName: { min: 2, max: 80, label: 'Company name' },
  companyDescription: { min: 10, max: 400, label: 'Company description' },
  callPurpose: { min: 10, max: 400, label: 'Call purpose' },
};
const FIELD_KEYS = Object.keys(RULES);
const POLL_MS = 5000;
const TERMINAL = new Set(['ended', 'failed']);
const CAL_URL = 'https://cal.com/suntelligent-ai/discovery-call';
// Best-known Retell chat widget embed script URL. If Retell updates this
// path, change it here and add the new origin to CSP script-src in
// vercel.json. Docs: https://docs.retellai.com/deploy/chat-widget
const RETELL_WIDGET_SCRIPT =
  'https://dashboard.retellai.com/retell-widget.js';

// --- helpers -------------------------------------------------------------

function clean(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x1F\x7F]/g, '').trim();
}
function validateField(key, raw) {
  const v = clean(raw);
  const rule = RULES[key];
  if (/[<>]/.test(v)) return `${rule.label} contains invalid characters.`;
  if (!v) return `${rule.label} is required.`;
  if (v.length < rule.min) return `${rule.label} must be at least ${rule.min} characters.`;
  if (v.length > rule.max) return `${rule.label} must be at most ${rule.max} characters.`;
  if (rule.pattern && !rule.pattern.test(v)) return `${rule.label} contains unsupported characters.`;
  return null;
}
function showFieldError(key, msg) {
  const err = document.querySelector(`[data-error-for="${key}"]`);
  const field = document.getElementById(key)?.closest('.field');
  if (err) err.textContent = msg || '';
  if (field) field.classList.toggle('has-error', Boolean(msg));
}
function clearAllFieldErrors() { for (const k of FIELD_KEYS) showFieldError(k, ''); }
function setFormError(msg) { document.getElementById('form-error').textContent = msg || ''; }
function formatMMSS(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function formatDateTime(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return '—'; }
}
function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function loginRedirect() {
  location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
}

function clearRetellWidgetState() {
  try {
    // Clear all localStorage keys that could belong to the Retell widget.
    // The widget may use various prefixes or unprefixed keys like 'chat_id'.
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (
        k.startsWith('retell') ||
        k.startsWith('Retell') ||
        k.includes('chat') ||
        k.includes('message')
      )) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
    // Also clear sessionStorage for the same patterns.
    const sKeys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && (
        k.startsWith('retell') ||
        k.startsWith('Retell') ||
        k.includes('chat') ||
        k.includes('message')
      )) sKeys.push(k);
    }
    for (const k of sKeys) sessionStorage.removeItem(k);
    // Remove any widget-injected DOM elements outside the mount point.
    document.querySelectorAll(
      '[id*="retell"], [class*="retell"], [id*="Retell"], [class*="Retell"]'
    ).forEach((el) => {
      if (!el.closest('#chat-mount')) el.remove();
    });
    const total = keys.length + sKeys.length;
    if (total) {
      console.info('[web-chat] cleared widget state:', [...keys, ...sKeys]);
    }
  } catch (e) {
    console.warn('[web-chat] failed to clear widget state:', e);
  }
}

function debugRecaptcha(phase) {
  try {
    const trunc = (s) =>
      typeof s === 'string' && s.length > 0 ? s.slice(0, 10) : '<empty>';
    const grecaptchaExists =
      typeof window !== 'undefined' && typeof window.grecaptcha !== 'undefined';

    const scripts = Array.from(
      document.querySelectorAll('script[src*="recaptcha/api.js"]'),
    );
    const recaptchaSrc = scripts[0]?.src || '';
    const renderMatch = recaptchaSrc.match(/[?&]render=([^&]+)/);
    const serverKey = renderMatch ? decodeURIComponent(renderMatch[1]) : '';

    const widgetScript = document.getElementById('retell-widget');
    const widgetKey = widgetScript?.getAttribute('data-recaptcha-key') || '';

    console.info(
      `[recaptcha-debug] (${phase}) window.grecaptcha present:`,
      grecaptchaExists,
    );
    console.info(
      `[recaptcha-debug] (${phase}) <head> recaptcha api.js tags:`,
      scripts.length,
    );
    console.info(
      `[recaptcha-debug] (${phase}) server-injected site key (first 10):`,
      trunc(serverKey),
    );
    console.info(
      `[recaptcha-debug] (${phase}) data-recaptcha-key on widget (first 10):`,
      trunc(widgetKey),
    );
    console.info(
      `[recaptcha-debug] (${phase}) keys match:`,
      Boolean(serverKey && widgetKey && serverKey === widgetKey),
    );
  } catch (e) {
    console.warn('[recaptcha-debug] failed:', e);
  }
}

// --- auth / nav ----------------------------------------------------------

async function loadMe() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (r.status === 401) { loginRedirect(); return null; }
    if (!r.ok) throw new Error(`status ${r.status}`);
    const data = await r.json();
    document.getElementById('user-email').textContent = data.email || '';
    document.body.classList.add('ready');
    return data;
  } catch { loginRedirect(); return null; }
}

function wireLogout() {
  document.getElementById('logout').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {}
    loginRedirect();
  });
}

// --- line toggle + widget config -----------------------------------------

let lineEnabled = false;
// recaptchaSiteKey is server-rendered into window.__RECAPTCHA_SITE_KEY__
// by api/web-bot/live.js — it MUST NOT be fetched from an API.
let widgetConfig = {
  chatAgentId: null,
  publicKey: null,
  recaptchaSiteKey: (() => {
    const meta = document.querySelector('meta[name="recaptcha-site-key"]');
    return meta ? meta.getAttribute('content') || null : null;
  })(),
};

function renderLineState() {
  const pill = document.getElementById('line-pill');
  const text = document.getElementById('line-pill-text');
  const toggle = document.getElementById('line-toggle');
  pill.classList.remove('on', 'off');
  if (lineEnabled) {
    pill.classList.add('on');
    text.textContent = 'Line: ON';
    toggle.textContent = 'Turn line off';
    toggle.classList.add('off');
  } else {
    pill.classList.add('off');
    text.textContent = 'Line: OFF';
    toggle.textContent = 'Turn line on';
    toggle.classList.remove('off');
  }
}

function renderAutoOffBanner({ enabled, reason }) {
  const el = document.getElementById('auto-off-banner');
  if (!el) return;
  if (enabled || !reason || !reason.startsWith('auto_off:')) {
    el.hidden = true; el.textContent = ''; return;
  }
  const label = {
    'auto_off:logout': 'Line switched off — operator logged out.',
    'auto_off:tab_close': 'Line switched off — dashboard tab was closed.',
    'auto_off:idle_30min': 'Line switched off — 30 minutes of no stage activity.',
  }[reason] || `Line switched off — ${reason}.`;
  el.innerHTML = '';
  el.appendChild(document.createTextNode(label));
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Toggle ON above to resume.';
  el.appendChild(hint);
  el.hidden = false;
}

async function loadLineState() {
  try {
    const r = await fetch('/api/settings/web-chat-line', { credentials: 'same-origin' });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const data = await r.json();
    lineEnabled = Boolean(data.enabled);
    widgetConfig = {
      ...widgetConfig,
      chatAgentId: data.chatAgentId || null,
      publicKey: data.publicKey || null,
    };
    renderLineState();
    renderAutoOffBanner({ enabled: lineEnabled, reason: data.reason });
    refreshWidget();
  } catch {}
}

async function setLineState(next) {
  if (!next && currentStage) {
    const ok = window.confirm(
      'A demo is currently staged. Turning the line off will unmount the chat widget. Continue?',
    );
    if (!ok) return;
  }
  const toggle = document.getElementById('line-toggle');
  toggle.disabled = true;
  try {
    const r = await fetch('/api/settings/web-chat-line', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const data = await r.json();
    lineEnabled = Boolean(data.enabled);
    if (!lineEnabled) clearRetellWidgetState();
    renderLineState();
    refreshWidget();
  } finally {
    toggle.disabled = false;
  }
}

function wireLineToggle() {
  document.getElementById('line-toggle').addEventListener('click', () => {
    const banner = document.getElementById('auto-off-banner');
    if (banner) { banner.hidden = true; banner.textContent = ''; }
    setLineState(!lineEnabled);
  });
}

function sendAutoOffBeacon(reason) {
  if (!lineEnabled) return;
  try {
    const body = JSON.stringify({ enabled: false, reason });
    navigator.sendBeacon('/api/settings/web-chat-line', body);
  } catch {}
}

function wireAutoOffBeacons() {
  window.addEventListener('pagehide', () => sendAutoOffBeacon('auto_off:tab_close'));
  window.addEventListener('beforeunload', () => sendAutoOffBeacon('auto_off:tab_close'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendAutoOffBeacon('auto_off:tab_close');
  });
}

// --- stage ---------------------------------------------------------------

let currentStage = null;
let countdownTimer = null;

function showStagedCard() {
  document.getElementById('staged-card').hidden = false;
  document.getElementById('form-card').hidden = true;
}
function showFormCard() {
  document.getElementById('staged-card').hidden = true;
  document.getElementById('form-card').hidden = false;
}

function renderStage(stage) {
  currentStage = stage;
  if (!stage) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    showFormCard();
    refreshWidget();
    return;
  }
  document.getElementById('staged-agent').textContent = stage.agentName;
  document.getElementById('staged-company').textContent = stage.companyName;
  document.getElementById('staged-desc').textContent = stage.companyDescription;
  document.getElementById('staged-purpose').textContent = stage.callPurpose;

  const updateCountdown = () => {
    const remaining = stage.expiresAt - Date.now();
    const el = document.getElementById('staged-countdown');
    if (remaining <= 0) {
      el.textContent = 'Expired';
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      loadStage();
      return;
    }
    el.textContent = `Expires in ${formatMMSS(remaining)}`;
  };
  if (countdownTimer) clearInterval(countdownTimer);
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);

  showStagedCard();
  refreshWidget();
}

async function loadStage() {
  try {
    const r = await fetch('/api/web-chat/stage', { credentials: 'same-origin' });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const data = await r.json();
    renderStage(data.stage);
  } catch {}
}

function wireStageForm() {
  const form = document.getElementById('stage-form');
  for (const key of FIELD_KEYS) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener('blur', () => showFieldError(key, validateField(key, el.value)));
    el.addEventListener('input', () => {
      const err = document.querySelector(`[data-error-for="${key}"]`);
      if (err?.textContent) showFieldError(key, '');
    });
  }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setFormError(''); clearAllFieldErrors();
    const inputs = {};
    for (const k of FIELD_KEYS) inputs[k] = document.getElementById(k).value;
    let firstErr = null;
    for (const k of FIELD_KEYS) {
      const msg = validateField(k, inputs[k]);
      if (msg) { showFieldError(k, msg); if (!firstErr) firstErr = k; }
    }
    if (firstErr) { document.getElementById(firstErr).focus(); return; }

    const btn = document.getElementById('submit-stage');
    btn.disabled = true;
    btn.textContent = 'Staging…';
    try {
      const r = await fetch('/api/web-chat/stage', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
      });
      if (r.status === 401) { loginRedirect(); return; }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setFormError(data.error || `Could not stage (${r.status}).`); return; }
      for (const k of FIELD_KEYS) document.getElementById(k).value = '';
      clearRetellWidgetState();
      renderStage(data.stage);
    } catch {
      setFormError('Network error. Try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Stage demo';
    }
  });
}

function wireStageActions() {
  document.getElementById('clear-stage').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/web-chat/stage', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (r.status === 401) { loginRedirect(); return; }
    } catch {}
    clearRetellWidgetState();
    renderStage(null);
  });
}

// --- widget mount --------------------------------------------------------

function clearMount() {
  const mount = document.getElementById('chat-mount');
  if (!mount) return;
  mount.innerHTML = '';
  mount.classList.remove('visible');
  const existing = document.getElementById('retell-widget');
  if (existing) existing.remove();
}

function refreshWidget() {
  const mount = document.getElementById('chat-mount');
  const blocked = document.getElementById('chat-blocked');
  const statusSub = document.getElementById('chat-status-sub');
  if (!mount || !blocked || !statusSub) return;

  clearMount();
  blocked.hidden = true;

  if (!widgetConfig.chatAgentId || !widgetConfig.publicKey) {
    blocked.hidden = false;
    statusSub.textContent = 'Chat widget is not configured on the server.';
    return;
  }
  if (!widgetConfig.recaptchaSiteKey) {
    blocked.hidden = false;
    blocked.textContent =
      'Chat widget unavailable — reCAPTCHA not configured.';
    statusSub.textContent = '';
    return;
  }

  if (!lineEnabled) {
    statusSub.textContent = 'Line is OFF. Turn it on to mount the widget.';
    return;
  }
  if (!currentStage) {
    statusSub.textContent = 'Stage a demo above to mount the widget with context.';
    return;
  }

  statusSub.textContent = `Chatting as ${currentStage.agentName} from ${currentStage.companyName}.`;

  // Render the Retell widget via a <script> tag with data-attributes.
  // Anchor via #chat-mount so the widget lays out inline (not floating).
  // The Retell widget self-configures by reading data-* attributes from
  // its own <script> element, which it locates via id="retell-widget".
  const existing = document.getElementById('retell-widget');
  if (existing) existing.remove();
  clearRetellWidgetState();
  const script = document.createElement('script');
  script.id = 'retell-widget';
  script.src = RETELL_WIDGET_SCRIPT;
  script.type = 'module';
  script.setAttribute('data-public-key', widgetConfig.publicKey);
  script.setAttribute('data-agent-id', widgetConfig.chatAgentId);
  script.setAttribute('data-title', `Chat with ${currentStage.agentName}`);
  script.setAttribute('data-bot-name', currentStage.agentName);
  script.setAttribute(
    'data-popup-message',
    `Hi! I'm ${currentStage.agentName} from ${currentStage.companyName}. How can I help?`,
  );
  script.setAttribute('data-color', '#FFB800');
  script.setAttribute('data-auto-open', 'true');
  script.setAttribute(
    'data-dynamic',
    JSON.stringify({
      agent_name: currentStage.agentName,
      company_name: currentStage.companyName,
      company_description: currentStage.companyDescription,
      call_purpose: currentStage.callPurpose,
    }),
  );
  if (widgetConfig.recaptchaSiteKey) {
    script.setAttribute('data-recaptcha-key', widgetConfig.recaptchaSiteKey);
  }

  mount.appendChild(script);
  mount.classList.add('visible');
  debugRecaptcha('widget-mounted');
}

// --- post-session + feed + Cal.com ---------------------------------------

function hideBookingCard() {
  const card = document.getElementById('booking-card');
  card.classList.remove('visible');
  const frame = document.getElementById('booking-iframe');
  frame.src = 'about:blank';
}
function showBookingCard() {
  const card = document.getElementById('booking-card');
  const frame = document.getElementById('booking-iframe');
  if (frame.src === 'about:blank' || !frame.src) frame.src = CAL_URL;
  card.classList.add('visible');
}

async function saveCallNotes(callId, notes) {
  const r = await fetch(`/api/calls/${encodeURIComponent(callId)}/notes`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  });
  if (r.status === 401) { loginRedirect(); throw new Error('Session expired'); }
  if (!r.ok) {
    let body = {}; try { body = await r.json(); } catch {}
    throw new Error(body?.error || `Save failed (${r.status})`);
  }
  const body = await r.json();
  return body.notes || '';
}

function renderFeed(items) {
  const list = document.getElementById('feed-list');
  if (!items.length) {
    list.innerHTML = '<li class="feed-item"><span class="feed-meta"><span class="top">No chat sessions yet.</span><span>Stage a demo and chat with the widget above.</span></span></li>';
    return;
  }
  list.innerHTML = '';
  for (const row of items) {
    const a = document.createElement('a');
    a.className = 'feed-item';
    a.href = `/web-bot/live/calls/${encodeURIComponent(row.id)}`;
    const left = document.createElement('div');
    left.className = 'feed-meta';
    const top = document.createElement('span');
    top.className = 'top';
    top.textContent = `${row.companyName || '—'} · ${row.agentName || '—'}`;
    const bottom = document.createElement('span');
    const duration = formatDuration(row.durationSeconds);
    bottom.textContent = [
      formatDateTime(row.createdAt),
      duration ? `· ${duration}` : null,
      row.outcome ? `· ${row.outcome}` : null,
    ].filter(Boolean).join(' ');
    left.appendChild(top); left.appendChild(bottom);
    const pill = document.createElement('span');
    pill.className = `pill ${row.status || ''}`;
    pill.textContent = row.status || '—';
    a.appendChild(left); a.appendChild(pill);
    list.appendChild(a);
  }
}

let lastTerminalId = null;

async function maybeRenderPostChat(topRow) {
  const card = document.getElementById('post-call-card');
  if (!topRow) { card.classList.remove('visible'); return; }

  const isTerminal = TERMINAL.has(topRow.status);
  const recent = (topRow.createdAt || 0) > Date.now() - 60 * 60 * 1000; // within last hour
  if (!isTerminal || !recent) {
    card.classList.remove('visible');
    return;
  }
  try {
    const r = await fetch(`/api/calls/${encodeURIComponent(topRow.id)}`, {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const row = await r.json();
    const container = document.getElementById('post-call-content');
    if (window.AgenticzPostCall && container) {
      window.AgenticzPostCall.render(row, container, {
        onSave: (text) => saveCallNotes(row.id, text),
      });
      card.classList.add('visible');
    }
    // Surface the Cal.com booking card once a chat has actually ended.
    if (topRow.id !== lastTerminalId) {
      lastTerminalId = topRow.id;
      showBookingCard();
    }
  } catch {}
}

let feedTimer = null;
async function pollFeed() {
  try {
    const r = await fetch('/api/calls?product=web_bot&limit=10', {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const data = await r.json();
    const items = data.items || [];
    renderFeed(items);
    maybeRenderPostChat(items[0]);
  } catch {}
}

function startFeed() {
  if (feedTimer) clearInterval(feedTimer);
  pollFeed();
  feedTimer = setInterval(pollFeed, POLL_MS);
}

// --- boot ----------------------------------------------------------------

(async () => {
  const me = await loadMe();
  if (!me) return;
  wireLogout();
  wireLineToggle();
  wireStageForm();
  wireStageActions();
  wireAutoOffBeacons();
  await loadLineState();
  await loadStage();
  // On page load with no active stage, reset widget state so the next
  // demo opens with a clean conversation.
  if (!currentStage) clearRetellWidgetState();
  debugRecaptcha('boot');
  startFeed();
})();
