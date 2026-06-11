const { powerMonitor } = require('electron');
const { supabase } = require('./supabase');

const INACTIVE_THRESHOLD = 5 * 60 * 1000;  // 5 min to be considered idle
const CHECK_INTERVAL     = 1 * 60 * 1000;  // check every 1 min
const WORK_START = { hour: 9,  minute: 30 };
const WORK_END   = { hour: 18, minute: 30 };

let trackingInterval = null;
let lastActiveTime   = null;   // last mouse/key event
let idleStartTime    = null;   // when current idle period began (null = not idle)
let flagging         = false;  // guard against double-flag on rapid events
let currentUserId    = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getISTTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function isWorkingHours() {
  const now       = getISTTime();
  const totalMins = now.getHours() * 60 + now.getMinutes();
  const startMins = WORK_START.hour * 60 + WORK_START.minute;
  const endMins   = WORK_END.hour   * 60 + WORK_END.minute;
  return totalMins >= startMins && totalMins <= endMins;
}

function isPastWorkEnd() {
  const now       = getISTTime();
  const totalMins = now.getHours() * 60 + now.getMinutes();
  const endMins   = WORK_END.hour * 60 + WORK_END.minute;
  return totalMins > endMins;
}

async function logEvent(event, detail = null) {
  if (!currentUserId) return;
  const { error } = await supabase
    .from('agent_logs')
    .insert({ employee_id: currentUserId, event, detail, ts: new Date().toISOString() });
  if (error) console.error('Log insert failed:', error.message);
}

// ─── Flag Creation ────────────────────────────────────────────────────────────

async function createFlag(idleStartTs, idleEndTs) {
  const durationMs   = idleEndTs - idleStartTs;
  const durationMins = Math.round(durationMs / 60000);

  const { error } = await supabase
    .from('activity_flags')
    .insert({
      employee_id:      currentUserId,
      idle_start:       new Date(idleStartTs).toISOString(),  // idle began
      flagged_at:       new Date(idleEndTs).toISOString(),    // idle ended
      duration_minutes: durationMins,
      status:           'pending',
    });

  if (error) {
    console.error('Flag insert failed:', error);
    await logEvent('error', `flag_insert_failed: ${error.message}`);
  } else {
    console.log(`Flag created: ${durationMins} mins idle`);
    await logEvent('flag_inserted', `${durationMins} mins idle`);
  }
}

// ─── Activity Handler (called on every mouse/key event) ───────────────────────

async function handleActivity() {
  const now = Date.now();

  // Transitioning from idle → active
  if (idleStartTime !== null && !flagging) {
    const capturedStart = idleStartTime;
    idleStartTime = null;  // clear immediately — prevents re-entry from rapid events

    const duration = now - capturedStart;
    if (duration >= INACTIVE_THRESHOLD) {
      flagging = true;
      await createFlag(capturedStart, now);
      flagging = false;
    }
  }

  lastActiveTime = now;
}

// ─── Main Tracking ────────────────────────────────────────────────────────────

async function startTracking(session, userId) {
  currentUserId  = userId;
  lastActiveTime = Date.now();  // reset to NOW (not module load time)
  idleStartTime  = null;
  flagging       = false;

  if (session?.access_token && session?.refresh_token) {
    await supabase.auth.setSession({
      access_token:  session.access_token,
      refresh_token: session.refresh_token,
    });
  }

  await logEvent('started');

  const { uIOhook } = require('uiohook-napi');
  uIOhook.on('mousemove', handleActivity);
  uIOhook.on('keydown',   handleActivity);
  uIOhook.start();

  if (trackingInterval) clearInterval(trackingInterval);

  trackingInterval = setInterval(async () => {
    const now              = Date.now();
    const inactiveDuration = now - lastActiveTime;

    // Log heartbeat with current idle state
    await logEvent('heartbeat',
      `inactive: ${Math.floor(inactiveDuration / 1000)}s | idling: ${idleStartTime !== null}`
    );

    // Past work end — close any open idle period and stop
    if (isPastWorkEnd()) {
      if (idleStartTime !== null && !flagging) {
        const capturedStart = idleStartTime;
        idleStartTime = null;
        const duration = now - capturedStart;
        if (duration >= INACTIVE_THRESHOLD) {
          flagging = true;
          await createFlag(capturedStart, now);
          flagging = false;
        }
      }
      return;
    }

    // Within working hours — detect idle start
    if (!isWorkingHours()) return;

    if (inactiveDuration >= INACTIVE_THRESHOLD && idleStartTime === null) {
      // Idle period just crossed threshold — record when it began
      idleStartTime = lastActiveTime;
      console.log(`Idle period started at ${new Date(idleStartTime).toISOString()}`);
    }
  }, CHECK_INTERVAL);
}

function stopTracking() {
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
  idleStartTime = null;
}

module.exports = { startTracking, stopTracking };