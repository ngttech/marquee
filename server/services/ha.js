const { getClientCount } = require('../state');
const { getRoomConfig, getConfiguredRoomSlugs, getConfig } = require('../config');

// Broadcast callback — set via init() to avoid circular dependency
let broadcastFn = null;

// Per-room polling state
const roomPollers = {};

// Per-room last mode to avoid redundant broadcasts
const lastMode = {};

function init(callback) {
  broadcastFn = callback;
  console.log('[ha] Initialized with broadcast callback');
}

async function testConnection(haUrl, haToken) {
  if (!haUrl || !haToken) {
    return { ok: false, error: 'URL and token are required' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${haUrl.replace(/\/+$/, '')}/api/`, {
      headers: { Authorization: `Bearer ${haToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
    }

    const data = await res.json();
    return { ok: true, message: `Connected to ${data.location_name || 'Home Assistant'}` };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: 'Connection timed out (10s)' };
    }
    return { ok: false, error: err.message || 'Connection failed' };
  }
}

async function fetchEntityState(haUrl, haToken, entityId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${haUrl.replace(/\/+$/, '')}/api/states/${entityId}`, {
      headers: { Authorization: `Bearer ${haToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[ha] HTTP ${res.status} fetching ${entityId}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[ha] Timeout fetching ${entityId}`);
    } else {
      console.warn(`[ha] Error fetching ${entityId}:`, err.message);
    }
    return null;
  }
}

function mapHaStateToMode(entityState) {
  if (!entityState) return { mode: 'screensaver' };

  const state = entityState.state || entityState;
  const attrs = entityState.attributes || {};

  if (state !== 'playing') {
    return { mode: 'screensaver' };
  }

  const appName = (attrs.app_name || '').trim();

  // Let Plex handle its own playback
  if (appName.toLowerCase().includes('plex')) {
    return null;
  }

  // YouTube mode
  if (appName.toLowerCase().includes('youtube')) {
    return {
      mode: 'youtube',
      appName: 'YouTube',
      mediaTitle: attrs.media_title || null,
      mediaArtist: attrs.media_artist || null,
      mediaDuration: attrs.media_duration || null,
      mediaPosition: attrs.media_position || null,
    };
  }

  // Generic app mode
  return {
    mode: 'app',
    appName: appName || 'Unknown App',
    mediaTitle: attrs.media_title || null,
    mediaArtist: attrs.media_artist || null,
  };
}

function getEntityRoomMap() {
  const map = {};
  const slugs = getConfiguredRoomSlugs();
  for (const slug of slugs) {
    const roomCfg = getRoomConfig(slug);
    if (roomCfg?.haEntity) {
      map[roomCfg.haEntity] = slug;
    }
  }
  return map;
}

function startPolling(slug) {
  stopPolling(slug);

  const roomCfg = getRoomConfig(slug);
  if (!roomCfg?.haEntity) return;

  const pollInterval = 5000; // 5 seconds

  async function poll() {
    try {
      if (getClientCount(slug) === 0) return;

      const cfg = getConfig().global;
      if (!cfg.haUrl || !cfg.haToken) return;

      const entity = await fetchEntityState(cfg.haUrl, cfg.haToken, roomCfg.haEntity);
      if (!entity) return;

      const mapped = mapHaStateToMode(entity);

      // null = Plex is playing, don't interfere
      if (mapped === null) return;

      // Check current room state to avoid overriding Plex/sports modes
      const { getState, setState } = require('../state');
      const current = getState(slug);
      const currentMode = current?.mode || 'screensaver';

      // Never override nowplaying/nowplaying-tv/sports-* modes
      if (currentMode === 'nowplaying' || currentMode === 'nowplaying-tv' || currentMode.startsWith('sports-')) {
        return;
      }

      // Avoid redundant broadcasts
      const modeKey = `${mapped.mode}:${mapped.mediaTitle || ''}`;
      if (lastMode[slug] === modeKey) return;
      lastMode[slug] = modeKey;

      if (mapped.mode === 'screensaver') {
        // Only transition to screensaver if we were in youtube/app mode
        if (currentMode === 'youtube' || currentMode === 'app') {
          setState(slug, { ...current, mode: 'screensaver' });

          // Start screensaver rotation
          try {
            const screensaver = require('./screensaver');
            screensaver.startRotation(slug).catch(() => {});
          } catch (e) { /* ignore */ }

          // Restart ESPN polling if applicable
          try {
            const espn = require('./espn');
            const roomCfg2 = getRoomConfig(slug);
            if (roomCfg2?.autoSwitchSports && roomCfg2?.trackedTeams?.length > 0) {
              espn.startPolling(slug);
            }
          } catch (e) { /* ignore */ }

          if (broadcastFn) broadcastFn(slug);
        }
      } else {
        // youtube or app mode — stop screensaver + ESPN
        try {
          const screensaver = require('./screensaver');
          screensaver.stopRotation(slug);
        } catch (e) { /* ignore */ }

        try {
          const espn = require('./espn');
          espn.stopPolling(slug);
        } catch (e) { /* ignore */ }

        setState(slug, {
          ...current,
          ...mapped,
        });

        if (broadcastFn) broadcastFn(slug);
      }
    } catch (err) {
      console.warn(`[ha] Poll error for ${slug}:`, err.message);
    }
  }

  // Initial poll
  poll();

  // Start interval
  const timer = setInterval(poll, pollInterval);
  roomPollers[slug] = { timer };
  console.log(`[ha] Polling started for "${slug}" (${pollInterval / 1000}s interval)`);
}

function stopPolling(slug) {
  if (roomPollers[slug]) {
    clearInterval(roomPollers[slug].timer);
    delete roomPollers[slug];
    delete lastMode[slug];
    console.log(`[ha] Polling stopped for "${slug}"`);
  }
}

module.exports = { init, testConnection, fetchEntityState, mapHaStateToMode, getEntityRoomMap, startPolling, stopPolling };
