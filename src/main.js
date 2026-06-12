const { app, BrowserWindow, ipcMain, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { initTray } = require('./tray');
const { supabase, ANON_KEY, SUPABASE_URL } = require('./supabase');
const { startTracking, stopTracking } = require('./tracker');

const TOKEN_FILE = path.join(app.getPath('userData'), 'auth.bin');
const OLD_TOKEN_FILE = path.join(app.getPath('userData'), 'auth.json'); 
const WEB_APP_URL = 'https://narrativex-tracker.vercel.app';

let mainWindow = null;
let userId = null;
let savedSession = null;

function setAutoStart(enable = true) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: enable,
    openAsHidden: true,
    name: 'NarrativeX Agent',
    path: process.execPath,
  });
}

async function refreshAndSaveSession(saved) {
  try {
    const sess = extractSession(saved.cookies);
    if (!sess?.access_token || !sess?.refresh_token) {
      console.error('refreshAndSaveSession: missing tokens in auth.json');
      return null;
    }

    const { data, error } = await supabase.auth.setSession({
      access_token: sess.access_token,
      refresh_token: sess.refresh_token,
    });

    if (error || !data?.session) {
      console.error('Token refresh failed:', error?.message ?? 'no session returned');
      return null;
    }

    const freshSession = data.session;

    const updatedCookies = (saved.cookies || []).map(c => {
      if (c.name === 'sb-wowhjuzkglgseqwznxpw-auth-token') {
        return {
          ...c,
          value: encodeURIComponent(JSON.stringify({
            access_token: freshSession.access_token,
            refresh_token: freshSession.refresh_token,
            user: freshSession.user,
            expires_at: freshSession.expires_at,
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

app.whenReady().then(async () => {
  setAutoStart(true);

  const saved = loadToken();
  if (saved) {
    const sess = await refreshAndSaveSession(saved);
    if (sess) {
      userId = sess.user.id;
      savedSession = sess;
      const role = sess.user?.user_metadata?.role;
      const target = role === 'admin' ? '/admin/dashboard' : '/employee/dashboard';
      openTrackerWindow(target);
      registerIPC();
      if (role !== 'admin') startTracking(sess, userId);
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

// REPLACE loadToken
function loadToken() {
  try {
    // Migrate: delete old plaintext file if exists
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

// REPLACE saveToken
function saveToken(data) {
  try {
    const encrypted = safeStorage.encryptString(JSON.stringify(data));
    fs.writeFileSync(TOKEN_FILE, encrypted);
  } catch (e) {
    console.error('Token save failed:', e);
  }
}

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
    const cookies = await session.defaultSession.cookies.get({ url: WEB_APP_URL });
    const authCookie = cookies.find(c => c.name === 'sb-wowhjuzkglgseqwznxpw-auth-token');
    if (authCookie) {
      clearInterval(checkLogin);
      try {
        let raw = decodeURIComponent(authCookie.value);
        if (raw.startsWith('base64-')) {
          raw = Buffer.from(raw.slice(7), 'base64').toString('utf-8');
        }
        const parsed = JSON.parse(raw);
        const sess = Array.isArray(parsed)
          ? JSON.parse(Buffer.from(parsed.join(''), 'base64').toString('utf-8'))
          : parsed;
        const uid = sess.user?.id;
        if (sess.access_token && uid) {
          userId = uid;
          savedSession = sess;
          const role = sess.user?.user_metadata?.role;
          const target = role === 'admin' ? '/admin/dashboard' : '/employee/dashboard';
          saveToken({ userId, cookies });
          win.close();
          openTrackerWindow(target);
          registerIPC();
          if (role !== 'admin') startTracking(sess, userId);
        }
      } catch (e) {
        console.error('Cookie parse failed:', e);
      }
    }
  }, 2000);
}

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
   // Watch for logout
const checkLogout = setInterval(async () => {
  const cookies = await session.defaultSession.cookies.get({ url: WEB_APP_URL });
  const authCookie = cookies.find(c => c.name === 'sb-wowhjuzkglgseqwznxpw-auth-token');
  if (!authCookie) {
    clearInterval(checkLogout);
    stopTracking();
    userId = null;
    savedSession = null;
    try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
    console.log('Logged out — tracking stopped, token cleared.');
  }
}, 5000);
  mainWindow.webContents.on('did-finish-load', async () => {
    if (savedSession && savedSession.access_token && savedSession.refresh_token && !sessionInjected) {
      sessionInjected = true;
      const accessToken = savedSession.access_token;
      const refreshToken = savedSession.refresh_token;
      const url = SUPABASE_URL;
      const key = ANON_KEY;
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

function registerIPC() {
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