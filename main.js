const { app, BrowserWindow } = require('electron');
const path = require('path');

// Aumenta o limite de conexões para não travar o polling quando houver muitas câmeras
app.commandLine.appendSwitch('ignore-connections-limit', 'localhost');
app.name = 'deOlho';
if (app.setName) app.setName('deOlho');

// Inicia o servidor Node.js (server.js)
require('./server.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: "deOlho",
    icon: path.join(__dirname, 'icone.png'),
    autoHideMenuBar: true
  });

  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'icone.png'));
  }

  // Aguarda um pouco para o servidor subir antes de carregar a URL
  // O portal padrão agora é 3333
  setTimeout(() => {
    win.loadURL('http://localhost:3333/login.html');
  }, 1000);

  win.on('closed', () => {
    app.quit();
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'icone.png'));
    app.setAboutPanelOptions({
      applicationName: 'deOlho',
      applicationVersion: '1.0.0',
      iconPath: path.join(__dirname, 'icone.png')
    });
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
