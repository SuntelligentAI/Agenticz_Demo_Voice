// Receptionist live dashboard.
// - Master line toggle (persisted server-side in system_settings)
// - Staged demo: create / view / clear; 15-minute countdown
// - Live activity feed: /api/calls?product=receptionist&limit=10 every 5s
// - When the top call is active or freshly ended: full live card + post-call
//   panel via window.AgenticzPostCall.

const RULES = {
  agentName: { min: 2, max: 40, pattern: /^[\p{L}\s'\-]+$/u, label: 'Agent name' },
  companyName: { min: 2, max: 80, label: 'Company name' },
  companyDescription: { min: 10, max: 400, label: 'Company description' },
  callPurpose: { min: 10, max: 400, label: 'Call purpose' },
};
const FIELD_KEYS = Object.keys(RULES);

const POLL_MS = 5000;
const TERMINAL = new Set(['ended', 'failed']);

// --- utilities ---------------------------------------------------------

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
function clearAllFieldErrors() {
  for (const k of FIELD_KEYS) showFieldError(k, '');
}
function setFormError(msg) {
  document.getElementById('form-error').textContent = msg || '';
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
function formatMMSS(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function loginRedirect() {
  location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
}

// --- auth / session ----------------------------------------------------

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

// --- line toggle -------------------------------------------------------

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
  // Only show the banner when the line is currently OFF and the last change
  // was made by an auto-trigger. A manual OFF should stay quiet.
  if (enabled || !reason || !reason.startsWith('auto_off:')) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const label = {
    'auto_off:logout': 'Line switched off — operator logged out.',
    'auto_off:tab_close': 'Line switched off — dashboard tab was closed.',
    'auto_off:idle_30min':
      'Line switched off — 30 minutes of no stage activity.',
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
    const r = await fetch('/api/settings/receptionist-line', { credentials: 'same-origin' });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const data = await r.json();
    lineEnabled = Boolean(data.enabled);
    if (typeof data.number === 'string' && data.number) {
      RECEPTIONIST_NUMBER = data.number.trim();
    }
    renderLineState();
    renderAutoOffBanner({ enabled: lineEnabled, reason: data.reason });
    // If a stage is already rendered, re-render the number display.
    if (currentStage) {
      document.getElementById('staged-number').textContent =
        RECEPTIONIST_NUMBER || '(set RETELL_RECEPTIONIST_NUMBER on the server)';
    }
  } catch {}
}

async function setLineState(next) {
  // If turning off while a stage is active, confirm.
  if (!next && currentStage) {
    const ok = window.confirm(
      'A demo is currently staged. Turning the line off will route the next caller to the fallback message. Continue?',
    );
    if (!ok) return;
  }
  const toggle = document.getElementById('line-toggle');
  toggle.disabled = true;
  try {
    const r = await fetch('/api/settings/receptionist-line', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) {
      console.error('Line toggle failed', r.status);
      return;
    }
    const data = await r.json();
    lineEnabled = Boolean(data.enabled);
    renderLineState();
  } finally {
    toggle.disabled = false;
  }
}

function wireLineToggle() {
  document.getElementById('line-toggle').addEventListener('click', () => {
    // Any deliberate toggle clears the auto-off banner immediately.
    const banner = document.getElementById('auto-off-banner');
    if (banner) { banner.hidden = true; banner.textContent = ''; }
    setLineState(!lineEnabled);
  });
}

// Best-effort: when the operator closes the tab or navigates away, flip
// the shared line OFF so an unattended dashboard doesn't leave the number
// answering under a stale context. Mobile + flaky networks may drop this
// beacon; the server-side idle check is the safety net.
function sendAutoOffBeacon(reason) {
  if (!lineEnabled) return;
  try {
    const body = JSON.stringify({ enabled: false, reason });
    // Plain string → text/plain; the server parses it defensively.
    navigator.sendBeacon('/api/settings/receptionist-line', body);
  } catch {}
}

function wireAutoOffBeacons() {
  window.addEventListener('pagehide', () => {
    sendAutoOffBeacon('auto_off:tab_close');
  });
  window.addEventListener('beforeunload', () => {
    sendAutoOffBeacon('auto_off:tab_close');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      sendAutoOffBeacon('auto_off:tab_close');
    }
  });
}

// --- stage -------------------------------------------------------------

let currentStage = null;
let countdownTimer = null;
let RECEPTIONIST_NUMBER = '';

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
  document.getElementById('staged-number').textContent =
    RECEPTIONIST_NUMBER || '(set RETELL_RECEPTIONIST_NUMBER on the server)';

  const updateCountdown = () => {
    const remaining = stage.expiresAt - Date.now();
    const el = document.getElementById('staged-countdown');
    if (remaining <= 0) {
      el.textContent = 'Expired';
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      // Re-fetch in case we want to swap back to the form
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
    const r = await fetch('/api/receptionist/stage', { credentials: 'same-origin' });
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
    for (const k of FIELD_KEYS) {
      inputs[k] = document.getElementById(k).value;
    }
    let firstError = null;
    for (const k of FIELD_KEYS) {
      const msg = validateField(k, inputs[k]);
      if (msg) {
        showFieldError(k, msg);
        if (!firstError) firstError = k;
      }
    }
    if (firstError) { document.getElementById(firstError).focus(); return; }

    const btn = document.getElementById('submit-stage');
    btn.disabled = true;
    btn.textContent = 'Staging…';

    try {
      const r = await fetch('/api/receptionist/stage', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
      });
      if (r.status === 401) { loginRedirect(); return; }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setFormError(data.error || `Could not stage (${r.status}).`);
        return;
      }
      // Clear form inputs now that the stage is saved
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
      const r = await fetch('/api/receptionist/stage', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (r.status === 401) { loginRedirect(); return; }
    } catch {}
    renderStage(null);
  });

  document.getElementById('copy-number').addEventListener('click', async () => {
    const num = RECEPTIONIST_NUMBER;
    const feedback = document.getElementById('copy-feedback');
    if (!num) {
      feedback.textContent = 'No number configured.';
      setTimeout(() => { feedback.textContent = ''; }, 2000);
      return;
    }
    try {
      await navigator.clipboard.writeText(num);
      feedback.textContent = 'Copied';
    } catch {
      feedback.textContent = num;
    }
    setTimeout(() => { feedback.textContent = ''; }, 2000);
  });
}

// --- live activity feed ------------------------------------------------

let feedTimer = null;
let currentLiveCallId = null;

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
    list.innerHTML = '<li class="feed-item"><span class="feed-meta"><span class="top">No receptionist calls yet.</span><span>Stage a demo and call the number to see activity here.</span></span></li>';
    return;
  }
  list.innerHTML = '';
  for (const row of items) {
    const a = document.createElement('a');
    a.className = 'feed-item';
    a.href = `/voice/receptionist/live/calls/${encodeURIComponent(row.id)}`;

    const left = document.createElement('div');
    left.className = 'feed-meta';
    const top = document.createElement('span');
    top.className = 'top';
    top.textContent = `${row.companyName || '—'} · ${row.prospectPhone || 'caller'}`;
    const bottom = document.createElement('span');
    const duration = formatDuration(row.durationSeconds);
    bottom.textContent = [
      formatDateTime(row.createdAt),
      duration ? `· ${duration}` : null,
      row.outcome ? `· ${row.outcome}` : null,
    ].filter(Boolean).join(' ');
    left.appendChild(top);
    left.appendChild(bottom);

    const pill = document.createElement('span');
    pill.className = `pill ${row.status || ''}`;
    pill.textContent = row.status || '—';

    a.appendChild(left);
    a.appendChild(pill);
    list.appendChild(a);
  }
}

function shouldShowLiveCard(topRow) {
  if (!topRow) return false;
  if (TERMINAL.has(topRow.status)) {
    // Show for 60s after terminal so the operator sees post-call artefacts.
    if (topRow.endedAt && Date.now() - topRow.endedAt < 60_000) return true;
    return false;
  }
  return true;
}

async function maybeRenderLiveCall(topRow) {
  const card = document.getElementById('live-call-card');
  if (!shouldShowLiveCard(topRow)) {
    card.classList.remove('visible');
    currentLiveCallId = null;
    return;
  }
  // Fetch the full row (includes transcript/recording/summary/notes)
  try {
    const r = await fetch(`/api/calls/${encodeURIComponent(topRow.id)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const row = await r.json();

    document.getElementById('live-call-sub').textContent =
      row.status === 'in_progress'
        ? 'On call — in progress.'
        : row.status === 'dialing'
          ? 'Dialling — caller ringing through.'
          : row.outcome
            ? `Call ended — outcome: ${row.outcome}.`
            : 'Call in progress.';

    const container = document.getElementById('post-call-content');
    if (window.AgenticzPostCall && container) {
      window.AgenticzPostCall.render(row, container, {
        onSave: (text) => saveCallNotes(row.id, text),
      });
    }
    card.classList.add('visible');
    currentLiveCallId = row.id;
  } catch {}
}

async function pollFeed() {
  try {
    const r = await fetch(
      '/api/calls?product=receptionist&limit=10',
      { credentials: 'same-origin', cache: 'no-store' },
    );
    if (r.status === 401) { loginRedirect(); return; }
    if (!r.ok) return;
    const data = await r.json();
    const items = data.items || [];
    renderFeed(items);
    maybeRenderLiveCall(items[0]);
  } catch {}
}

function startFeed() {
  if (feedTimer) clearInterval(feedTimer);
  pollFeed();
  feedTimer = setInterval(pollFeed, POLL_MS);
}

// --- boot --------------------------------------------------------------

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
  startFeed();
})();
