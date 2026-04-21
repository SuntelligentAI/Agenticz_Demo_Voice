(async () => {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      location.replace('/dashboard');
    } else {
      location.replace('/login');
    }
  } catch {
    location.replace('/login');
  }
})();
