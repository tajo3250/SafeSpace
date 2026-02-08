const { app, BrowserWindow, shell, dialog, session } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");

// ---- Performance optimizations ----
// Disable GPU compositing when window is hidden (saves VRAM while gaming)
app.commandLine.appendSwitch("disable-renderer-backgrounding");
// Reduce idle GPU usage
app.commandLine.appendSwitch("disable-background-timer-throttling");

// The hosted SafeSpace URL - override with SAFESPACE_URL env var if needed
const APP_URL = process.env.SAFESPACE_URL || "https://safespace.hxn1.dev";

let mainWindow = null;

function createWindow() {
  // Use a persistent partition so localStorage/cookies survive app restarts
  const persistentSession = session.fromPartition("persist:safespace");

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: "SafeSpace",
    icon: path.join(__dirname, "icons", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true, // throttle timers when window hidden (saves CPU)
      spellcheck: false,          // disable spellcheck overhead
      session: persistentSession,
    },
    autoHideMenuBar: true,
    backgroundColor: "#0f172a",
  });

  // Append desktop identifier to user agent
  const ua = mainWindow.webContents.getUserAgent();
  mainWindow.webContents.setUserAgent(ua + " SafeSpace-Desktop");

  mainWindow.loadURL(APP_URL);

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Free up renderer resources when the window is hidden/minimized
  mainWindow.on("hide", () => {
    mainWindow?.webContents?.setBackgroundThrottling?.(true);
  });
  mainWindow.on("minimize", () => {
    mainWindow?.webContents?.setBackgroundThrottling?.(true);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- Auto-update (electron-updater) ---
// Works like Discord: check on launch, download in background, prompt to restart.
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Update Available",
        message: `A new version (v${info.version}) is being downloaded in the background.`,
        buttons: ["OK"],
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Update Ready",
        message: `SafeSpace v${info.version} has been downloaded. Restart to apply the update.`,
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    }
  });

  autoUpdater.on("error", () => {
    // Silently ignore update errors - the app still works fine without updates
  });

  // Check for updates right away, then every 30 minutes
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});

// macOS: re-create window when dock icon clicked
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Quit when all windows closed (except macOS)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
