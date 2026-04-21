const PAGE_LIMIT = 20;
let currentPage = 1;
let currentTotalPages = 1;

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

function outcomeLabel(row) {
  if (row.outcome) return row.outcome;
  if (row.status === 'failed') return 'failed';
  if (row.status === 'dialing' || row.status === 'pending') return 'in progress';
  if (row.status === 'in_progress') return 'on call';
  return row.status || '—';
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

async function loadPage(page) {
  const root = document.getElementById('history-root');
  root.innerHTML = '<div class="empty-state">Loading…</div>';

  let res;
  try {
    res = await fetch(
      `/api/calls?page=${encodeURIComponent(page)}&limit=${PAGE_LIMIT}`,
      { credentials: 'same-origin', cache: 'no-store' },
    );
  } catch {
    root.innerHTML = '<div class="empty-state">Network error. Try again.</div>';
    return;
  }
  if (res.status === 401) {
    location.replace('/login');
    return;
  }
  if (!res.ok) {
    root.innerHTML = `<div class="empty-state">Could not load history (${res.status}).</div>`;
    return;
  }

  const data = await res.json();
  currentPage = data.page || page;
  currentTotalPages = data.totalPages || 1;

  if (!data.items || data.items.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        No calls yet. <a href="/dashboard">Start your first demo call</a>.
      </div>
    `;
    document.getElementById('pagination').hidden = true;
    return;
  }

  renderTable(root, data.items);
  renderPagination(data);
}

function renderTable(root, items) {
  const table = document.createElement('table');
  table.className = 'history';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const h of [
    'When',
    'Prospect',
    'Company',
    'Duration',
    'Outcome',
    'Retell ID',
  ]) {
    const th = document.createElement('th');
    th.textContent = h;
    if (h === 'Retell ID') th.className = 'cell-retell';
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of items) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.addEventListener('click', () => {
      location.href = `/calls/${encodeURIComponent(row.id)}`;
    });
    tr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        location.href = `/calls/${encodeURIComponent(row.id)}`;
      }
    });

    const td = (text, className) => {
      const el = document.createElement('td');
      el.textContent = text;
      if (className) el.className = className;
      return el;
    };

    tr.appendChild(td(formatDateTime(row.createdAt)));
    tr.appendChild(td(row.prospectName || '—'));
    tr.appendChild(td(row.companyName || '—'));
    tr.appendChild(td(formatDuration(row.durationSeconds), 'cell-duration'));
    tr.appendChild(td(outcomeLabel(row), 'cell-outcome'));
    tr.appendChild(td(row.retellCallId || '—', 'cell-retell'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  root.innerHTML = '';
  root.appendChild(table);
}

function renderPagination({ page, totalPages, total }) {
  const pg = document.getElementById('pagination');
  if (totalPages <= 1) {
    pg.hidden = true;
    return;
  }
  pg.hidden = false;
  document.getElementById('pagination-info').textContent =
    `Page ${page} of ${totalPages} · ${total} calls`;
  document.getElementById('prev-page').disabled = page <= 1;
  document.getElementById('next-page').disabled = page >= totalPages;
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

function wirePagination() {
  document.getElementById('prev-page').addEventListener('click', () => {
    if (currentPage > 1) loadPage(currentPage - 1);
  });
  document.getElementById('next-page').addEventListener('click', () => {
    if (currentPage < currentTotalPages) loadPage(currentPage + 1);
  });
}

(async () => {
  const user = await loadMe();
  if (!user) return;
  wireLogout();
  wirePagination();
  await loadPage(1);
})();
