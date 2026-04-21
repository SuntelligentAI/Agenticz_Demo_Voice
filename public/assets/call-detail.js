function formatDateTime(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function statusText(status) {
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
      return status || '—';
  }
}

function getCallIdFromPath() {
  const match = /^\/calls\/([^\/?#]+)/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
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

function renderMeta(row) {
  document.getElementById('meta-title').textContent =
    row.companyName
      ? `${row.companyName} — call with ${row.prospectName || 'prospect'}`
      : 'Call';
  document.getElementById('meta-sub').textContent = `Agent: ${
    row.agentName || '—'
  }`;

  const pill = document.getElementById('meta-status');
  pill.textContent = statusText(row.status);
  pill.classList.remove('dialing', 'in_progress', 'ended', 'failed');
  const pillClass = row.status === 'pending' ? 'dialing' : row.status;
  if (pillClass) pill.classList.add(pillClass);

  document.getElementById('meta-outcome').textContent = row.outcome || '—';
  document.getElementById('meta-duration').textContent = formatDuration(
    row.durationSeconds,
  );
  document.getElementById('meta-prospect').textContent =
    row.prospectName && row.prospectPhone
      ? `${row.prospectName} (${row.prospectPhone})`
      : '—';
  document.getElementById('meta-started').textContent = row.startedAt
    ? formatDateTime(row.startedAt)
    : row.createdAt
      ? formatDateTime(row.createdAt)
      : '—';
  document.getElementById('meta-ended').textContent = formatDateTime(row.endedAt);
  document.getElementById('meta-retell-id').textContent =
    row.retellCallId || '—';

  document.getElementById('meta-card').hidden = false;
  document.getElementById('empty-card').hidden = true;
}

async function saveNotes(callId, notes) {
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

function showError(message) {
  document.getElementById('empty-message').textContent = message;
  document.getElementById('empty-card').hidden = false;
  document.getElementById('meta-card').hidden = true;
  document.getElementById('post-call-panel').hidden = true;
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

(async () => {
  const user = await loadMe();
  if (!user) return;
  wireLogout();

  const callId = getCallIdFromPath();
  if (!callId) {
    showError('No call id in URL.');
    return;
  }

  let res;
  try {
    res = await fetch(`/api/calls/${encodeURIComponent(callId)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    showError('Network error.');
    return;
  }

  if (res.status === 401) {
    location.replace('/login');
    return;
  }
  if (res.status === 404) {
    showError('Call not found. It may have been deleted or belong to another account.');
    return;
  }
  if (!res.ok) {
    showError(`Could not load call (${res.status}).`);
    return;
  }

  const row = await res.json();
  renderMeta(row);

  const container = document.getElementById('post-call-content');
  if (window.AgenticzPostCall && container) {
    window.AgenticzPostCall.render(row, container, {
      onSave: (text) => saveNotes(callId, text),
    });
    document.getElementById('post-call-panel').hidden = false;
  }
})();
