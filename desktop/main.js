const { app, BrowserWindow, shell, dialog, session, desktopCapturer } = require("electron");
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
let updateCheckDone = false;

// Inline loading screen shown while checking for updates and loading
const LOADING_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #02040c;
    color: #e6f0ff;
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    overflow: hidden;
  }
  .container { text-align: center; }
  .title {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.5px;
    margin-bottom: 20px;
    background: linear-gradient(135deg, rgb(45 212 191), rgb(56 189 248));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .spinner {
    width: 32px; height: 32px;
    border: 3px solid rgba(45, 212, 191, 0.15);
    border-top-color: rgb(45, 212, 191);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 16px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status {
    font-size: 13px;
    color: #9aa6b7;
    transition: opacity 0.3s;
  }
  .version {
    font-size: 11px;
    color: #5a6577;
    margin-top: 12px;
  }
</style>
</head>
<body>
  <div class="container">
    <div class="title">SafeSpace</div>
    <div class="spinner"></div>
    <div class="status" id="status">Checking for updates...</div>
    <div class="version" id="version"></div>
  </div>
</body>
</html>
`;

function updateLoadingStatus(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents
      .executeJavaScript(
        `(() => { const el = document.getElementById("status"); if (el) el.textContent = ${JSON.stringify(text)}; })()`
      )
      .catch(() => {});
  }
}

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
    backgroundColor: "#02040c",
    show: false,
  });

  // Append desktop identifier to user agent
  const ua = mainWindow.webContents.getUserAgent();
  mainWindow.webContents.setUserAgent(ua + " SafeSpace-Desktop");

  // Show the loading screen immediately
  mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LOADING_HTML));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Enable screen sharing: handle getDisplayMedia requests from the renderer
  // This uses Electron's desktopCapturer to provide native screen/window sources
  persistentSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ["screen", "window"] }).then((sources) => {
      if (sources.length > 0) {
        // Auto-select the first screen source (primary display)
        // Note: only pass video — audio loopback is not reliably supported on all platforms
        callback({ video: sources[0] });
      } else {
        callback({});
      }
    }).catch(() => {
      callback({});
    });
  });

  // Auto-grant media permissions for the app (mic, camera, screen)
  persistentSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ["media", "display-capture", "mediaKeySystem", "notifications"];
    callback(allowedPermissions.includes(permission));
  });

  // Also handle permission checks (some Electron versions use this)
  persistentSession.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ["media", "display-capture", "mediaKeySystem", "notifications"];
    return allowedPermissions.includes(permission);
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

// Load the actual app URL (called after update check completes or times out)
function loadApp() {
  if (updateCheckDone) return;
  updateCheckDone = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    updateLoadingStatus("Loading SafeSpace...");
    mainWindow.loadURL(APP_URL);
  }
}

// --- Auto-update (electron-updater) ---
// Checks for updates on launch with visual feedback, downloads in background, prompts to restart.
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    updateLoadingStatus("Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    updateLoadingStatus(`Downloading update v${info.version}...`);
  });

  autoUpdater.on("update-not-available", () => {
    updateLoadingStatus("Up to date!");
    // Short delay so user sees the status, then load app
    setTimeout(loadApp, 500);
  });

  autoUpdater.on("update-downloaded", (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
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
        } else {
          // User chose later — load the app with current version
          loadApp();
        }
      });
    }
  });

  autoUpdater.on("error", () => {
    // Update check failed — just load the app anyway
    loadApp();
  });

  // Check for updates right away
  autoUpdater.checkForUpdates().catch(() => {
    // If update check throws, load the app
    loadApp();
  });

  // Timeout: if update check takes too long (10s), load the app anyway
  setTimeout(() => {
    loadApp();
  }, 10000);

  // Also check for updates every 30 minutes after initial startup
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
