// Hydrates the top-right nav with auth-aware controls. Runs on every public
// page. Uses /api/auth/me to detect session; on 401 shows a "Log in" link,
// otherwise shows the user's email + a "Log out" button.
//
// Also toggles any [data-auth="in"] / [data-auth="out"] elements on the page
// so leaf pages can swap their primary CTA based on session state.

(function () {
  function nextForCurrentPage() {
    const path = location.pathname + location.search;
    return `?next=${encodeURIComponent(path)}`;
  }

  function renderLoggedOut(container) {
    container.innerHTML = '';
    const a = document.createElement('a');
    a.href = '/login' + nextForCurrentPage();
    a.className = 'nav-link';
    a.textContent = 'Log in';
    container.appendChild(a);
  }

  function renderLoggedIn(container, email) {
    container.innerHTML = '';

    const dashLink = document.createElement('a');
    dashLink.href = '/voice/speed-to-lead/live';
    dashLink.className = 'nav-link';
    dashLink.textContent = 'Dashboard';
    container.appendChild(dashLink);

    if (email) {
      const emailEl = document.createElement('span');
      emailEl.className = 'user-email';
      emailEl.textContent = email;
      container.appendChild(emailEl);
    }

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'nav-link';
    logoutBtn.textContent = 'Log out';
    logoutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
        });
      } catch {}
      location.reload();
    });
    container.appendChild(logoutBtn);
  }

  function toggleAuthSections(loggedIn) {
    for (const el of document.querySelectorAll('[data-auth="in"]')) {
      el.hidden = !loggedIn;
    }
    for (const el of document.querySelectorAll('[data-auth="out"]')) {
      el.hidden = loggedIn;
    }
  }

  async function init() {
    const container = document.querySelector('[data-nav-slot]');
    let loggedIn = false;
    let email = '';
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        loggedIn = true;
        email = data?.email || '';
      }
    } catch {
      // Treat network failure as logged-out for UI purposes.
    }
    if (container) {
      if (loggedIn) renderLoggedIn(container, email);
      else renderLoggedOut(container);
    }
    toggleAuthSections(loggedIn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
