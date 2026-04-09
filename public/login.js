const loginForm = document.getElementById('loginForm');
const loginButton = document.getElementById('loginButton');
const inputUsuario = document.getElementById('usuario');
const inputSenha = document.getElementById('senha');
const authMessage = document.getElementById('authMessage');

function setMessage(text, type = 'info') {
  authMessage.textContent = text;
  authMessage.className = `form-message ${type}`;
}

async function init() {
  const me = await fetch('/api/auth/me');
  if (me.ok) {
    window.location.href = '/lista.html';
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  loginButton.textContent = 'Entrando...';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usuario: inputUsuario.value.trim(),
        senha: inputSenha.value,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Falha no login');
    }

    window.location.href = '/lista.html';
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Entrar';
  }
});

init();
