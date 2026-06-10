const { powerMonitor } = require('electron');
const { supabase } = require('./supabase');

const INACTIVE_THRESHOLD = 5 * 60 * 1000;
const WORK_START = { hour: 9, minute: 30 };
const WORK_END = { hour: 18, minute: 30 };

let trackingInterval = null;
let lastActiveTime = Date.now();
let currentUserId = null;

function getISTTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function isWorkingHours() {
  const now = getISTTime();
  const totalMins = now.getHours() * 60 + now.getMinutes();
  const startMins = WORK_START.hour * 60 + WORK_START.minute;
  const endMins = WORK_END.hour * 60 + WORK_END.minute;
  return totalMins >= startMins && totalMins <= endMins;
}

async function startTracking(session, userId) {
  currentUserId = userId;

  // Set auth session so RLS works when enabled
  if (session?.access_token && session?.refresh_token) {
    await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
  }

  const { uIOhook } = require('uiohook-napi');
  uIOhook.on('mousemove', () => { lastActiveTime = Date.now(); });
  uIOhook.on('keydown', () => { lastActiveTime = Date.now(); });
  uIOhook.start();

  if (trackingInterval) clearInterval(trackingInterval);

  trackingInterval = setInterval(async () => {
    if (!isWorkingHours()) return;
    const now = Date.now();
    const inactiveDuration = now - lastActiveTime;
    if (inactiveDuration >= INACTIVE_THRESHOLD) {
      await createFlag(inactiveDuration);
      lastActiveTime = now;
    }
  }, 60 * 1000);
}

function stopTracking() {
  if (trackingInterval) clearInterval(trackingInterval);
}

async function createFlag(durationMs) {
  const durationMins = Math.floor(durationMs / 60000);
  const { error } = await supabase
    .from('activity_flags')
    .insert({
      employee_id: currentUserId,
      flagged_at: new Date().toISOString(),
      duration_minutes: durationMins,
      status: 'pending',
    });
  if (error) console.error('Flag insert failed:', error);
  else console.log(`Flag created: ${durationMins} mins inactive`);
}

module.exports = { startTracking, stopTracking };