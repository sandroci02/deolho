const cameraList = document.getElementById('cameraList');
const configItemTemplate = document.getElementById('configItemTemplate');
const saveButton = document.getElementById('saveSettings');
const configMessage = document.getElementById('configMessage');
const globalResolution = document.getElementById('globalResolution');
const globalFps = document.getElementById('globalFps');

let cameras = [];

function setMessage(text, type = 'info') {
  configMessage.textContent = text;
  configMessage.className = `form-message ${type}`;
  setTimeout(() => {
    configMessage.className = 'form-message hidden';
  }, 3000);
}

async function loadAllCameras() {
  try {
    const response = await fetch('/api/cameras?noStreams=1');
    if (!response.ok) throw new Error('Falha ao carregar câmeras');
    cameras = await response.json();
    renderList();
  } catch (err) {
    setMessage(err.message, 'error');
  }
}

async function loadGlobalSettings() {
  try {
    const response = await fetch('/api/settings');
    if (!response.ok) throw new Error('Falha ao carregar settings globais');
    const settings = await response.json();
    globalResolution.value = settings.resolution;
    globalFps.value = settings.fps;
  } catch (err) {
    console.warn('Erro ao carregar settings globais:', err);
  }
}

function renderList() {
  cameraList.innerHTML = '';
  cameras.forEach((camera, index) => {
    const node = configItemTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.camera-name').textContent = camera.nome;
    node.querySelector('.camera-details').textContent = `IP ${camera.ip} | RTSP ${camera.portaRtsp || 554} | ONVIF ${camera.onvifPort || 8000} | ${String(camera.protocolo || 'tcp').toUpperCase()} | ${camera.caminho || '/onvif1'}`;
    
    const checkbox = node.querySelector('.visibility-toggle');
    checkbox.checked = camera.visivel;
    checkbox.addEventListener('change', () => {
      camera.visivel = checkbox.checked;
    });

    node.querySelector('.move-up').addEventListener('click', () => move(index, -1));
    node.querySelector('.move-down').addEventListener('click', () => move(index, 1));
    
    node.querySelector('.edit-btn').addEventListener('click', () => {
      window.location.href = `/nova.html?id=${camera.id}`;
    });

    cameraList.appendChild(node);
  });
}

function move(index, delta) {
  const newIndex = index + delta;
  if (newIndex < 0 || newIndex >= cameras.length) return;
  
  const item = cameras.splice(index, 1)[0];
  cameras.splice(newIndex, 0, item);
  renderList();
}

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  saveButton.textContent = 'Salvando...';

  // 1. Preparar payload de câmeras
  const bulkPayload = cameras.map((c, i) => ({
    id: c.id,
    ordem: i,
    visivel: c.visivel
  }));

  // 2. Preparar payload de settings globais
  const settingsPayload = {
    resolution: globalResolution.value,
    fps: Number(globalFps.value)
  };

  try {
    // Executar ambos os salvamentos em paralelo
    const [bulkRes, settingsRes] = await Promise.all([
      fetch('/api/cameras/bulk-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bulkPayload)
      }),
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsPayload)
      })
    ]);

    if (!bulkRes.ok) throw new Error('Falha ao salvar ordem das câmeras');
    if (!settingsRes.ok) throw new Error('Falha ao salvar configurações de economia');
    
    setMessage('Todas as configurações foram salvas!', 'success');
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Salvar Alterações';
  }
});

(async function init() {
  const user = await requireAuth();
  if (!user) return;
  
  // Parar câmeras ao entrar aqui por garantia
  fetch('/api/streams/stop-all', { method: 'POST' });

  await loadGlobalSettings();
  await loadAllCameras();
})();
