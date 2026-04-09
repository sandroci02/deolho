const grid = document.getElementById('cameraGrid');
const template = document.getElementById('cameraCardTemplate');
const appMessage = document.getElementById('appMessage');
const logoutButton = document.getElementById('logoutButton');
const configNav = document.querySelector('a[href="/configuracoes.html"]');
const addNav = document.querySelector('a[href="/nova.html"]');
const cardMap = new Map();
const backdrop = document.createElement('div');
backdrop.className = 'modal-backdrop';
document.body.appendChild(backdrop);

let expandedCard = null;
let expandedCameraId = null;
const DEFAULT_FPS = 10;
const FOCUS_FPS = 14;
const ECONOMY_FPS = 3;
const OBJECT_CLASS_RULES = {
  person: { label: 'pessoa', minScore: 0.45 },
  dog: { label: 'cachorro', minScore: 0.22 },
  cat: { label: 'gato', minScore: 0.28 },
};

let objectModelPromise = null;
let activeDetections = 0;
const MAX_CONCURRENT_DETECTIONS = 2;

function ensureObjectModel() {
  if (!objectModelPromise) {
    if (!window.cocoSsd) {
      objectModelPromise = Promise.reject(new Error('COCO-SSD indisponível'));
    } else {
      // Modelo mais preciso que o lite para melhorar detecção de animais.
      objectModelPromise = window.cocoSsd.load({ base: 'mobilenet_v2' });
    }
  }
  return objectModelPromise;
}

function getContainBounds(player, playerWrap) {
  const wrapW = playerWrap.clientWidth;
  const wrapH = playerWrap.clientHeight;
  const imgW = player.naturalWidth || 0;
  const imgH = player.naturalHeight || 0;

  if (!wrapW || !wrapH || !imgW || !imgH) return null;

  const wrapRatio = wrapW / wrapH;
  const imgRatio = imgW / imgH;
  let width;
  let height;
  let left;
  let top;

  if (imgRatio > wrapRatio) {
    width = wrapW;
    height = wrapW / imgRatio;
    left = 0;
    top = (wrapH - height) / 2;
  } else {
    height = wrapH;
    width = wrapH * imgRatio;
    left = (wrapW - width) / 2;
    top = 0;
  }

  return { left, top, width, height };
}

function fpsForCamera(cameraId) {
  if (!expandedCameraId) return DEFAULT_FPS;
  return Number(expandedCameraId) === Number(cameraId) ? FOCUS_FPS : ECONOMY_FPS;
}

function streamUrlFor(cameraId) {
  return `/api/stream/${cameraId}?fps=${fpsForCamera(cameraId)}`;
}

function applyStreamProfiles() {
  for (const view of cardMap.values()) {
    const nextUrl = streamUrlFor(view.cameraId);
    if (view.player.dataset.streamUrl !== nextUrl) {
      view.player.src = nextUrl;
      view.player.dataset.streamUrl = nextUrl;
    }
  }
}

function closeExpandedCard() {
  if (expandedCard) {
    expandedCard.classList.remove('expanded');
    expandedCard = null;
    expandedCameraId = null;
    backdrop.classList.remove('active');
    applyStreamProfiles();
  }
}

backdrop.addEventListener('click', closeExpandedCard);

function badgeClass(online) {
  return online ? 'badge online' : 'badge offline';
}

function badgeText(online) {
  return online ? 'online' : 'offline';
}

function setAppMessage(text, type = 'info') {
  appMessage.textContent = text;
  appMessage.className = `form-message ${type}`;
  setTimeout(() => {
    appMessage.textContent = '';
    appMessage.className = 'form-message hidden';
  }, 3000);
}

function createMotionDetector(view) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const state = {
    timer: null,
    previous: null,
    width: 160,
    height: 90,
    warmup: 0,
    cols: 20,
    rows: 12,
    tiles: [],
    onResize: null,
    onImageLoad: null,
  };

  function updateLayerBounds() {
    const bounds = getContainBounds(view.player, view.playerWrap);
    if (!bounds) {
      view.motionLayer.style.display = 'none';
      return false;
    }

    view.motionLayer.style.display = 'grid';
    view.motionLayer.style.left = `${bounds.left}px`;
    view.motionLayer.style.top = `${bounds.top}px`;
    view.motionLayer.style.width = `${bounds.width}px`;
    view.motionLayer.style.height = `${bounds.height}px`;
    return true;
  }

  function ensureTiles() {
    if (state.tiles.length > 0) return;
    const total = state.cols * state.rows;
    for (let i = 0; i < total; i += 1) {
      const tile = document.createElement('div');
      tile.className = 'motion-tile';
      view.motionLayer.appendChild(tile);
      state.tiles.push(tile);
    }
  }

  function clearTiles() {
    for (const tile of state.tiles) {
      tile.classList.remove('active');
    }
    view.motionLayer.classList.remove('active');
    view.motionBadge.classList.remove('active');
    view.node.classList.remove('motion-active');
  }

  function activateTiles(activeIndexes) {
    if (activeIndexes.length === 0) {
      clearTiles();
      return;
    }

    for (const tile of state.tiles) {
      tile.classList.remove('active');
    }

    for (const idx of activeIndexes) {
      if (state.tiles[idx]) {
        state.tiles[idx].classList.add('active');
      }
    }

    view.motionLayer.classList.add('active');
    view.motionBadge.classList.add('active');
    view.node.classList.add('motion-active');
  }

  function tick() {
    if (!view.player || !view.player.src) {
      clearTiles();
      return;
    }

    try {
      if (!updateLayerBounds()) {
        clearTiles();
        return;
      }

      ensureTiles();
      if (!canvas.width || !canvas.height) {
        canvas.width = state.width;
        canvas.height = state.height;
      }

      ctx.drawImage(view.player, 0, 0, state.width, state.height);
      const imageData = ctx.getImageData(0, 0, state.width, state.height);
      const current = imageData.data;

      if (!state.previous) {
        state.previous = new Uint8ClampedArray(current);
        clearTiles();
        return;
      }

      if (state.warmup < 3) {
        state.warmup += 1;
        state.previous = new Uint8ClampedArray(current);
        clearTiles();
        return;
      }

      const threshold = 18;
      const stepX = Math.floor(state.width / state.cols);
      const stepY = Math.floor(state.height / state.rows);
      const activeIndexes = [];

      for (let row = 0; row < state.rows; row += 1) {
        for (let col = 0; col < state.cols; col += 1) {
          const startX = col * stepX;
          const startY = row * stepY;
          let localChanges = 0;
          let samples = 0;

          for (let y = startY; y < Math.min(startY + stepY, state.height); y += 2) {
            for (let x = startX; x < Math.min(startX + stepX, state.width); x += 2) {
              const idx = (y * state.width + x) * 4;
              const dr = Math.abs(current[idx] - state.previous[idx]);
              const dg = Math.abs(current[idx + 1] - state.previous[idx + 1]);
              const db = Math.abs(current[idx + 2] - state.previous[idx + 2]);
              const delta = (dr + dg + db) / 3;
              samples += 1;
              if (delta > threshold) localChanges += 1;
            }
          }

          const ratio = samples > 0 ? (localChanges / samples) : 0;
          if (ratio > 0.08 && localChanges > 3) {
            activeIndexes.push(row * state.cols + col);
          }
        }
      }

      activateTiles(activeIndexes.slice(0, 80));

      state.previous = new Uint8ClampedArray(current);
    } catch (_err) {
      clearTiles();
    }
  }

  function start() {
    if (state.timer) return;
    state.onResize = () => {
      updateLayerBounds();
    };
    state.onImageLoad = () => {
      updateLayerBounds();
    };
    window.addEventListener('resize', state.onResize);
    view.player.addEventListener('load', state.onImageLoad);
    updateLayerBounds();
    state.timer = setInterval(tick, 220);
  }

  function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    state.previous = null;
    state.warmup = 0;
    if (state.onResize) {
      window.removeEventListener('resize', state.onResize);
      state.onResize = null;
    }
    if (state.onImageLoad) {
      view.player.removeEventListener('load', state.onImageLoad);
      state.onImageLoad = null;
    }
    view.motionLayer.style.display = 'none';
    clearTiles();
  }

  return { start, stop };
}

function createObjectDetector(view) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const state = {
    timer: null,
    running: false,
    busy: false,
    modelFailed: false,
    width: 416,
    height: 234,
    maxLongSide: 640,
    onResize: null,
    onImageLoad: null,
    lastPredictions: [],
    lastDetectedAt: 0,
    holdMs: 5000,
  };

  function clearBoxes() {
    view.objectLayer.innerHTML = '';
    view.objectLayer.classList.remove('active');
  }

  function updateLayerBounds() {
    const bounds = getContainBounds(view.player, view.playerWrap);
    if (!bounds) {
      view.objectLayer.style.display = 'none';
      return false;
    }

    view.objectLayer.style.display = 'block';
    view.objectLayer.style.left = `${bounds.left}px`;
    view.objectLayer.style.top = `${bounds.top}px`;
    view.objectLayer.style.width = `${bounds.width}px`;
    view.objectLayer.style.height = `${bounds.height}px`;
    return true;
  }

  function renderBoxes(predictions) {
    clearBoxes();
    if (!predictions.length) return;

    for (const pred of predictions) {
      const [x, y, w, h] = pred.bbox;
      const box = document.createElement('div');
      box.className = 'object-box';
      box.style.left = `${(x / state.width) * 100}%`;
      box.style.top = `${(y / state.height) * 100}%`;
      box.style.width = `${(w / state.width) * 100}%`;
      box.style.height = `${(h / state.height) * 100}%`;

      const label = document.createElement('span');
      label.className = 'object-label';
      label.textContent = `${pred.label || pred.class}`;
      box.appendChild(label);
      view.objectLayer.appendChild(box);
    }

    view.objectLayer.classList.add('active');
  }

  async function tick() {
    if (!state.running || state.busy || state.modelFailed) return;
    if (!view.player || !view.player.src || view.player.naturalWidth === 0) {
      clearBoxes();
      return;
    }

    if (!updateLayerBounds()) {
      clearBoxes();
      return;
    }

    if (activeDetections >= MAX_CONCURRENT_DETECTIONS) return;

    state.busy = true;
    activeDetections += 1;
    try {
      const model = await ensureObjectModel();
      const naturalW = view.player.naturalWidth || state.width;
      const naturalH = view.player.naturalHeight || state.height;
      const longSide = Math.max(naturalW, naturalH);
      const scale = longSide > state.maxLongSide ? (state.maxLongSide / longSide) : 1;
      const targetW = Math.max(160, Math.round(naturalW * scale));
      const targetH = Math.max(90, Math.round(naturalH * scale));

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        state.width = targetW;
        state.height = targetH;
      }

      ctx.drawImage(view.player, 0, 0, state.width, state.height);
      const predictions = await model.detect(canvas);
      const filtered = predictions
        .filter((pred) => {
          const rule = OBJECT_CLASS_RULES[pred.class];
          return Boolean(rule) && pred.score >= rule.minScore;
        })
        .map((pred) => ({
          ...pred,
          label: OBJECT_CLASS_RULES[pred.class]?.label || pred.class,
        }))
        .slice(0, 6);

      if (filtered.length > 0) {
        state.lastPredictions = filtered;
        state.lastDetectedAt = Date.now();
        renderBoxes(filtered);
      } else if (state.lastPredictions.length > 0 && Date.now() - state.lastDetectedAt <= state.holdMs) {
        renderBoxes(state.lastPredictions);
      } else {
        state.lastPredictions = [];
        clearBoxes();
      }
    } catch (_err) {
      state.modelFailed = true;
      clearBoxes();
    } finally {
      state.busy = false;
      activeDetections = Math.max(0, activeDetections - 1);
    }
  }

  function start() {
    if (state.timer) return;
    state.running = true;
    state.onResize = () => updateLayerBounds();
    state.onImageLoad = () => updateLayerBounds();
    window.addEventListener('resize', state.onResize);
    view.player.addEventListener('load', state.onImageLoad);
    updateLayerBounds();
    state.timer = setInterval(tick, 500);
  }

  function stop() {
    state.running = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (state.onResize) {
      window.removeEventListener('resize', state.onResize);
      state.onResize = null;
    }
    if (state.onImageLoad) {
      view.player.removeEventListener('load', state.onImageLoad);
      state.onImageLoad = null;
    }
    state.lastPredictions = [];
    state.lastDetectedAt = 0;
    view.objectLayer.style.display = 'none';
    clearBoxes();
  }

  return { start, stop };
}



function renderCard(camera) {
  const node = template.content.firstElementChild.cloneNode(true);
  const name = node.querySelector('.name');
  const meta = node.querySelector('.meta');
  const badge = node.querySelector('.badge');
  const player = node.querySelector('.player');
  const reconnectBtn = node.querySelector('.reconnect');
  const playerWrap = node.querySelector('.player-wrap');

  const motionBadge = document.createElement('span');
  motionBadge.className = 'motion-badge';
  motionBadge.textContent = 'movimento';
  node.querySelector('.card-head').appendChild(motionBadge);

  const motionLayer = document.createElement('div');
  motionLayer.className = 'motion-layer';
  playerWrap.appendChild(motionLayer);

  const objectLayer = document.createElement('div');
  objectLayer.className = 'object-layer';
  playerWrap.appendChild(objectLayer);

  const detector = createMotionDetector({ player, playerWrap, motionLayer, motionBadge, node });
  const objectDetector = createObjectDetector({ player, playerWrap, objectLayer });

  // Adicionar botão de fechar (apenas visível em modo expandido via CSS)
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-close-modal';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Fechar';
  node.querySelector('.card-head').appendChild(closeBtn);

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeExpandedCard();
  });

  node.addEventListener('click', (e) => {
    // Evitar que cliques em botões dentro do card fechem o modal por acidente
    if (e.target.closest('.btn') || e.target.closest('.ptz-btn')) return;

    if (node.classList.contains('expanded')) {
      closeExpandedCard();
    } else {
      closeExpandedCard(); // Fechar outro que possa estar aberto
      node.classList.add('expanded');
      expandedCard = node;
      expandedCameraId = camera.id;
      backdrop.classList.add('active');
      applyStreamProfiles();
    }
  });

  reconnectBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    reconnectBtn.disabled = true;
    reconnectBtn.textContent = 'Reconectando...';
    try {
      await fetch(`/api/reconnect/${camera.id}`, { method: 'POST' });
      await loadCameras();
      setAppMessage('Câmera reconectada.', 'success');
    } catch (err) {
      setAppMessage(err.message, 'error');
    } finally {
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = 'Reconectar';
    }
  });

  return { node, name, meta, badge, player, motionBadge, motionLayer, objectLayer, detector, objectDetector, cameraId: camera.id };
}

function updateCard(view, camera) {
  const online = Boolean(camera.status?.online);
  view.name.textContent = camera.nome;
  view.meta.textContent = `IP ${camera.ip} | RTSP ${camera.portaRtsp || 554} | ONVIF ${camera.onvifPort || 8000} | ${String(camera.protocolo || 'tcp').toUpperCase()} | ${camera.caminho || '/onvif1'}`;
  view.badge.className = badgeClass(online);
  view.badge.textContent = badgeText(online);

  if (online) {
    // Mantemos apenas detecção de pessoa/gato/cachorro.
    view.detector.stop();
    view.objectDetector.start();
  } else {
    view.detector.stop();
    view.objectDetector.stop();
  }

  const nextUrl = streamUrlFor(camera.id);
  if (view.player.dataset.streamUrl !== nextUrl) {
    view.player.src = nextUrl;
    view.player.dataset.streamUrl = nextUrl;
  }
}

async function loadCameras() {
  try {
    const response = await fetch('/api/cameras');
    if (response.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Falha ao carregar cameras');
    }
    const allCameras = await response.json();
    let cameras = allCameras.filter((c) => Number(c.visivel ?? 1) === 1);
    if (allCameras.length > 0 && cameras.length === 0) {
      cameras = allCameras;
      setAppMessage('Todas as câmeras estão ocultas na configuração. Exibindo para diagnóstico.', 'error');
    }
    
    // Ajustar grid baseado no numero de cameras
    grid.className = `grid count-${cameras.length}`;
    if (cameras.length > 9) grid.classList.add('count-many');

    const seen = new Set();
  for (const camera of cameras) {
    seen.add(camera.id);
    let view = cardMap.get(camera.id);
    if (!view) {
      view = renderCard(camera);
      cardMap.set(camera.id, view);
      grid.appendChild(view.node);
    }
    updateCard(view, camera);
  }
    for (const cameraId of Array.from(cardMap.keys())) {
      if (!seen.has(cameraId)) {
        const view = cardMap.get(cameraId);
        view.detector.stop();
        view.objectDetector.stop();
        view.node.remove();
        cardMap.delete(cameraId);
      }
    }
  } catch (err) {
    console.error('loadCameras error:', err);
    setAppMessage(err.message || 'Falha ao carregar cameras', 'error');
  }
}

// logoutButton.addEventListener('click', logoutAndRedirect);
logoutButton.addEventListener('click', logoutAndRedirect);

(async function init() {
  const user = await requireAuth();
  if (!user) return;

  const stopAll = () => fetch('/api/streams/stop-all', { method: 'POST' });
  configNav?.addEventListener('click', stopAll);
  addNav?.addEventListener('click', stopAll);
  window.addEventListener('unload', stopAll);

  ensureObjectModel().catch(() => {
    setAppMessage('IA indisponível agora. A detecção de objetos será desativada.', 'error');
  });

  await loadCameras();
  setInterval(loadCameras, 7000);
})();
