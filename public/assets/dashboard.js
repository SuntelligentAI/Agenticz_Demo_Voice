(async () => {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.status === 401) {
      location.replace('/login');
      return;
    }
    if (!res.ok) throw new Error(`Unexpected status ${res.status}`);
    const data = await res.json();
    document.getElementById('user-email').textContent = data.email || '';
    document.body.classList.add('ready');

    document.getElementById('logout').addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
        });
      } catch {}
      location.replace('/login');
    });
  } catch {
    location.replace('/login');
  }
})();
