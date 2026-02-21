const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_URL = process.env.ALGO_DESKTOP_URL || 'http://localhost:8081/dashboard.html';
const HEALTH_URL = process.env.ALGO_DESKTOP_HEALTH_URL || 'http://localhost:3001/health';
const AUTO_START_STACK = String(process.env.ALGO_AUTO_START_STACK || '1') !== '0';
let mainWindow;

function getBundleRoot() {
  return app.getAppPath();
}

function getComposePath() {
  return path.join(getBundleRoot(), 'docker-compose.yml');
}

function checkHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2500 }, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      res.resume();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealthy(url, attempts = 35, intervalMs = 3000) {
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await checkHealth(url);
    if (ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function runDockerComposeUp() {
  return new Promise((resolve, reject) => {
    const composeFile = getComposePath();
    const composeDir = path.dirname(composeFile);
    const cmd = process.platform === 'win32' ? 'docker.exe' : 'docker';
    const args = ['compose', '-f', composeFile, 'up', '--build', '-d'];

    const proc = spawn(cmd, args, {
      cwd: composeDir,
      shell: false
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      return reject(new Error(stderr || `docker compose exited with code ${code}`));
    });
  });
}

async function ensureStackIsRunning() {
  const alreadyUp = await checkHealth(HEALTH_URL);
  if (alreadyUp) return;
  if (!AUTO_START_STACK) return;

  try {
    await runDockerComposeUp();
  } catch (err) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Auto-start failed',
      message: 'Could not auto-start Docker stack.',
      detail: [
        `Compose file: ${getComposePath()}`,
        `Error: ${err.message}`,
        'You can start it manually: docker compose up --build -d'
      ].join('\n')
    });
    return;
  }

  const healthy = await waitForHealthy(HEALTH_URL);
  if (!healthy) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Service startup timeout',
      message: 'Containers started but API health did not become ready in time.',
      detail: `Checked: ${HEALTH_URL}`
    });
  }
}

function createMenu() {
  const template = [
    {
      label: 'App',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open in Browser',
          click: async () => {
            await shell.openExternal(DEFAULT_URL);
          }
        },
        {
          label: 'Connection Help',
          click: async () => {
            await dialog.showMessageBox({
              type: 'info',
              title: 'Connection Help',
              message: 'Desktop EXE can auto-start your local Docker stack.',
              detail: [
                `Current URL: ${DEFAULT_URL}`,
                `Health URL: ${HEALTH_URL}`,
                'Auto-start command: docker compose up --build -d',
                'Then open: http://localhost:8081'
              ].join('\n')
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    autoHideMenuBar: false,
    title: 'Algo Trading Platform',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', async () => {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Could not connect',
      message: 'Failed to load Algo Trading Dashboard',
      detail: [
        `URL: ${DEFAULT_URL}`,
        'Make sure backend/frontend are running first.',
        'Expected local command: docker compose up --build -d'
      ].join('\n')
    });
  });

  mainWindow.loadURL(DEFAULT_URL);
}

app.whenReady().then(() => {
  (async () => {
    createMenu();
    await ensureStackIsRunning();
    createWindow();
  })();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
