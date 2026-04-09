const registerForm = document.getElementById('registerForm');
const registerButton = document.getElementById('registerButton');
const inputNome = document.getElementById('nome');
const inputUsuario = document.getElementById('usuario');
const inputSenha = document.getElementById('senha');
const authMessage = document.getElementById('authMessage');

function setMessage(text, type = 'info') {
  authMessage.textContent = text;
  authMessage.className = `form-message ${type}`;
}

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  registerButton.disabled = true;
  registerButton.textContent = 'Cadastrando...';

  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: inputNome.value.trim(),
        usuario: inputUsuario.value.trim(),
        senha: inputSenha.value,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Falha no cadastro');
    }

    window.location.href = '/lista.html';
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    registerButton.disabled = false;
    registerButton.textContent = 'Cadastrar';
  }
});
