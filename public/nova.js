const formTitle = document.getElementById('formTitle');
const formMessage = document.getElementById('formMessage');
const cameraForm = document.getElementById('cameraForm');
const saveButton = document.getElementById('saveButton');

const inputCameraId = document.getElementById('cameraId');
const inputNome = document.getElementById('nome');
const inputIp = document.getElementById('ip');
const inputSenha = document.getElementById('senha');
const deleteButton = document.getElementById('deleteButton');
const logoutButton = document.getElementById('logoutButton');

function setMessage(text, type = 'info') {
  formMessage.textContent = text;
  formMessage.className = `form-message ${type}`;
}

function resetForm() {
  inputCameraId.value = '';
  inputNome.value = '';
  inputIp.value = '';
  inputSenha.value = '';
  formTitle.textContent = 'Nova Câmera';
  formMessage.textContent = '';
  formMessage.className = 'form-message hidden';
  deleteButton.classList.add('hidden');
}

function fillForm(camera) {
  inputCameraId.value = camera.id;
  inputNome.value = camera.nome;
  inputIp.value = camera.ip;
  inputSenha.value = camera.senha || '';
  formTitle.textContent = `Editar Câmera: ${camera.nome}`;
  deleteButton.classList.remove('hidden');
}

async function loadCameraById(id) {
  const response = await fetch('/api/cameras');
  if (response.status === 401) {
    window.location.href = '/login.html';
    return null;
  }
  const cameras = await response.json();
  return cameras.find((camera) => camera.id === Number(id));
}

async function saveCamera(payload, cameraId) {
  const method = cameraId ? 'PUT' : 'POST';
  const endpoint = cameraId ? `/api/cameras/${cameraId}` : '/api/cameras';

  const response = await fetch(endpoint, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Falha ao salvar camera');
  }
}

cameraForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const payload = {
    nome: inputNome.value.trim(),
    ip: inputIp.value.trim(),
    usuario: 'admin',
    senha: inputSenha.value.trim(),
    onvifUsuario: 'admin',
    onvifSenha: inputSenha.value.trim(),
    caminho: '/onvif1',
    portaRtsp: 554,
    onvifPort: 8000,
    protocolo: 'tcp',
  };

  try {
    saveButton.disabled = true;
    saveButton.textContent = 'Salvando...';
    await saveCamera(payload, inputCameraId.value || null);
    window.location.href = '/lista.html?msg=saved';
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Salvar';
  }
});

deleteButton.addEventListener('click', async () => {
  const cameraId = inputCameraId.value;
  const nome = inputNome.value;
  if (!cameraId) return;

  const confirmed = window.confirm(`Tem certeza que deseja excluir a câmera "${nome}"?`);
  if (!confirmed) return;

  try {
    deleteButton.disabled = true;
    deleteButton.textContent = 'Excluindo...';
    const response = await fetch(`/api/cameras/${cameraId}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Falha ao excluir camera');
    }
    window.location.href = '/lista.html?msg=deleted';
  } catch (err) {
    setMessage(err.message, 'error');
    deleteButton.disabled = false;
    deleteButton.textContent = 'Excluir Câmera';
  }
});

async function init() {
  const user = await requireAuth();
  if (!user) return;

  // Parar câmeras ao entrar aqui por garantia
  fetch('/api/streams/stop-all', { method: 'POST' });

  resetForm();

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) return;

  const camera = await loadCameraById(id);
  if (!camera) {
    setMessage('Camera nao encontrada para edicao.', 'error');
    return;
  }

  fillForm(camera);
}

logoutButton.addEventListener('click', logoutAndRedirect);

init();
