const express = require('express');
const multer = require('multer');
const router = express.Router();
const { parseWebhookPayload } = require('../services/plex');
const { getState, setState, getRooms, broadcastToRoom } = require('../state');
const { getPlayerRoomMap: getConfigPlayerMap } = require('../config');
const { handlePlexPlay, handlePlexStop, handlePlexPause } = require('../services/plexHandler');
const screensaver = require('../services/screensaver');
const espn = require('../services/espn');
const ha = require('../services/ha');

const upload = multer();

// Player name → room slug mapping (config-based with env var fallback)
function getPlayerRoomMap() {
  const configMap = getConfigPlayerMap();
  if (Object.keys(configMap).length > 0) return configMap;
  // Fallback to env var
  try {
    return JSON.parse(process.env.PLAYER_ROOM_MAP || '{}');
  } catch {
    return {};
  }
}

function resolveRoom(playerName) {
  const map = getPlayerRoomMap();
  if (playerName && map[playerName]) return map[playerName];
  return 'theater'; // default room
}

// POST /webhook/plex
router.post('/plex', upload.none(), async (req, res) => {
  // Respond immediately — Plex retries on timeout
  res.sendStatus(200);

  try {
    const raw = req.body?.payload;
    if (!raw) {
      console.warn('[webhook] No payload in request body');
      return;
    }

    const payload = JSON.parse(raw);
    const parsed = parseWebhookPayload(payload);

    console.log(`[webhook] ${parsed.event} — ${parsed.type} — ${parsed.title || '(no title)'}`);

    // Only handle movie and episode events
    if (parsed.type !== 'movie' && parsed.type !== 'episode') return;

    const room = resolveRoom(parsed.playerName);

    if (parsed.event === 'media.play' || parsed.event === 'media.resume') {
      await handlePlexPlay(room, parsed);
    } else if (parsed.event === 'media.pause') {
      handlePlexPause(room, parsed);
    } else if (parsed.event === 'media.stop') {
      await handlePlexStop(room);
    }
  } catch (err) {
    console.error('[webhook] Error processing payload:', err);
  }
});

// POST /webhook/ha
router.post('/ha', express.json(), async (req, res) => {
  res.sendStatus(200);

  try {
    const { entity_id, state: entityState, attributes, room: roomFromPayload } = req.body || {};

    if (!entity_id && !roomFromPayload) {
      console.warn('[webhook/ha] No entity_id or room in payload');
      return;
    }

    // Resolve room: use room from payload, or look up via entity→room map
    let room = roomFromPayload;
    if (!room) {
      const entityRoomMap = ha.getEntityRoomMap();
      room = entityRoomMap[entity_id];
    }
    if (!room) {
      console.warn(`[webhook/ha] No room mapping for entity ${entity_id}`);
      return;
    }

    console.log(`[webhook/ha] ${entity_id} → ${entityState} (room: ${room})`);

    const mapped = ha.mapHaStateToMode({ state: entityState, attributes: attributes || {} });

    // null = Plex is playing, don't interfere
    if (mapped === null) {
      console.log('[webhook/ha] Plex detected, ignoring');
      return;
    }

    const current = getState(room) || {};
    const currentMode = current.mode || 'screensaver';

    if (mapped.mode === 'screensaver') {
      // Only transition if current mode is youtube or app
      if (currentMode !== 'youtube' && currentMode !== 'app') return;

      const newState = { ...current, mode: 'screensaver' };
      setState(room, newState);

      try {
        const { getRoomPayload } = require('../index');
        const payload = getRoomPayload(room);
        broadcastToRoom(room, payload || newState);
      } catch {
        broadcastToRoom(room, newState);
      }

      // Start screensaver rotation
      screensaver.startRotation(room).catch(err =>
        console.error(`[webhook/ha] Failed to start screensaver for ${room}:`, err.message)
      );

    } else {
      // youtube or app mode — don't override Plex/sports
      if (currentMode === 'nowplaying' || currentMode === 'nowplaying-tv' || currentMode.startsWith('sports-')) {
        console.log(`[webhook/ha] Not overriding ${currentMode} mode`);
        return;
      }

      // Stop screensaver + ESPN
      screensaver.stopRotation(room);
      espn.stopPolling(room);

      const newState = { ...current, ...mapped };
      setState(room, newState);

      try {
        const { getRoomPayload } = require('../index');
        const payload = getRoomPayload(room);
        broadcastToRoom(room, payload || newState);
      } catch {
        broadcastToRoom(room, newState);
      }
    }
  } catch (err) {
    console.error('[webhook/ha] Error processing payload:', err);
  }
});

module.exports = router;
