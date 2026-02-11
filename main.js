const { app, BrowserWindow, Tray, Menu, ipcMain, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let tray = null;

const iconPath = path.join(__dirname, 'flash.ico'); 
const dbPath = path.join(app.getPath('userData'), 'messages.json');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900, 
        minHeight: 600,
        frame: false,
        icon: iconPath,
        backgroundColor: '#0F0F0F',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
            webSecurity: false
        }
    });

    mainWindow.loadFile('index.html');

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// IPC
ipcMain.handle('get-sources', async () => {
    try {
        const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: {width:400, height:400}, fetchWindowIcons: true });
        return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), appIcon: s.appIcon?.toDataURL() }));
    } catch (e) { return []; }
});

// История
function getHistory() {
    if (fs.existsSync(dbPath)) { try { return JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch (e) { return []; } }
    return [];
}
function saveHistory(h) { try { fs.writeFileSync(dbPath, JSON.stringify(h, null, 2)); } catch(e){} }

ipcMain.handle('load-history', () => getHistory());
ipcMain.on('save-message', (e, msg) => {
    let h = getHistory(); h.push(msg); if(h.length>200)h=h.slice(-200); saveHistory(h);
});
ipcMain.on('delete-message-file', (e, id) => {
    let h = getHistory(); h = h.filter(m => m.id !== id); saveHistory(h);
});
ipcMain.on('update-message', (e, msg) => {
    let h = getHistory(); const i = h.findIndex(m => m.id === msg.id); if(i!==-1) { h[i]=msg; saveHistory(h); }
});
ipcMain.on('clear-cache', () => { if(fs.existsSync(dbPath)) fs.unlinkSync(dbPath); mainWindow.webContents.send('history-cleared'); });

// Окно
ipcMain.on('minimize-app', () => mainWindow.minimize());
ipcMain.on('maximize-app', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('close-app', () => app.quit());

app.whenReady().then(() => {
    createWindow();
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Развернуть', click: () => mainWindow.show() },
        { label: 'Выход', click: () => { app.quit(); process.exit(0); }}
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('click', () => mainWindow.show());
});