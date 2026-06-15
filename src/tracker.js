const { powerMonitor } = require('electron');
const { supabase } = require('./supabase');

const INACTIVE_THRESHOLD = 5 * 60 * 1000;  // 5 min to be considered idle
const CHECK_INTERVAL     = 1 * 60 * 1000;  // check every 1 min
const WORK_START = { hour: 9,  minute: 30 };
const WORK_END   = { hour: 18, minute: 0 };

let trackingInterval = null;
let lastActiveTime   = null;
let idleStartTime    = null;
let flagging         = false;
let currentUserId    = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// FIX 1: Returns work-end timestamp (ms) for the IST day that idleStartTs belongs to
function getWorkEndForDay(timestampMs) {
  const dateStr = new Date(timestampMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const hh = String(WORK_END.hour).padStart(2, '0');
  const mm = String(WORK_END.minute).padStart(2, '0');
  return new Date(`${dateStr}T${hh}:${mm}:00+05:30`).getTime();
}

// FIX 2 & 4: Returns IST date string (YYYY-MM-DD) for any timestamp
function getISTDateStr(timestampMs) {
  return new Date(timestampMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
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
  // FIX 1: Cap idleEndTs at work-end of the SAME IST day as idleStartTs
  // Prevents overnight / post-work-hours inflation
  const workEndTs  = getWorkEndForDay(idleStartTs);
  const cappedEnd  = Math.min(idleEndTs, workEndTs);

  const durationMs   = cappedEnd - idleStartTs;
  const durationMins = Math.round(durationMs / 60000);

  // Skip if capping made duration trivial
  if (durationMins < 1) {
    console.log('Flag skipped: capped duration < 1 min');
    await logEvent('flag_skipped', 'capped duration < 1 min');
    return;
  }

  const { error } = await supabase
    .from('activity_flags')
    .insert({
      employee_id:      currentUserId,
      idle_start:       new Date(idleStartTs).toISOString(),
      flagged_at:       new Date(cappedEnd).toISOString(),  // capped end, not raw now
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

// ─── Activity Handler ─────────────────────────────────────────────────────────

async function handleActivity() {
  const now = Date.now();

  if (idleStartTime !== null && !flagging) {
    // FIX 2: Discard idleStartTime if it's from a DIFFERENT IST day (PC was asleep overnight)
    const idleDay = getISTDateStr(idleStartTime);
    const today   = getISTDateStr(now);

    if (idleDay !== today) {
      console.log(`Stale idleStartTime from ${idleDay} discarded (today is ${today})`);
      await logEvent('idle_discarded', `stale idle from ${idleDay}`);
      idleStartTime = null;
    } else {
      const capturedStart = idleStartTime;
      idleStartTime = null;

      const duration = now - capturedStart;
      if (duration >= INACTIVE_THRESHOLD) {
        flagging = true;
        await createFlag(capturedStart, now);
        flagging = false;
      }
    }
  }

  lastActiveTime = now;
}

// ─── Main Tracking ────────────────────────────────────────────────────────────

async function startTracking(session, userId) {
  currentUserId  = userId;
  lastActiveTime = Date.now();
  idleStartTime  = null;
  flagging       = false;

  if (session?.access_token && session?.refresh_token) {
    await supabase.auth.setSession({
      access_token:  session.access_token,
      refresh_token: session.refresh_token,
    });
  }

  await logEvent('started');

  // FIX 3: Reset all state when PC wakes from sleep
  // Without this: lastActiveTime is stale → interval thinks overnight = one big idle
  powerMonitor.on('resume', async () => {
    console.log('PC resumed from sleep — resetting tracking state');
    lastActiveTime = Date.now();
    idleStartTime  = null;
    await logEvent('resume', 'PC woke from sleep, tracking state reset');
  });

  const { uIOhook } = require('uiohook-napi');
  uIOhook.on('mousemove', handleActivity);
  uIOhook.on('keydown',   handleActivity);
  uIOhook.start();

  if (trackingInterval) clearInterval(trackingInterval);

  trackingInterval = setInterval(async () => {
    const now              = Date.now();
    const inactiveDuration = now - lastActiveTime;

    await logEvent('heartbeat',
      `inactive: ${Math.floor(inactiveDuration / 1000)}s | idling: ${idleStartTime !== null}`
    );

    // Past work end — close any open idle and return
    if (isPastWorkEnd()) {
      if (idleStartTime !== null && !flagging) {
        const capturedStart = idleStartTime;
        idleStartTime = null;
        const duration = now - capturedStart;
        if (duration >= INACTIVE_THRESHOLD) {
          flagging = true;
          await createFlag(capturedStart, now); // createFlag caps at work-end anyway
          flagging = false;
        }
      }
      return;
    }

    // Before work start — skip
    if (!isWorkingHours()) return;

    // Detect idle start
    if (inactiveDuration >= INACTIVE_THRESHOLD && idleStartTime === null) {
      // FIX 4: lastActiveTime is from a previous day (PC left on, no logout, no sleep)
      // Don't flag overnight gap — just reset lastActiveTime to now and start fresh
      const lastActiveDay = getISTDateStr(lastActiveTime);
      const today         = getISTDateStr(now);
      if (lastActiveDay !== today) {
        console.log(`lastActiveTime from ${lastActiveDay} — resetting to now, no flag`);
        await logEvent('last_active_reset', `stale lastActiveTime from ${lastActiveDay}`);
        lastActiveTime = now;
        return;
      }

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