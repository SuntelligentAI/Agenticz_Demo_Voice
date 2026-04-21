// Client-side validation mirrors the server rules in lib/validation.js.
// The server is the authority; these rules only exist for immediate UX feedback.
const RULES = {
  agentName: { min: 2, max: 40, pattern: /^[\p{L}\s'\-]+$/u, label: 'Agent name' },
  companyName: { min: 2, max: 80, label: 'Company name' },
  companyDescription: { min: 10, max: 400, label: 'Company description' },
  callPurpose: { min: 10, max: 400, label: 'Call purpose' },
  prospectName: { min: 2, max: 60, label: 'Prospect name' },
  prospectPhone: { pattern: /^\+[1-9]\d{7,14}$/, label: 'Prospect phone' },
};

const FIELD_KEYS = Object.keys(RULES);

const POLL_INTERVAL_MS = 3000;
const POLL_FIRST_MS = 500;
const POLL_MAX_MS = 15 * 60 * 1000;
// After the call reaches a terminal state, keep polling long enough to catch
// Retell's call_analyzed event (transcript / recording / summary), which
// typically arrives 20–40 s after call_ended. We stop early if the analyzed
// artefacts are already present.
const POLL_TERMINAL_TAIL_MS = 60_000;
const TERMINAL_STATUSES = new Set(['ended', 'failed']);

function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function validateField(key, rawValue) {
  const value = clean(rawValue);
  const rule = RULES[key];
  if (/[<>]/.test(value)) {
    return `${rule.label} contains invalid characters.`;
  }
  if (key === 'prospectPhone') {
    if (!value || !rule.pattern.test(value)) {
      return 'Use international format, e.g. +447700900000.';
    }
    return null;
  }
  if (!value) return `${rule.label} is required.`;
  if (value.length < rule.min)
    return `${rule.label} must be at least ${rule.min} characters.`;
  if (value.length > rule.max)
    return `${rule.label} must be at most ${rule.max} characters.`;
  if (rule.pattern && !rule.pattern.test(value)) {
    return `${rule.label} contains unsupported characters.`;
  }
  return null;
}

function showFieldError(key, message) {
  const errEl = document.querySelector(`[data-error-for="${key}"]`);
  const fieldEl = document.getElementById(key)?.closest('.field');
  if (errEl) errEl.textContent = message || '';
  if (fieldEl) fieldEl.classList.toggle('has-error', Boolean(message));
}

function clearAllFieldErrors() {
  for (const key of FIELD_KEYS) showFieldError(key, '');
}

function setFormError(message) {
  document.getElementById('form-error').textContent = message || '';
}

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function statusLabel(status) {
  switch (status) {
    case 'pending':
    case 'dialing':
      return 'Dialling…';
    case 'in_progress':
      return 'On call';
    case 'ended':
      return 'Ended';
    case 'failed':
      return 'Failed';
    default:
      return 'Dialling…';
  }
}

function statusSubtext(row) {
  switch (row.status) {
    case 'pending':
    case 'dialing':
      return 'Dialling… waiting for the prospect to pick up.';
    case 'in_progress':
      return 'Call connected — on the line with the prospect.';
    case 'ended':
      return row.outcome
        ? `Call ended — outcome: ${row.outcome}.`
        : 'Call ended.';
    case 'failed':
      return row.outcome
        ? `Call failed — ${row.outcome}.`
        : 'Could not place the call.';
    default:
      return 'Starting…';
  }
}

function setStatus(row) {
  const pill = document.getElementById('status-pill');
  pill.textContent = statusLabel(row.status);
  pill.classList.remove('dialing', 'in_progress', 'ended', 'failed');
  // 'pending' shares the dialing visual — they're both pre-pickup states.
  const pillClass = row.status === 'pending' ? 'dialing' : row.status;
  if (pillClass) pill.classList.add(pillClass);

  document.getElementById('status-sub').textContent = statusSubtext(row);

  document.getElementById('status-outcome').textContent = row.outcome || '—';
  document.getElementById('status-duration').textContent =
    formatDuration(row.durationSeconds) || '—';

  document.getElementById('status-prospect').textContent =
    row.prospectName && row.prospectPhone
      ? `${row.prospectName} (${row.prospectPhone})`
      : '—';
  document.getElementById('status-started').textContent = row.startedAt
    ? formatTime(row.startedAt)
    : row.createdAt
      ? formatTime(row.createdAt)
      : '—';
  document.getElementById('status-retell-id').textContent =
    row.retellCallId || '—';
}

function showStatusCard() {
  document.getElementById('status-card').classList.add('visible');
}

function hideStatusCard() {
  document.getElementById('status-card').classList.remove('visible');
}

function hasPostCallData(row) {
  return Boolean(
    row &&
      (row.transcript ||
        row.recordingUrl ||
        row.aiSummary ||
        (row.capturedFields && typeof row.capturedFields === 'object') ||
        row.notes),
  );
}

function showPostCallPanel() {
  const panel = document.getElementById('post-call-panel');
  if (panel) panel.hidden = false;
}

function hidePostCallPanel() {
  const panel = document.getElementById('post-call-panel');
  if (panel) panel.hidden = true;
  const content = document.getElementById('post-call-content');
  if (content) {
    content.innerHTML = '';
    content.dataset.pcWired = '';
  }
}

async function saveCallNotes(callId, notes) {
  const res = await fetch(
    `/api/calls/${encodeURIComponent(callId)}/notes`,
    {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    },
  );
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('Session expired');
  }
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch {}
    throw new Error(body?.error || `Save failed (${res.status})`);
  }
  const body = await res.json();
  return body.notes || '';
}

function renderPostCallIfReady(row) {
  if (!row || !hasPostCallData(row)) return;
  const container = document.getElementById('post-call-content');
  if (!container || !window.AgenticzPostCall) return;
  window.AgenticzPostCall.render(row, container, {
    onSave: (text) => saveCallNotes(row.id, text),
  });
  showPostCallPanel();
}

let pollTimer = null;
let pollDeadline = 0;
let terminalAt = 0;

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function showNewCallButton() {
  const btn = document.getElementById('new-call');
  if (btn) btn.hidden = false;
}

function hideNewCallButton() {
  const btn = document.getElementById('new-call');
  if (btn) btn.hidden = true;
}

function onPollingStopped(reason) {
  showNewCallButton();
  const sub = document.getElementById('status-sub');
  if (!sub) return;
  if (reason === 'not_found') {
    sub.textContent =
      'Call not found. It may have been deleted. Click New call to start another.';
  } else if (reason === 'deadline') {
    sub.textContent =
      'Live updates timed out. Click New call to continue.';
  } else if (reason === 'error') {
    sub.textContent =
      'Live updates paused after repeated errors. Click New call to continue.';
  }
  // reason === 'terminal' leaves the existing subtext ("Call ended — ...") in place.
}

function scheduleNextPoll(id) {
  if (Date.now() >= pollDeadline) {
    stopPolling();
    onPollingStopped('deadline');
    return;
  }
  pollTimer = setTimeout(() => pollCall(id), POLL_INTERVAL_MS);
}

async function pollCall(id) {
  let res;
  try {
    res = await fetch(`/api/calls/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    // Network blip — keep trying until the deadline.
    scheduleNextPoll(id);
    return;
  }

  if (res.status === 401) {
    location.replace('/login');
    return;
  }
  if (res.status === 404) {
    stopPolling();
    onPollingStopped('not_found');
    return;
  }
  if (!res.ok) {
    scheduleNextPoll(id);
    return;
  }

  let row;
  try {
    row = await res.json();
  } catch {
    scheduleNextPoll(id);
    return;
  }

  setStatus(row);
  renderPostCallIfReady(row);

  if (TERMINAL_STATUSES.has(row.status)) {
    // If call_analyzed has already landed, we have all we need — stop now.
    if (hasPostCallData(row)) {
      stopPolling();
      onPollingStopped('terminal');
      return;
    }
    if (!terminalAt) terminalAt = Date.now();
    if (Date.now() - terminalAt >= POLL_TERMINAL_TAIL_MS) {
      stopPolling();
      onPollingStopped('terminal');
      return;
    }
  } else {
    terminalAt = 0;
  }

  scheduleNextPoll(id);
}

function startPolling(id) {
  stopPolling();
  terminalAt = 0;
  pollDeadline = Date.now() + POLL_MAX_MS;
  // Fire the first poll quickly so the UI reflects server state almost
  // immediately, but leave a beat for the DB write to settle.
  pollTimer = setTimeout(() => pollCall(id), POLL_FIRST_MS);
}

function setFormDisabled(disabled, submitLabel) {
  for (const key of FIELD_KEYS) {
    const el = document.getElementById(key);
    if (el) el.disabled = disabled;
  }
  const submit = document.getElementById('submit');
  submit.disabled = disabled;
  if (submitLabel) submit.textContent = submitLabel;
}

function collectInputs() {
  const out = {};
  for (const key of FIELD_KEYS) {
    const el = document.getElementById(key);
    out[key] = el ? el.value : '';
  }
  return out;
}

async function loadMe() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.status === 401) {
      location.replace('/login');
      return null;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    document.getElementById('user-email').textContent = data.email || '';
    document.body.classList.add('ready');
    return data;
  } catch {
    location.replace('/login');
    return null;
  }
}

function wireLogout() {
  document.getElementById('logout').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {}
    location.replace('/login');
  });
}

function wireNewCall() {
  document.getElementById('new-call').addEventListener('click', () => {
    stopPolling();
    hideStatusCard();
    hidePostCallPanel();
    hideNewCallButton();
    setFormError('');
    clearAllFieldErrors();
    setFormDisabled(false, 'Call now');
    document.getElementById('agentName')?.focus();
  });
}

function wireForm() {
  const form = document.getElementById('call-form');

  for (const key of FIELD_KEYS) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener('blur', () => {
      const msg = validateField(key, el.value);
      showFieldError(key, msg);
    });
    el.addEventListener('input', () => {
      const errEl = document.querySelector(`[data-error-for="${key}"]`);
      if (errEl?.textContent) showFieldError(key, '');
    });
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    setFormError('');
    clearAllFieldErrors();

    const inputs = collectInputs();
    let firstErrorKey = null;
    for (const key of FIELD_KEYS) {
      const msg = validateField(key, inputs[key]);
      if (msg) {
        showFieldError(key, msg);
        if (!firstErrorKey) firstErrorKey = key;
      }
    }
    if (firstErrorKey) {
      document.getElementById(firstErrorKey)?.focus();
      return;
    }

    setFormDisabled(true, 'Starting call…');

    let res;
    let body = {};
    try {
      res = await fetch('/api/calls/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
      });
      body = await res.json().catch(() => ({}));
    } catch {
      setFormError('Network error. Please try again.');
      setFormDisabled(false, 'Call now');
      return;
    }

    if (res.status === 401) {
      location.replace('/login');
      return;
    }

    if (!res.ok) {
      const errorMessage =
        body?.error ||
        (res.status === 429
          ? 'Too many call attempts, please wait a few minutes.'
          : res.status === 502
            ? 'Could not place call. Try again.'
            : 'Could not start the call.');
      setFormError(errorMessage);
      setFormDisabled(false, 'Call now');
      return;
    }

    // Success — show status card immediately, keep form disabled, poll.
    const optimisticRow = {
      status: 'dialing',
      prospectName: clean(inputs.prospectName),
      prospectPhone: clean(inputs.prospectPhone),
      createdAt: Date.now(),
      retellCallId: body.retellCallId,
    };
    setStatus(optimisticRow);
    showStatusCard();
    hideNewCallButton();
    setFormDisabled(true, 'Call in progress…');
    startPolling(body.id);
  });
}

(async () => {
  const user = await loadMe();
  if (!user) return;
  wireLogout();
  wireNewCall();
  wireForm();
})();
