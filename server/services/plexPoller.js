const { getClientCount, getState } = require('../state');
const { getRoomConfig, getConfig, getPlexBaseUrl } = require('../config');
const { fetchSessions, parseSessionPayload } = require('./plex');
const { handlePlexPlay, handlePlexStop, handlePlexPause } = require('./plexHandler');

let broadcastFn = null;

// Per-room polling state
const roomPollers = {};
const lastSessionState = {};

function init(callback) {
  broadcastFn = callback;
  console.log('[plexPoller] Initialized with broadcast callback');
}

function startPolling(slug) {
  stopPolling(slug);

  const roomCfg = getRoomConfig(slug);
  if (!roomCfg?.plexPlayerName) return;

  const pollInterval = 3000; // 3 seconds

  async function poll() {
    try {
      const plexBaseUrl = getPlexBaseUrl();
      if (!plexBaseUrl) return;

      const cfg = getConfig().global;
      const sessions = await fetchSessions(plexBaseUrl, cfg.plexToken);

      // Find session matching this room's player name
      const playerName = roomCfg.plexPlayerName;
      const session = sessions.find(s => s.Player?.title === playerName);

      const current = getState(slug);
      const currentMode = current?.mode || 'screensaver';
      const last = lastSessionState[slug];

      // Skip if current mode is sports (don't override manual sports push)
      if (currentMode.startsWith('sports-')) return;

      if (session) {
        const parsed = parseSessionPayload(session);
        const mediaKey = parsed.ratingKey || `${parsed.title}-${parsed.year}`;
        const isPaused = parsed.state === 'paused';

        if (isPaused) {
          // Paused — keep Now Playing screen, update progress
          if (currentMode === 'nowplaying' || currentMode === 'nowplaying-tv') {
            handlePlexPause(slug, parsed);
            lastSessionState[slug] = { mediaKey, state: 'paused' };
          }
        } else if (!last || last.mediaKey !== mediaKey) {
          // New media detected — full TMDB enrichment
          if (parsed.type === 'movie' || parsed.type === 'episode') {
            console.log(`[plexPoller] New play detected for "${slug}": ${parsed.title}`);
            await handlePlexPlay(slug, parsed);
            lastSessionState[slug] = { mediaKey, state: 'playing' };
          }
        } else if (last.state === 'paused' && !isPaused) {
          // Resumed from pause — same media, just broadcast current state
          console.log(`[plexPoller] Resumed for "${slug}": ${parsed.title}`);
          lastSessionState[slug] = { mediaKey, state: 'playing' };
          if (broadcastFn) broadcastFn(slug);
        } else {
          // Still playing same thing — update viewOffset/progress only
          if (currentMode === 'nowplaying-tv' && parsed.viewOffset !== undefined && parsed.duration) {
            const { setState } = require('../state');
            setState(slug, {
              ...current,
              viewOffset: parsed.viewOffset,
              progress: Math.round((parsed.viewOffset / parsed.duration) * 100),
            });
          }
          lastSessionState[slug] = { mediaKey, state: 'playing' };
        }
      } else {
        // No session found for this player
        if (last && (currentMode === 'nowplaying' || currentMode === 'nowplaying-tv')) {
          // Was playing, now stopped — transition to screensaver
          console.log(`[plexPoller] Playback stopped for "${slug}"`);
          await handlePlexStop(slug);
          delete lastSessionState[slug];
        }
      }
    } catch (err) {
      console.warn(`[plexPoller] Poll error for ${slug}:`, err.message);
    }
  }

  // Initial poll
  poll();

  const timer = setInterval(poll, pollInterval);
  roomPollers[slug] = { timer };
  console.log(`[plexPoller] Polling started for "${slug}" (${pollInterval / 1000}s interval)`);
}

function stopPolling(slug) {
  if (roomPollers[slug]) {
    clearInterval(roomPollers[slug].timer);
    delete roomPollers[slug];
    delete lastSessionState[slug];
    console.log(`[plexPoller] Polling stopped for "${slug}"`);
  }
}

module.exports = { init, startPolling, stopPolling };
