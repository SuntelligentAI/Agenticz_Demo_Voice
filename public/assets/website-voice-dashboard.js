// Website Voice Bot live dashboard.
// - Master line toggle (website_voice_enabled in system_settings)
// - Stage create/view/clear with 15-minute countdown
// - Click-to-talk orb backed by Retell Web Client SDK
// - Cal.com iframe handoff after a successful call
// - Live feed polling /api/calls?product=website_voice_bot

const RULES = {
  agentName: { min: 2, max: 40, pattern: /^[\p{L}\s'\-]+$/u, label: 'Agent name' },
  companyName: { min: 2, max: 80, label: 'Company name' },
  companyDescription: { min: 10, max: 400, label: 'Company description' },
  callPurpose: { min: 10, max: 400, label: 'Call purpose' },
};
const FIELD_KEYS = Object.keys(RULES);

const POLL_MS = 5000;
const TERMINAL = new Set(['ended', 'failed']);

// Mirror of lib/orb.js — tiny lookup, keep the client JS as a plain
// script (no bundler) so this duplicates rather than imports.
const ORB_STATE_BY_EVENT = {
  call_started: 'listening',
  agent_start_talking: 'speaking',
  agent_stop_talking: 'listening',
  call_ended: 'idle',
  error: 'idle',
};

const CAL_URL = 'https://cal.com/suntelligent-ai/discovery-call';

// --- tiny helpers ---------------------------------------------------------

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

// --- line toggle ---------------------------------------------------------

let lineEnabled = false;

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
    const r = await fetch('/api/settings/website-voice-line', { credentials: 'same-origin' });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const data = await r.json();
    lineEnabled = Boolean(data.enabled);
    renderLineState();
    renderAutoOffBanner({ enabled: lineEnabled, reason: data.reason });
  } catch {}
}

async function setLineState(next) {
  if (!next && currentStage) {
    const ok = window.confirm(
      'A demo is currently staged. Turning the line off will block the voice widget. Continue?',
    );
    if (!ok) return;
  }
  const toggle = document.getElementById('line-toggle');
  toggle.disabled = true;
  try {
    const r = await fetch('/api/settings/website-voice-line', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const data = await r.json();
    lineEnabled = Boolean(data.enabled);
    renderLineState();
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
    navigator.sendBeacon('/api/settings/website-voice-line', body);
  } catch {}
}

function wireAutoOffBeacons() {
  window.addEventListener('pagehide', () => sendAutoOffBeacon('auto_off:tab_close'));
  window.addEventListener('beforeunload', () => sendAutoOffBeacon('auto_off:tab_close'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      sendAutoOffBeacon('auto_off:tab_close');
    }
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
}

async function loadStage() {
  try {
    const r = await fetch('/api/website-voice/stage', { credentials: 'same-origin' });
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
      const r = await fetch('/api/website-voice/stage', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
      });
      if (r.status === 401) { loginRedirect(); return; }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setFormError(data.error || `Could not stage (${r.status}).`); return; }
      for (const k of FIELD_KEYS) document.getElementById(k).value = '';
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
      const r = await fetch('/api/website-voice/stage', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (r.status === 401) { loginRedirect(); return; }
    } catch {}
    renderStage(null);
  });
}

// --- orb + Retell Web SDK ------------------------------------------------

let retellClient = null;
let currentDemoCallId = null;
const orbEl = () => document.getElementById('orb');
const orbCaptionEl = () => document.getElementById('orb-caption');
const orbErrorEl = () => document.getElementById('orb-error');
const endCallBtnEl = () => document.getElementById('end-call');

function setOrbStateFromEvent(eventName) {
  const next = ORB_STATE_BY_EVENT[eventName];
  if (!next) return;
  const el = orbEl();
  el.classList.remove('listening', 'speaking');
  if (next === 'listening') el.classList.add('listening');
  else if (next === 'speaking') el.classList.add('speaking');
  // 'idle' — remove both classes (back to the default CSS animation)
}

function setOrbCaption(text) {
  orbCaptionEl().textContent = text;
}

async function getRetellSdk() {
  if (window.AgenticzRetellWebClient) return window.AgenticzRetellWebClient;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Voice SDK load timed out')), 15000);
    window.addEventListener(
      'agenticz-retell-sdk-ready',
      () => {
        clearTimeout(timeout);
        resolve(window.AgenticzRetellWebClient);
      },
      { once: true },
    );
  });
}

function hideBookingCard() {
  const card = document.getElementById('booking-card');
  card.classList.remove('visible');
  const frame = document.getElementById('booking-iframe');
  // Clear the iframe src so it doesn't keep a live connection to Cal.com
  frame.src = 'about:blank';
}

function showBookingCard() {
  const card = document.getElementById('booking-card');
  const frame = document.getElementById('booking-iframe');
  if (frame.src === 'about:blank' || !frame.src) {
    frame.src = CAL_URL;
  }
  card.classList.add('visible');
}

async function startWebCall() {
  orbErrorEl().textContent = '';
  hideBookingCard();

  if (!lineEnabled) {
    orbErrorEl().textContent = 'Turn the line on before starting a call.';
    return;
  }
  if (!currentStage) {
    orbErrorEl().textContent = 'Stage a demo first.';
    return;
  }

  let SdkClass;
  try {
    SdkClass = await getRetellSdk();
  } catch (err) {
    orbErrorEl().textContent = err?.message || 'Voice SDK unavailable.';
    return;
  }

  const orb = orbEl();
  orb.disabled = true;
  setOrbCaption('Connecting…');

  let r;
  try {
    r = await fetch('/api/website-voice/web-call', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch {
    orb.disabled = false;
    setOrbCaption('Click to talk');
    orbErrorEl().textContent = 'Network error — could not start call.';
    return;
  }

  if (r.status === 401) { loginRedirect(); return; }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    orb.disabled = false;
    setOrbCaption('Click to talk');
    orbErrorEl().textContent = body?.error || `Could not start call (${r.status}).`;
    return;
  }

  currentDemoCallId = body.demoCallId;

  try {
    retellClient = new SdkClass();
  } catch (err) {
    orb.disabled = false;
    setOrbCaption('Click to talk');
    orbErrorEl().textContent = 'Could not initialise voice client.';
    return;
  }

  retellClient.on?.('call_started', () => {
    setOrbStateFromEvent('call_started');
    setOrbCaption('On call');
    endCallBtnEl().hidden = false;
  });
  retellClient.on?.('agent_start_talking', () => setOrbStateFromEvent('agent_start_talking'));
  retellClient.on?.('agent_stop_talking', () => setOrbStateFromEvent('agent_stop_talking'));
  retellClient.on?.('call_ended', (payload) => handleCallEnded(payload, /*errored=*/ false));
  retellClient.on?.('error', (payload) => handleCallEnded(payload, /*errored=*/ true));

  try {
    await retellClient.startCall({ accessToken: body.accessToken });
    orb.disabled = false;
  } catch (err) {
    orb.disabled = false;
    setOrbCaption('Click to talk');
    orbErrorEl().textContent =
      'Could not start the call. Check mic permission and try again.';
    retellClient = null;
  }
}

function handleCallEnded(_payload, errored) {
  setOrbStateFromEvent('call_ended');
  setOrbCaption('Click to talk');
  endCallBtnEl().hidden = true;
  const orb = orbEl();
  orb.disabled = false;

  try { retellClient?.stopCall?.(); } catch {}
  retellClient = null;

  if (errored) {
    orbErrorEl().textContent = 'Call ended with an error. Try again.';
    hideBookingCard();
  } else {
    orbErrorEl().textContent = '';
    showBookingCard();
  }

  // Kick the feed immediately so the post-call panel populates fast.
  pollFeed();
}

function wireOrb() {
  orbEl().addEventListener('click', () => {
    startWebCall();
  });
  endCallBtnEl().addEventListener('click', () => {
    try { retellClient?.stopCall?.(); } catch {}
    handleCallEnded(null, /*errored=*/ false);
  });
}

// --- post-call + feed ----------------------------------------------------

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
    list.innerHTML = '<li class="feed-item"><span class="feed-meta"><span class="top">No web calls yet.</span><span>Click the orb above to start one.</span></span></li>';
    return;
  }
  list.innerHTML = '';
  for (const row of items) {
    const a = document.createElement('a');
    a.className = 'feed-item';
    a.href = `/voice/website-voice-bot/live/calls/${encodeURIComponent(row.id)}`;
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

async function maybeRenderPostCall(topRow) {
  const card = document.getElementById('post-call-card');
  if (!topRow) { card.classList.remove('visible'); return; }
  if (!TERMINAL.has(topRow.status) && Date.now() - (topRow.createdAt || 0) > 60_000) {
    // not terminal + not recent: don't render (it's covered by the live flow)
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
  } catch {}
}

let feedTimer = null;
async function pollFeed() {
  try {
    const r = await fetch('/api/calls?product=website_voice_bot&limit=10', {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const data = await r.json();
    const items = data.items || [];
    renderFeed(items);
    maybeRenderPostCall(items[0]);
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
  wireOrb();
  await loadLineState();
  await loadStage();
  startFeed();
})();
