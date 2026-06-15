const { app, BrowserWindow, ipcMain, session, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { initTray } = require('./tray');
const { supabase, ANON_KEY, SUPABASE_URL } = require('./supabase');
const { startTracking, stopTracking } = require('./tracker');
const { autoUpdater } = require('electron-updater');
const { init: sentryInit } = require('@sentry/electron/main');

sentryInit({
  dsn: "https://83c3738c5970e3801c817e1f6b6a0b39@o4511556897996800.ingest.us.sentry.io/4511556911628288",
  environment: app.isPackaged ? "production" : "development",
});

const TOKEN_FILE     = path.join(app.getPath('userData'), 'auth.bin');
const OLD_TOKEN_FILE = path.join(app.getPath('userData'), 'auth.json');
const WEB_APP_URL    = 'https://narrativex-tracker.vercel.app';

let mainWindow     = null;
let userId         = null;
let savedSession   = null;
let heartbeatTimer = null;
let ipcRegistered  = false; // FIX 2: guard against duplicate IPC handler registration

function setAutoStart(enable = true) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: enable,
    openAsHidden: true,
    name: 'NarrativeX Agent',
    path: process.execPath,
  });
}

// ─── HEARTBEAT ────────────────────────────────────────────────────────────────
async function sendHeartbeat() {
  if (!userId) return;
  try {
    const { error } = await supabase
      .from('agent_heartbeats')
      .insert({ employee_id: userId });
    if (error) console.error('[heartbeat] insert error:', error.message);
  } catch (err) {
    console.error('[heartbeat] unexpected error:', err.message);
  }
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 5 * 60 * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─── ROLE FROM PROFILES ───────────────────────────────────────────────────────
async function getRoleFromProfiles(uid) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', uid)
      .maybeSingle();
    if (error) console.error('getRoleFromProfiles error:', error.message);
    return data?.role ?? 'employee';
  } catch (e) {
    console.error('getRoleFromProfiles exception:', e);
    return 'employee';
  }
}

// ─── FRESH SESSION ────────────────────────────────────────────────────────────
async function getFreshSession(accessToken, refreshToken) {
  try {
    const { data, error } = await supabase.auth.setSession({
      access_token:  accessToken,
      refresh_token: refreshToken,
    });
    if (error || !data?.session) {
      console.error('getFreshSession failed:', error?.message ?? 'no session');
      return null;
    }
    console.log('getFreshSession OK, user:', data.session.user.id);
    return data.session;
  } catch (e) {
    console.error('getFreshSession exception:', e);
    return null;
  }
}

async function refreshAndSaveSession(saved) {
  try {
    const sess = extractSession(saved.cookies);
    if (!sess?.access_token || !sess?.refresh_token) {
      console.error('refreshAndSaveSession: missing tokens in auth.bin');
      return null;
    }

    const freshSession = await getFreshSession(sess.access_token, sess.refresh_token);
    if (!freshSession) return null;

    const updatedCookies = (saved.cookies || []).map(c => {
      if (c.name === 'sb-wowhjuzkglgseqwznxpw-auth-token') {
        return {
          ...c,
          value: encodeURIComponent(JSON.stringify({
            access_token:  freshSession.access_token,
            refresh_token: freshSession.refresh_token,
            user:          freshSession.user,
            expires_at:    freshSession.expires_at,
          })),
        };
      }
      return c;
    });

    saveToken({ userId: freshSession.user.id, cookies: updatedCookies });
    console.log('Session refreshed and saved.');
    return freshSession;
  } catch (e) {
    console.error('refreshAndSaveSession error:', e);
    return null;
  }
}

// ─── LOGOUT CLEANUP ───────────────────────────────────────────────────────────
// FIX 1 + FIX 3: Full cleanup on logout — stop everything, clear session, reopen login
async function handleLogout() {
  stopTracking();
  stopHeartbeat();
  await supabase.auth.signOut(); // ← add this
  userId       = null;
  savedSession = null;
  try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
  console.log('Logged out — tracking stopped, token cleared.');

  // FIX 3: Clear Electron session storage so next login starts completely fresh
  // Prevents stale Supabase localStorage from ghost-restoring old session
  try {
    await session.defaultSession.clearStorageData({ storages: ['localstorage', 'cookies', 'sessionstorage'] });
    console.log('Session storage cleared.');
  } catch (e) {
    console.error('clearStorageData error:', e);
  }

  // FIX 1: Destroy tracker window and reopen login window
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
    mainWindow = null;
  }

  openLoginWindow();
}

// ─── APP READY ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  setAutoStart(true);

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'A new version of NarrativeX Agent has been downloaded. Restart to apply update.',
      buttons: ['Restart Now', 'Later'],
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
  });

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }

  const saved = loadToken();
  if (saved) {
    const sess = await refreshAndSaveSession(saved);
    if (sess) {
      userId       = sess.user.id;
      savedSession = sess;
      const role   = await getRoleFromProfiles(userId);
      const target = role === 'admin' ? '/admin/dashboard' : '/employee/dashboard';
      openTrackerWindow(target);
      registerIPC();
      if (role !== 'admin') {
        startTracking(sess, userId);
        startHeartbeat();
      }
    } else {
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
      openLoginWindow();
    }
  } else {
    openLoginWindow();
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopHeartbeat();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function extractSession(cookies) {
  try {
    const authCookie = cookies.find(c => c.name === 'sb-wowhjuzkglgseqwznxpw-auth-token');
    if (!authCookie) return null;
    let raw = decodeURIComponent(authCookie.value);
    if (raw.startsWith('base64-')) {
      raw = Buffer.from(raw.slice(7), 'base64').toString('utf-8');
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? JSON.parse(Buffer.from(parsed.join(''), 'base64').toString('utf-8'))
      : parsed;
  } catch (e) {
    console.error('extractSession failed:', e);
    return null;
  }
}

function loadToken() {
  try {
    if (fs.existsSync(OLD_TOKEN_FILE)) {
      fs.unlinkSync(OLD_TOKEN_FILE);
    }
    if (fs.existsSync(TOKEN_FILE)) {
      const encrypted = fs.readFileSync(TOKEN_FILE);
      const decrypted = safeStorage.decryptString(encrypted);
      return JSON.parse(decrypted);
    }
  } catch (e) {
    console.error('Token load failed:', e);
  }
  return null;
}

function saveToken(data) {
  try {
    const encrypted = safeStorage.encryptString(JSON.stringify(data));
    fs.writeFileSync(TOKEN_FILE, encrypted);
  } catch (e) {
    console.error('Token save failed:', e);
  }
}

// ─── LOGIN WINDOW ─────────────────────────────────────────────────────────────
function openLoginWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 600,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL(WEB_APP_URL);
  win.setMenuBarVisibility(false);

  const checkLogin = setInterval(async () => {
    const cookies    = await session.defaultSession.cookies.get({ url: WEB_APP_URL });
    const authCookie = cookies.find(c => c.name === 'sb-wowhjuzkglgseqwznxpw-auth-token');
    if (authCookie) {
      clearInterval(checkLogin);
      try {
        let raw = decodeURIComponent(authCookie.value);
        if (raw.startsWith('base64-')) {
          raw = Buffer.from(raw.slice(7), 'base64').toString('utf-8');
        }
        const parsed = JSON.parse(raw);
        const sess   = Array.isArray(parsed)
          ? JSON.parse(Buffer.from(parsed.join(''), 'base64').toString('utf-8'))
          : parsed;
        const uid = sess.user?.id;

        if (sess.access_token && uid) {
          userId = uid;

          const freshSess = await getFreshSession(sess.access_token, sess.refresh_token);
          if (!freshSess) {
            console.error('openLoginWindow: could not refresh session after login');
            savedSession = sess;
          } else {
            savedSession = freshSess;
          }

          const activeSession = freshSess ?? sess;
          const role          = await getRoleFromProfiles(uid);
          const target        = role === 'admin' ? '/admin/dashboard' : '/employee/dashboard';

          saveToken({ userId, cookies });
          win.close();
          openTrackerWindow(target);
          registerIPC(); // FIX 2: guard inside registerIPC ensures no duplicate handlers

          if (role !== 'admin') {
            startTracking(activeSession, userId);
            startHeartbeat();
          }
        }
      } catch (e) {
        console.error('Cookie parse failed:', e);
      }
    }
  }, 2000);
}

// ─── TRACKER WINDOW ───────────────────────────────────────────────────────────
function openTrackerWindow(targetPath = null) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenuBarVisibility(false);

  let sessionInjected = false;

  // FIX 1: Use handleLogout() — cleans up + reopens login window
  const checkLogout = setInterval(async () => {
    const cookies    = await session.defaultSession.cookies.get({ url: WEB_APP_URL });
    const authCookie = cookies.find(c => c.name === 'sb-wowhjuzkglgseqwznxpw-auth-token');
    if (!authCookie) {
      clearInterval(checkLogout);
      await handleLogout();
    }
  }, 5000);

  mainWindow.webContents.on('did-finish-load', async () => {
    if (savedSession && savedSession.access_token && savedSession.refresh_token && !sessionInjected) {
      sessionInjected = true;
      const accessToken  = savedSession.access_token;
      const refreshToken = savedSession.refresh_token;
      const url          = SUPABASE_URL;
      const key          = ANON_KEY;
      await mainWindow.webContents.executeJavaScript(`
        (async function() {
          try {
            const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
            const sb = createClient('${url}', '${key}');
            const { data, error } = await sb.auth.setSession({
              access_token: '${accessToken}',
              refresh_token: '${refreshToken}'
            });
            if (!error && data.session) {
              console.log('Session restored successfully');
            } else {
              console.error('setSession error:', error?.message);
            }
          } catch(e) {
            console.error('Session inject failed:', e);
          }
        })();
      `);
      savedSession = null;
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  const loadURL = targetPath ? `${WEB_APP_URL}${targetPath}` : WEB_APP_URL;
  mainWindow.loadURL(loadURL);

  initTray(mainWindow);
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
// FIX 2: Register only once — handlers use module-level `userId` which updates on re-login
function registerIPC() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('get-flags', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const { data, error } = await supabase
      .from('activity_flags')
      .select('*')
      .eq('employee_id', userId)
      .gte('flagged_at', `${today}T00:00:00.000Z`)
      .lte('flagged_at', `${today}T23:59:59.999Z`)
      .order('flagged_at', { ascending: true });
    if (error) { console.error('Fetch flags error:', error); return []; }
    return data;
  });

  ipcMain.handle('submit-explanation', async (_, { flagId, explanation }) => {
    const { error } = await supabase
      .from('activity_flags')
      .update({ explanation, status: 'explained' })
      .eq('id', flagId);
    if (error) console.error('Explanation submit error:', error);
  });
}

module.exports = { getUserId: () => userId };