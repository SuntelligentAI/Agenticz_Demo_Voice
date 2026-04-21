const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');
const submit = document.getElementById('submit');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorEl.textContent = '';
  submit.disabled = true;
  emailInput.disabled = true;
  passwordInput.disabled = true;

  try {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (res.ok) {
      location.replace('/dashboard');
      return;
    }

    let body = {};
    try {
      body = await res.json();
    } catch {}
    errorEl.textContent = body.error || 'Login failed. Please try again.';
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    submit.disabled = false;
    emailInput.disabled = false;
    passwordInput.disabled = false;
    passwordInput.focus();
    passwordInput.select();
  }
});
