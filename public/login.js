// Login page: posts the credentials to /auth/login, then opens the workspace.
const form = document.getElementById('login-form');
const loginInput = document.getElementById('login-name');
const passwordInput = document.getElementById('login-password');
const submit = document.getElementById('login-submit');
const errorBox = document.getElementById('login-error');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

// Already logged in (or authentication disabled): go straight to the workspace.
fetch('/auth/me', {cache: 'no-store'}).then(response => { if (response.ok) location.replace('/'); }).catch(() => {});

form.addEventListener('submit', async event => {
  event.preventDefault();
  showError('');
  submit.disabled = true;
  try {
    const response = await fetch('/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({login: loginInput.value.trim(), password: passwordInput.value})});
    let body = {};
    try { body = await response.json(); } catch (_) { /* Not JSON: use the generic message. */ }
    if (!response.ok) throw new Error(body.error || 'Login failed.');
    location.replace('/');
  } catch (error) {
    showError(error.message);
    passwordInput.select();
  } finally { submit.disabled = false; }
});
