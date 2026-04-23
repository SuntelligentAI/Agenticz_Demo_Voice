const DEFAULT_NEXT = '/voice/speed-to-lead/live';

const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');
const submit = document.getElementById('submit');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');

function readNext() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('next') || '';
  // Client-side sanitize mirrors server-side sanitizeNext. Server is the
  // authority; this just prevents a malformed `next` from even being sent.
  if (!raw) return '';
  if (raw.length > 512) return '';
  if (!raw.startsWith('/')) return '';
  if (raw.includes('//') || raw.includes('\\')) return '';
  if (/[\s\x00-\x1F\x7F]/.test(raw)) return '';
  return raw;
}

const safeNext = readNext();

// Surface server-side error=1 from the 302 fallback (e.g. if a non-JS form
// POST comes back after bad credentials).
(function showUrlError() {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) {
    errorEl.textContent = 'Invalid email or password';
  }
})();

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
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email, password, next: safeNext }),
    });

    if (res.ok) {
      let body = {};
      try {
        body = await res.json();
      } catch {}
      const target =
        (typeof body?.next === 'string' && body.next) ||
        safeNext ||
        DEFAULT_NEXT;
      location.replace(target);
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
