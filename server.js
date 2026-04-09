const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const ini = require('ini');
const Database = require('better-sqlite3');
const { Cam: OnvifCam } = require('onvif');

function resolveFfmpegBinary() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }

  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && ffmpegStatic.includes('app.asar')) {
      const unpackedPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpackedPath)) {
        return unpackedPath;
      }
    }

    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic;
    }
  } catch (_err) {
    // Fallback para ffmpeg instalado no sistema
  }

  return 'ffmpeg';
}

function hasSystemFfmpeg() {
  try {
    const result = spawnSync('which', ['ffmpeg'], { stdio: 'ignore' });
    return result.status === 0;
  } catch (_err) {
    return false;
  }
}

const app = express();
const PORT = process.env.PORT || 3333;
const APP_VERSION = require('./package.json').version;

// Ajuste para caminhos persistentes no Electron
let baseDataPath = __dirname;
if (process.versions.electron) {
  const electron = require('electron');
  // Se estiver no processo principal ou se o app ja estiver pronto
  if (electron.app) {
    baseDataPath = electron.app.getPath('userData');
  }
}

const CONFIG_PATH = path.join(baseDataPath, 'cameras.ini');
const DB_PATH = path.join(baseDataPath, 'cameras.db');
const LOGS_PATH = path.join(baseDataPath, 'camera-debug.log');
const ALLOWED_PROTOCOLS = new Set(['tcp', 'udp']);
const AUTH_COOKIE = 'camera_auth';
const AUTH_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET) {
  console.warn('AUTH_SECRET not set; using a temporary in-memory secret.');
}
const FFMPEG_BIN = resolveFfmpegBinary();
const FFMPEG_CANDIDATES = Array.from(
  new Set([
    FFMPEG_BIN,
    ...(hasSystemFfmpeg() ? ['ffmpeg'] : []),
  ])
);

const db = new Database(DB_PATH);

// Inicializar diretório se necessário
if (!fs.existsSync(baseDataPath)) {
  fs.mkdirSync(baseDataPath, { recursive: true });
}

function appendLog(level, message, camera = null) {
  const name = camera ? `[${camera.nome}]` : '[GERAL]';
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} ${level.toUpperCase()} ${name}: ${message}`;
  
  // Console
  console.log(logLine);
  
  // Arquivo
  try {
    fs.appendFileSync(LOGS_PATH, logLine + '\n');
    
    // Rotacionar log se ficar muito grande (> 10MB)
    const stats = fs.statSync(LOGS_PATH);
    if (stats.size > 10 * 1024 * 1024) {
      const timestamp = new Date().getTime();
      fs.renameSync(LOGS_PATH, `${LOGS_PATH}.${timestamp}`);
    }
  } catch (err) {
    console.error('Erro ao escrever log:', err.message);
  }
}

function maskRtspUrl(rtspUrl) {
  try {
    const url = new URL(rtspUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch (_err) {
    return rtspUrl;
  }
}

function parseResolution(value, fallback = { width: 640, height: 480 }) {
  if (!value || typeof value !== 'string') return fallback;
  const [w, h] = value.toLowerCase().split('x');
  const width = parseInt(w, 10);
  const height = parseInt(h, 10);
  if (!width || !height) return fallback;
  return { width, height };
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      resolution TEXT NOT NULL DEFAULT '640x480',
      fps INTEGER NOT NULL DEFAULT 10
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      ip TEXT NOT NULL,
      usuario TEXT,
      senha TEXT,
      onvif_usuario TEXT,
      onvif_senha TEXT,
      caminho TEXT DEFAULT '/onvif1',
      porta_rtsp INTEGER DEFAULT 554,
      onvif_port INTEGER DEFAULT 8000,
      protocolo TEXT DEFAULT 'udp',
      ordem INTEGER DEFAULT 0,
      visivel INTEGER DEFAULT 1
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      usuario TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const settingsExists = db.prepare('SELECT COUNT(*) AS total FROM settings').get().total;
  if (!settingsExists) {
    db.prepare('INSERT INTO settings (id, resolution, fps) VALUES (1, ?, ?)').run('640x480', 10);
  }

  appendLog('info', `DB_PATH: ${DB_PATH}`);
  const cameraColumns = db.prepare('PRAGMA table_info(cameras)').all();
  const colNames = cameraColumns.map(c => c.name);
  appendLog('info', `Colunas atuais detectadas: ${colNames.join(', ')}`);

  const migrations = [
    { name: 'onvif_port', sql: 'ALTER TABLE cameras ADD COLUMN onvif_port INTEGER NOT NULL DEFAULT 8000' },
    { name: 'onvif_usuario', sql: 'ALTER TABLE cameras ADD COLUMN onvif_usuario TEXT' },
    { name: 'onvif_senha', sql: 'ALTER TABLE cameras ADD COLUMN onvif_senha TEXT' },
    { name: 'ordem', sql: 'ALTER TABLE cameras ADD COLUMN ordem INTEGER DEFAULT 0' },
    { name: 'visivel', sql: 'ALTER TABLE cameras ADD COLUMN visivel INTEGER DEFAULT 1' },
    { name: 'user_id', sql: 'ALTER TABLE cameras ADD COLUMN user_id INTEGER REFERENCES users(id)' },
    { name: 'motion_enabled', sql: 'ALTER TABLE cameras ADD COLUMN motion_enabled INTEGER DEFAULT 1' }
  ];

  for (const m of migrations) {
    if (!colNames.includes(m.name)) {
      try {
        appendLog('info', `Executando migração: ${m.name}`);
        db.exec(m.sql);
      } catch (err) {
        appendLog('error', `Falha na migração ${m.name}: ${err.message}`);
      }
    }
  }

  // Migração: Remover NOT NULL de colunas existentes se necessário
  // Note: SQLite ALTER TABLE does not support removing NOT NULL directly.
  // A common workaround is to rename the table, create a new one, copy data, then drop old.
  // For simplicity and given the context, we'll assume new installations or manual schema adjustments.
  // If this were a production system, a more robust migration strategy would be needed.
  // For now, we'll just ensure the new columns are added.
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  const cookies = {};
  if (!raw) return cookies;

  const parts = String(raw).split(';');
  for (const part of parts) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    cookies[key] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}

function signAuthToken(payload) {
  const base = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(base).digest('base64url');
  return `${base}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [base, signature] = token.split('.');
  if (!base || !signature) return null;

  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(base).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(base, 'base64url').toString('utf-8'));
    if (!payload?.sub || !payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_err) {
    return null;
  }
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: AUTH_TTL_MS
  });
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE);
}

function authRequired(req, res, next) {
  const token = req.cookies[AUTH_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'Nao autenticado' });
    return;
  }
  const payload = verifyAuthToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Nao autenticado' });
    return;
  }

  const user = db.prepare('SELECT id, nome, usuario FROM users WHERE id = ?').get(Number(payload.sub));
  if (!user) {
    clearAuthCookie(res);
    res.status(401).json({ error: 'Sessao invalida' });
    return;
  }

  req.authUser = user;
  next();
}

function readIniBootstrap() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }

  return ini.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function bootstrapFromIniIfNeeded() {
  const total = db.prepare('SELECT COUNT(*) AS total FROM cameras').get().total;
  if (total > 0) return;

  const cfg = readIniBootstrap();
  if (!cfg) return;

  const resolution = cfg.geral?.resolucao || '640x480';
  const fps = Number(cfg.geral?.fps || 10);

  db.prepare('UPDATE settings SET resolution = ?, fps = ? WHERE id = 1').run(resolution, fps);

  const list = String(cfg.cameras?.lista || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const insert = db.prepare(`
    INSERT INTO cameras (nome, ip, usuario, senha, onvif_usuario, onvif_senha, caminho, porta_rtsp, onvif_port, protocolo, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  if (!firstUser) return;

  for (const sectionName of list) {
    const section = cfg[sectionName];
    if (!section) continue;
    if (!section.ip || !section.usuario || !section.senha) continue;

    const protocolo = String(section.protocolo || 'tcp').toLowerCase();
    const protoValid = ALLOWED_PROTOCOLS.has(protocolo) ? protocolo : 'tcp';

    insert.run(
      section.nome || sectionName,
      section.ip,
      section.usuario,
      section.senha,
      section.onvif_usuario || section.usuario,
      section.onvif_senha || section.senha,
      section.caminho || '/onvif1',
      Number(section.porta_rtsp || 554),
      Number(section.onvif_port || section.onvif_porta || 8000),
      protoValid,
      firstUser.id
    );
  }
}

function normalizeCameraInput(payload) {
  const nome = String(payload.nome || '').trim();
  const ip = String(payload.ip || '').trim();
  const usuario = String(payload.usuario || '').trim();
  const senha = String(payload.senha || '').trim();
  const onvifUsuario = String(payload.onvifUsuario || payload.onvif_usuario || usuario).trim();
  const onvifSenha = String(payload.onvifSenha || payload.onvif_senha || senha).trim();
  const caminhoRaw = String(payload.caminho || '/onvif1').trim();
  const caminho = caminhoRaw.startsWith('/') ? caminhoRaw : `/${caminhoRaw}`;
  const portaRtsp = Number(payload.portaRtsp ?? payload.porta_rtsp ?? 554);
  const onvifPort = Number(payload.onvifPort ?? payload.onvif_port ?? payload.onvif_porta ?? 8000);
  const protocolo = String(payload.protocolo || 'tcp').toLowerCase();
  const ordem = Number(payload.ordem ?? 0);
  const visivel = Number(payload.visivel ?? 1);
  const width = Number(payload.width || 640);
  const height = Number(payload.height || 480);
  const fps = Number(payload.fps || 10);
  const user_id = Number(payload.user_id || payload.userId || 0);

  if (!nome || !ip) { // Removed usuario and senha as NOT NULL from DB
    throw new Error('Campos obrigatorios: nome, ip');
  }
  if (!Number.isFinite(portaRtsp) || portaRtsp <= 0) {
    throw new Error('portaRtsp invalida');
  }
  if (!Number.isFinite(onvifPort) || onvifPort <= 0 || onvifPort > 65535) {
    throw new Error('onvifPort invalida');
  }
  if (!ALLOWED_PROTOCOLS.has(protocolo)) {
    throw new Error('protocolo invalido (use tcp ou udp)');
  }

  return {
    id: Number(payload.id),
    nome,
    ip,
    usuario,
    senha,
    onvifUsuario,
    onvifSenha,
    caminho,
    portaRtsp,
    onvifPort,
    protocolo,
    ordem,
    visivel,
    width,
    height,
    fps,
    user_id
  };
}

function makeRtspUrl(camera) {
  const user = encodeURIComponent(camera.usuario);
  const pass = encodeURIComponent(camera.senha);
  return `rtsp://${user}:${pass}@${camera.ip}:${camera.portaRtsp}${camera.caminho}`;
}

function getPtzDirectionVector(direction) {
  const map = {
    up: { x: 0, y: 0.5, zoom: 0 },
    down: { x: 0, y: -0.5, zoom: 0 },
    left: { x: -0.5, y: 0, zoom: 0 },
    right: { x: 0.5, y: 0, zoom: 0 },
    zoom_in: { x: 0, y: 0, zoom: 0.25 },
    zoom_out: { x: 0, y: 0, zoom: -0.25 },
  };
  return map[direction] || null;
}

function createOnvifClient(camera) {
  const configuredPort = Number(camera.onvifPort || 8000);
  const ports = Array.from(new Set([configuredPort, 8000, 5000, 80]))
    .filter((port) => Number.isFinite(port) && port > 0 && port <= 65535);

  return new Promise((resolve, reject) => {
    let index = 0;
    const errors = [];

    const tryNext = () => {
      if (index >= ports.length) {
        const summary = errors.length
          ? errors.join(' | ')
          : 'Nao foi possivel conectar ao ONVIF';
        reject(new Error(summary));
        return;
      }

      const port = ports[index++];
      const client = new OnvifCam(
        {
          hostname: camera.ip,
          username: camera.onvifUsuario || camera.usuario,
          password: camera.onvifSenha || camera.senha,
          port,
          timeout: 3000,
        },
        function onConnect(err) {
          if (err) {
            errors.push(`porta ${port}: ${err.message || err}`);
            tryNext();
            return;
          }
          resolve(client);
        }
      );
    };

    tryNext();
  });
}

async function movePtz(camera, direction, durationMs = 320) {
  const vector = getPtzDirectionVector(direction);
  if (!vector) {
    throw new Error('Direcao PTZ invalida');
  }

  const client = await createOnvifClient(camera);

  await new Promise((resolve, reject) => {
    client.continuousMove(
      {
        x: vector.x,
        y: vector.y,
        zoom: vector.zoom,
      },
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }
    );
  });

  await new Promise((resolve) => setTimeout(resolve, durationMs));

  await new Promise((resolve, reject) => {
    client.stop({ panTilt: true, zoom: true }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function stopPtz(camera) {
  const client = await createOnvifClient(camera);
  await new Promise((resolve, reject) => {
    client.stop({ panTilt: true, zoom: true }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function extractJpegFrames(buffer, onFrame) {
  const frames = [];
  let start = buffer.indexOf(Buffer.from([0xff, 0xd8]));

  while (start !== -1) {
    const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end === -1) break;
    frames.push(buffer.slice(start, end + 2));
    start = buffer.indexOf(Buffer.from([0xff, 0xd8]), end + 2);
  }

  if (frames.length > 0) {
    for (const frame of frames) onFrame(frame);
    return frames.length;
  }

  return 0;
}

function calculateFrameHash(frameBuffer) {
  return crypto.createHash('sha256').update(frameBuffer).digest('hex').slice(0, 16);
}

function detectMotion(currentHash, previousHash, sensitivity = 0.95) {
  if (!previousHash) return false;
  // Compara os primeiros caracteres dos hashes
  // Sensibilidade 0.95 = aceita diferença em até 5% dos caracteres
  const matches = currentHash
    .split('')
    .reduce((acc, char, i) => (char === previousHash[i] ? acc + 1 : acc), 0);
  const similarity = matches / currentHash.length;
  return similarity < sensitivity;
}

class CameraStream {
  constructor(camera) {
    this.camera = camera;
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.latestFrame = null;
    this.running = false;
    this.reconnectTimer = null;
    this.lastFrameAt = 0;
    this.lastDataAt = 0;
    this.errorCount = 0;
    this.noFrameTimer = null;
    this.ffmpegBinIndex = 0;
    this.transportOrder = Array.from(
      new Set([
        'tcp',
        String(camera.protocolo || 'tcp').toLowerCase(),
        'udp',
      ])
    ).filter((protocol) => ALLOWED_PROTOCOLS.has(protocol));
    this.transportIndex = 0;
    this.healthCheckTimer = null;
    this.lastFrameHash = null;
    this.motionDetected = false;
    this.motionLastAt = 0;
    this.motionFrameCount = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    appendLog('info', 'Iniciando stream da camera', this.camera);
    this.startHealthCheck();
    this.launch();
  }

  startHealthCheck() {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      if (!this.running) return;
      const now = Date.now();
      const staleMs = now - this.lastDataAt;
      if (this.process && this.lastDataAt > 0 && staleMs > 20000) {
        appendLog('warn', `Sem dados de stream por ${Math.round(staleMs / 1000)}s; reiniciando ffmpeg`, this.camera);
        this.process.kill('SIGTERM');
      }
    }, 5000);
  }

  launch() {
    const rtspUrl = makeRtspUrl(this.camera);
    const ffmpegBin = FFMPEG_CANDIDATES[this.ffmpegBinIndex] || 'ffmpeg';
    const rtspTransport = this.transportOrder[this.transportIndex] || 'tcp';
    const args = [
      '-rtsp_transport',
      rtspTransport,
      '-reorder_queue_size', '128',
      '-buffer_size', '1024000',
      '-i',
      rtspUrl,
      '-f',
      'image2pipe',
      '-vf',
      `scale=${this.camera.width}:${this.camera.height}`,
      '-r',
      String(this.camera.fps),
      '-vcodec',
      'mjpeg',
      '-q:v',
      '5',
      '-an',
      '-sn',
      '-'
    ];

    if (rtspTransport === 'tcp') {
      args.unshift('prefer_tcp');
      args.unshift('-rtsp_flags');
    }

    args.unshift('-flags', 'low_delay');
    args.unshift('-fflags', 'nobuffer');

    appendLog('info', `Conectando em ${maskRtspUrl(rtspUrl)} via ${rtspTransport.toUpperCase()} (bin=${ffmpegBin})`, this.camera);

    this.process = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.firstFrameLogged = false;

    if (this.noFrameTimer) {
      clearTimeout(this.noFrameTimer);
      this.noFrameTimer = null;
    }
    this.noFrameTimer = setTimeout(() => {
      if (!this.running || this.firstFrameLogged) return;
      appendLog('warn', `Sem frame inicial via ${rtspTransport.toUpperCase()}; forçando reconexao`, this.camera);
      if (this.process) {
        this.process.kill('SIGTERM');
      }
    }, 12000);

    this.process.stdout.on('data', (chunk) => {
      this.lastDataAt = Date.now();
      this.buffer = Buffer.concat([this.buffer, chunk]);
      extractJpegFrames(this.buffer, (frame) => {
        this.latestFrame = frame;
        this.lastFrameAt = Date.now();
        this.errorCount = 0;
        
        // Detecção de movimento
        if (this.camera.motion_enabled !== 0) {
          const currentHash = calculateFrameHash(frame);
          if (detectMotion(currentHash, this.lastFrameHash, 0.92)) {
            this.motionLastAt = Date.now();
            if (!this.motionDetected) {
              this.motionDetected = true;
              this.motionFrameCount = 1;
              appendLog('info', 'Movimento detectado', this.camera);
            } else {
              this.motionFrameCount += 1;
            }
          } else {
            if (this.motionDetected && Date.now() - this.motionLastAt > 1500) {
              this.motionDetected = false;
              appendLog('info', `Movimento encerrado (${this.motionFrameCount} frames)`, this.camera);
              this.motionFrameCount = 0;
            }
          }
          this.lastFrameHash = currentHash;
        }
        
        if (!this.firstFrameLogged) {
          appendLog('info', 'Primeiro frame recebido com sucesso', this.camera);
          this.firstFrameLogged = true;
          if (this.noFrameTimer) {
            clearTimeout(this.noFrameTimer);
            this.noFrameTimer = null;
          }
        }
      });

      const lastJpegEnd = this.buffer.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (lastJpegEnd > 0) {
        this.buffer = this.buffer.slice(lastJpegEnd + 2);
      } else if (this.buffer.length > 5 * 1024 * 1024) {
        this.buffer = Buffer.alloc(0);
      }
    });

    this.process.stderr.on('data', (data) => {
      this.errorCount += 1;
      const text = String(data || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of text) {
        const shortLine = line.slice(0, 512);
        const level = /error|failed|invalid|timed out|unauthorized|not found|denied|connection|refused/i.test(shortLine)
          ? 'error'
          : 'warn';
        appendLog(level, shortLine, this.camera);
      }
    });

    this.process.on('close', (code, signal) => {
      this.process = null;
      const reason = signal ? `sinal=${signal}` : `código=${code}`;
      appendLog('warn', `Processo ffmpeg encerrado (${reason})`, this.camera);
      if (!this.running) return;
      this.scheduleReconnect();
    });

    this.process.on('error', (err) => {
      this.process = null;
      appendLog('error', `Falha ao iniciar ffmpeg: ${err.message} (${err.code})`, this.camera);
      if (!this.running) return;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (!this.firstFrameLogged) {
      this.transportIndex = (this.transportIndex + 1) % this.transportOrder.length;
      this.ffmpegBinIndex = (this.ffmpegBinIndex + 1) % FFMPEG_CANDIDATES.length;
      const nextTransport = this.transportOrder[this.transportIndex] || 'tcp';
      const nextBin = FFMPEG_CANDIDATES[this.ffmpegBinIndex] || 'ffmpeg';
      appendLog('warn', `Tentando fallback: protocolo=${nextTransport.toUpperCase()} bin=${nextBin}`, this.camera);
    }
    appendLog('warn', 'Agendando reconexao em 2 segundos', this.camera);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.launch();
    }, 2000);
  }

  stop() {
    this.running = false;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.noFrameTimer) {
      clearTimeout(this.noFrameTimer);
      this.noFrameTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.motionDetected = false;
    this.motionFrameCount = 0;
    appendLog('info', 'Stream da camera foi interrompido', this.camera);
  }

  status() {
    return {
      id: this.camera.id,
      nome: this.camera.nome,
      ip: this.camera.ip,
      protocolo: this.camera.protocolo,
      caminho: this.camera.caminho,
      online: Boolean(this.latestFrame) || (Date.now() - this.lastDataAt < 30000 && this.lastDataAt > 0),
      hasFrame: Boolean(this.latestFrame),
      motionDetected: this.motionDetected,
      motionFrameCount: this.motionFrameCount,
      motionLastAt: this.motionLastAt || null,
    };
  }
}

let cameras = [];
const streamMap = new Map();

function getSettings() {
  const row = db.prepare('SELECT resolution, fps FROM settings WHERE id = 1').get();
  const rawRes = row?.resolution || '640x480';
  const resolution = parseResolution(rawRes, { width: 640, height: 480 });
  return {
    resolution: rawRes,
    width: resolution.width,
    height: resolution.height,
    fps: Number(row?.fps || 10),
  };
}

function getCamerasFromDb(userId) {
  const settings = getSettings();
  const rows = db.prepare('SELECT * FROM cameras WHERE user_id = ? ORDER BY ordem ASC, id ASC').all(userId);
  return rows.map((row) => normalizeCameraInput({ ...row, ...settings }));
}

function stopAllStreams(userId = null) {
  for (const [id, stream] of streamMap.entries()) {
    if (!userId || stream.camera.user_id === userId) {
      stream.stop();
      streamMap.delete(id);
    }
  }
}

function startStreamsFromCameras(userId) {
  const userCameras = getCamerasFromDb(userId);
  for (const camera of userCameras) {
    if (camera.visivel) {
      const stream = new CameraStream(camera);
      stream.start();
      streamMap.set(camera.id, stream);
    }
  }
}

function reloadFromDisk(userId) {
  if (!userId) return;
  appendLog('info', `Recarregando cameras do banco local para usuario ${userId}`);
  const userCameras = getCamerasFromDb(userId);
  
  // Atualizar a lista global (filtramos aqui apenas para segurança de concorrência simples)
  cameras = cameras.filter(c => c.user_id !== userId).concat(userCameras);

  if (streamMap.size > 0) {
    appendLog('info', `Atualizando fluxos ativos para usuario ${userId}...`);
    // Apenas garante que os streams do usuário sejam atualizados
    ensureStreamsStarted(userId);
  }
}

function ensureStreamsStarted(userId) {
  const userCameras = cameras.filter(c => c.user_id === userId);
  const currentIds = userCameras.filter(c => !!c.visivel).map(c => c.id);
  
  // Parar o que não deve estar rodando para ESTE usuário
  for (const [id, stream] of streamMap.entries()) {
    if (stream.camera.user_id === userId && !currentIds.includes(id)) {
      stream.stop();
      streamMap.delete(id);
    }
  }

  // Iniciar o que deve estar rodando e não está para ESTE usuário
  for (const camera of userCameras) {
    if (!!camera.visivel && !streamMap.has(camera.id)) {
      try {
        const stream = new CameraStream(camera);
        streamMap.set(camera.id, stream);
        stream.start();
      } catch (err) {
        appendLog('error', `Falha ao iniciar stream: ${err.message}`, camera);
      }
    }
  }
}

initDatabase();
bootstrapFromIniIfNeeded();
appendLog('info', `FFMPEG_BIN: ${FFMPEG_BIN}`);
// reloadFromDisk sera chamado ao carregar a lista ou autenticar
// reloadFromDisk(); 

function cameraPublic(camera) {
  const stream = streamMap.get(camera.id);
  const status = stream ? stream.status() : null;
  return {
    id: camera.id,
    nome: camera.nome,
    ip: camera.ip,
    usuario: camera.usuario,
    senha: camera.senha,
    onvifUsuario: camera.onvifUsuario,
    onvifSenha: camera.onvifSenha,
    protocolo: camera.protocolo,
    caminho: camera.caminho,
    portaRtsp: camera.portaRtsp,
    onvifPort: camera.onvifPort,
    ordem: camera.ordem,
    visivel: camera.visivel,
    userId: camera.user_id,
    ptz: true,
    streamUrl: `/api/stream/${camera.id}`,
    status,
  };
}

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/register', (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  const usuario = String(req.body?.usuario || '').trim().toLowerCase();
  const senha = String(req.body?.senha || '');

  if (!nome || !usuario || !senha) {
    res.status(400).json({ error: 'Campos obrigatorios: nome, usuario, senha' });
    return;
  }
  if (senha.length < 4) {
    res.status(400).json({ error: 'Senha deve ter pelo menos 4 caracteres' });
    return;
  }

  try {
    const senhaHash = hashPassword(senha);
    const info = db
      .prepare('INSERT INTO users (nome, usuario, senha_hash) VALUES (?, ?, ?)')
      .run(nome, usuario, senhaHash);

    const token = signAuthToken({ sub: String(info.lastInsertRowid), exp: Date.now() + AUTH_TTL_MS });
    setAuthCookie(res, token);
    res.status(201).json({ ok: true, user: { id: String(info.lastInsertRowid), nome, usuario } });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      res.status(409).json({ error: 'Usuario ja cadastrado' });
      return;
    }
    res.status(500).json({ error: 'Falha ao cadastrar usuario' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const usuario = String(req.body?.usuario || '').trim().toLowerCase();
  const senha = String(req.body?.senha || '');

  if (!usuario || !senha) {
    res.status(400).json({ error: 'Informe usuario e senha' });
    return;
  }

  const user = db.prepare('SELECT id, nome, usuario, senha_hash FROM users WHERE usuario = ?').get(usuario);
  if (!user || !verifyPassword(senha, user.senha_hash)) {
    res.status(401).json({ error: 'Credenciais invalidas' });
    return;
  }

  const token = signAuthToken({ sub: String(user.id), exp: Date.now() + AUTH_TTL_MS });
  setAuthCookie(res, token);
  res.json({ ok: true, user: { id: String(user.id), nome: user.nome, usuario: user.usuario } });
});

app.post('/api/auth/logout', (req, res) => {
  const userId = verifyAuthToken(req.cookies[AUTH_COOKIE])?.sub;
  clearAuthCookie(res);
  if (userId) stopAllStreams(Number(userId));
  appendLog('info', `Usuario ${userId} deslogou. Finalizando streams dele.`);
  res.json({ ok: true });
});

app.post('/api/streams/stop-all', authRequired, (req, res) => {
  stopAllStreams(req.authUser.id);
  appendLog('info', `Parada de streams solicitada via API pelo usuario ${req.authUser.id}.`);
  res.json({ ok: true });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ ok: true, user: req.authUser });
});

app.get('/api/settings', authRequired, (_req, res) => {
  try {
    const settings = getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', authRequired, (req, res) => {
  const { resolution, fps } = req.body;
  if (!resolution) {
    return res.status(400).json({ error: 'Resolução é obrigatória' });
  }

  try {
    db.prepare('UPDATE settings SET resolution = ?, fps = ? WHERE id = 1').run(resolution, Number(fps || 10));
    reloadFromDisk(req.authUser.id);
    res.json({ ok: true });
  } catch (err) {
    appendLog('error', `Falha ao salvar settings globais: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cameras', authRequired, (req, res) => {
  const userId = req.authUser.id;
  const noStreams = req.query.noStreams === '1' || req.query.noStreams === 'true';
  
  // Re-sync: Se o usuario nao tem cameras no array global, tenta buscar e CLAIME de orphans
  const userHasInMem = cameras.some(c => c.user_id === userId);
  if (!userHasInMem) {
    // 1. Tentar capturar cameras sem dono (NULL) para este usuario
    db.prepare('UPDATE cameras SET user_id = ? WHERE user_id IS NULL').run(userId);
    
    // 2. Recarregar do DB
    const fromDb = getCamerasFromDb(userId);
    cameras = cameras.filter(c => c.user_id !== userId).concat(fromDb);
  }

  if (!noStreams) {
    try {
      ensureStreamsStarted(userId);
    } catch (err) {
      appendLog('error', `Falha ao garantir streams do usuario ${userId}: ${err.message}`);
    }
  }
  
  const userCameras = cameras.filter(c => c.user_id === userId);
  res.json(userCameras.map(cameraPublic));
});

app.post('/api/cameras', authRequired, (req, res) => {
  try {
    const camera = normalizeCameraInput(req.body);

    db.prepare(
      `INSERT INTO cameras (nome, ip, usuario, senha, onvif_usuario, onvif_senha, caminho, porta_rtsp, onvif_port, protocolo, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      camera.nome,
      camera.ip,
      camera.usuario,
      camera.senha,
      camera.onvifUsuario,
      camera.onvifSenha,
      camera.caminho,
      camera.portaRtsp,
      camera.onvifPort,
      camera.protocolo,
      req.authUser.id
    );

    reloadFromDisk(req.authUser.id);
    const userCameras = cameras.filter(c => c.user_id === req.authUser.id);
    res.status(201).json({ ok: true, cameras: userCameras.map(cameraPublic) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/cameras/bulk-settings', authRequired, (req, res) => {
  const settings = req.body;
  if (!Array.isArray(settings)) {
    return res.status(400).json({ error: 'Payload deve ser um array' });
  }

  const stmt = db.prepare('UPDATE cameras SET ordem = ?, visivel = ? WHERE id = ? AND user_id = ?');
  const transaction = db.transaction((data, userId) => {
    for (const item of data) {
      stmt.run(item.ordem, item.visivel ? 1 : 0, Number(item.id), userId);
    }
  });

  try {
    transaction(settings, req.authUser.id);
    reloadFromDisk(req.authUser.id);
    res.json({ ok: true });
  } catch (err) {
    appendLog('error', `Falha ao salvar bulk-settings: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cameras/:id', authRequired, (req, res) => {
  const targetId = Number(req.params.id);
  const userId = req.authUser.id;
  const existing = cameras.find((camera) => camera.id === targetId && camera.user_id === userId);
  if (!existing) {
    console.warn(`[404] Camera not found (PUT /api/cameras/${req.params.id}). Target: ${targetId} (${typeof targetId}). Disponíveis: ${cameras.map(c => c.id).join(',')}`);
    res.status(404).json({ error: 'Camera not found' });
    return;
  }

  try {
    const payload = normalizeCameraInput(req.body);
    db.prepare(
      `UPDATE cameras
       SET nome = ?, ip = ?, usuario = ?, senha = ?, onvif_usuario = ?, onvif_senha = ?, caminho = ?, porta_rtsp = ?, onvif_port = ?, protocolo = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      payload.nome,
      payload.ip,
      payload.usuario,
      payload.senha,
      payload.onvifUsuario,
      payload.onvifSenha,
      payload.caminho,
      payload.portaRtsp,
      payload.onvifPort,
      payload.protocolo,
      targetId,
      userId
    );

    reloadFromDisk(userId);
    const userCameras = cameras.filter(c => c.user_id === userId);
    res.json({ ok: true, cameras: userCameras.map(cameraPublic) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/cameras/:id', authRequired, (req, res) => {
  const targetId = Number(req.params.id);
  const userId = req.authUser.id;
  const exists = cameras.some((camera) => camera.id === targetId && camera.user_id === userId);
  if (!exists) {
    res.status(404).json({ error: 'Camera not found' });
    return;
  }

  db.prepare('DELETE FROM cameras WHERE id = ? AND user_id = ?').run(targetId, userId);
  reloadFromDisk(userId);
  const userCameras = cameras.filter(c => c.user_id === userId);
  res.json({ ok: true, cameras: userCameras.map(cameraPublic) });
});

app.get('/api/stream/:id', authRequired, (req, res) => {
  const targetId = Number(req.params.id);
  const userId = req.authUser.id;
  const stream = streamMap.get(targetId);
  const requestedFps = Number(req.query.fps || 10);
  const fps = Number.isFinite(requestedFps)
    ? Math.min(Math.max(requestedFps, 1), 30)
    : 10;
  const frameIntervalMs = Math.max(34, Math.round(1000 / fps));
  
  if (!stream || stream.camera.user_id !== userId) {
    res.status(404).json({ error: 'Camera not found or access denied' });
    return;
  }

  res.writeHead(200, {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    Connection: 'keep-alive',
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
  });

  const interval = setInterval(() => {
    if (!stream.latestFrame) return;

    res.write('--frame\r\n');
    res.write('Content-Type: image/jpeg\r\n');
    res.write(`Content-Length: ${stream.latestFrame.length}\r\n\r\n`);
    res.write(stream.latestFrame);
    res.write('\r\n');
  }, frameIntervalMs);

  req.on('close', () => {
    clearInterval(interval);
  });
});

app.post('/api/reconnect/:id', authRequired, (req, res) => {
  const targetId = Number(req.params.id);
  const userId = req.authUser.id;
  const stream = streamMap.get(targetId);
  
  if (!stream || stream.camera.user_id !== userId) {
    res.status(404).json({ error: 'Camera not found or access denied' });
    return;
  }

  stream.stop();
  stream.start();
  res.json({ ok: true });
});

app.post('/api/ptz/:id/move', authRequired, async (req, res) => {
  const targetId = Number(req.params.id);
  const userId = req.authUser.id;
  const camera = cameras.find((item) => item.id === targetId && item.user_id === userId);
  if (!camera) {
    res.status(404).json({ error: 'Camera not found or access denied' });
    return;
  }

  const direction = String(req.body?.direction || '').toLowerCase();
  const durationRaw = Number(req.body?.durationMs || 320);
  const durationMs = Number.isFinite(durationRaw)
    ? Math.min(Math.max(durationRaw, 120), 1500)
    : 320;

  try {
    await movePtz(camera, direction, durationMs);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: `Falha no PTZ: ${err.message}` });
  }
});

app.post('/api/ptz/:id/stop', authRequired, async (req, res) => {
  const targetId = Number(req.params.id);
  const userId = req.authUser.id;
  const camera = cameras.find((item) => item.id === targetId && item.user_id === userId);
  if (!camera) {
    res.status(404).json({ error: 'Camera not found or access denied' });
    return;
  }

  try {
    await stopPtz(camera);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: `Falha ao parar PTZ: ${err.message}` });
  }
});

app.get('/api/health', authRequired, (req, res) => {
  const userId = req.authUser.id;
  const userStreams = Array.from(streamMap.values()).filter(s => s.camera.user_id === userId);
  res.json({
    ok: true,
    cameras: userStreams.map((stream) => stream.status()),
  });
});

app.get('/api/version', (_req, res) => {
  res.json({ version: APP_VERSION });
});

app.get('/api/motion/status', authRequired, (req, res) => {
  const userId = req.authUser.id;
  try {
    const userCameras = cameras.filter((c) => c.user_id === userId);
    const motionStatus = userCameras.map(cam => {
      const stream = streamMap.get(cam.id);
      return {
        id: cam.id,
        nome: cam.nome,
        motionDetected: stream?.motionDetected || false,
        motionLastAt: stream?.motionLastAt || null,
        motionFrameCount: stream?.motionFrameCount || 0,
      };
    });
    res.json({ ok: true, cameras: motionStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/logs', authRequired, (req, res) => {
  try {
    if (!fs.existsSync(LOGS_PATH)) {
      return res.json({ ok: true, logs: '', size: 0 });
    }
    
    const content = fs.readFileSync(LOGS_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const lastNLines = lines.slice(-500).join('\n'); // Últimas 500 linhas
    
    const stats = fs.statSync(LOGS_PATH);
    res.json({ 
      ok: true, 
      logs: lastNLines, 
      size: Math.round(stats.size / 1024) + ' KB',
      totalLines: lines.length
    });
  } catch (err) {
    res.status(500).json({ error: `Falha ao ler logs: ${err.message}` });
  }
});

function shutdown() {
  stopAllStreams();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});

const port = process.env.PORT || 3333;
app.listen(port, () => {
  appendLog('info', `Servidor rodando em http://localhost:${port}`);
});
