const { app, BrowserWindow, dialog, Menu, shell } = require('electron');

const DEFAULT_URL = process.env.ALGO_DESKTOP_URL || 'http://localhost:8081/dashboard.html';
let mainWindow;

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
              message: 'Desktop EXE is a wrapper around your running web app.',
              detail: [
                `Current URL: ${DEFAULT_URL}`,
                'If nothing loads, start the stack first: docker compose up --build -d',
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
  createMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
