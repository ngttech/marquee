const express = require('express');
const router = express.Router();
const { getState, setState, getRooms, broadcastToRoom, initRooms, deleteState } = require('../state');
const { getMaskedConfig, updateConfig, getRoomConfig, setRoomConfig, deleteRoomConfig, getConfiguredRoomSlugs } = require('../config');

const screensaver = require('../services/screensaver');
const espn = require('../services/espn');
const ha = require('../services/ha');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/;

// ── Config endpoints ──

// GET /api/config — returns masked config
router.get('/config', (req, res) => {
  res.json(getMaskedConfig());
});

// POST /api/config — saves global config (token preservation handled in updateConfig)
router.post('/config', (req, res) => {
  try {
    const updated = updateConfig(req.body);
    // Re-read masked for response
    res.json({ ok: true, config: getMaskedConfig() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tmdb/test — validate TMDB API key
router.get('/tmdb/test', async (req, res) => {
  try {
    const { testApiKey } = require('../services/tmdb');
    const { getConfig, MASK } = require('../config');
    let key = req.query.key || '';
    console.log('[tmdb/test] key length:', key.length, 'masked:', key === MASK);
    if (!key || key === MASK) key = getConfig().global.tmdbApiKey || '';
    const result = await testApiKey(key);
    console.log('[tmdb/test] result:', result);
    res.json(result);
  } catch (err) {
    console.error('[tmdb/test] error:', err);
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// GET /api/plex/test — validate Plex connection
router.get('/plex/test', async (req, res) => {
  try {
    const { testPlexConnection } = require('../services/plex');
    const { getConfig } = require('../config');
    const cfg = getConfig().global;
    const result = await testPlexConnection(cfg.plexUrl, cfg.plexToken);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// GET /api/ha/test — validate Home Assistant connection
router.get('/ha/test', async (req, res) => {
  try {
    const { getConfig } = require('../config');
    const cfg = getConfig().global;
    const result = await ha.testConnection(cfg.haUrl, cfg.haToken);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// GET /api/plex-image — proxy Plex image requests
router.get('/plex-image', async (req, res) => {
  try {
    const imgPath = req.query.path;
    if (!imgPath) return res.status(400).json({ error: 'Missing path parameter' });
    const { getConfig } = require('../config');
    const cfg = getConfig().global;
    if (!cfg.plexUrl || !cfg.plexToken) return res.status(500).json({ error: 'Plex not configured' });

    const url = `${cfg.plexUrl}${imgPath}?X-Plex-Token=${cfg.plexToken}`;
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).end();

    res.set('Cache-Control', 'public, max-age=86400');
    const contentType = response.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);

    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Proxy error' });
  }
});

// GET /api/screensaver/:room/status — pool status for debugging
router.get('/screensaver/:room/status', (req, res) => {
  const { room } = req.params;
  const info = screensaver.getSlideInfo(room);
  const roomCfg = getRoomConfig(room);
  res.json({
    itemCount: info.totalItems,
    currentIndex: info.currentIndex,
    sources: roomCfg?.screensaverSources || [],
  });
});

// POST /api/screensaver/:room/rebuild — force rebuild pool
router.post('/screensaver/:room/rebuild', async (req, res) => {
  const { room } = req.params;
  try {
    await screensaver.rebuildPool(room);
    const info = screensaver.getSlideInfo(room);
    res.json({ ok: true, itemCount: info.totalItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Room CRUD ──

// GET /api/rooms — list all rooms with config info
router.get('/rooms', (req, res) => {
  const rooms = getRooms().map(slug => {
    const cfg = getRoomConfig(slug) || {};
    return {
      slug,
      name: cfg.name || slug,
      theme: cfg.theme || 'default',
      mode: getState(slug)?.mode || 'screensaver',
      title: getState(slug)?.title || null,
    };
  });
  res.json(rooms);
});

// POST /api/rooms — create a new room
router.post('/rooms', (req, res) => {
  const { slug, name, theme, bannerText, plexPlayerName, haEntity } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'Missing slug' });
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'Slug must be 2-30 chars, lowercase alphanumeric and hyphens only' });
  }
  if (getRoomConfig(slug)) {
    return res.status(409).json({ error: 'Room already exists' });
  }

  const roomData = {
    name: name || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    theme: theme || 'default',
    bannerText: bannerText || 'Now Playing',
    plexPlayerName: plexPlayerName || '',
    haEntity: haEntity || '',
    trailerMode: 'off',
    trailerDelay: 30,
    screensaverInterval: 15,
  };

  setRoomConfig(slug, roomData);
  initRooms(getConfiguredRoomSlugs());
  res.status(201).json({ ok: true, slug, room: roomData });
});

// PUT /api/rooms/:slug — update room config (partial merge)
router.put('/rooms/:slug', (req, res) => {
  const { slug } = req.params;
  if (!getRoomConfig(slug)) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const updated = setRoomConfig(slug, req.body);

  // Broadcast updated theme/banner to connected clients
  const state = getState(slug);
  if (state) {
    const { getRoomPayload } = require('../index');
    const payload = getRoomPayload(slug);
    if (payload) broadcastToRoom(slug, payload);
  }

  // Always rebuild screensaver pool on settings change — rebuildPool will
  // start rotation, and if the room is actively playing, the next webhook stops it
  screensaver.rebuildPool(slug).catch(err =>
    console.error(`[api] Failed to rebuild screensaver pool for ${slug}:`, err.message)
  );

  // Start/stop ESPN polling when sports settings change
  if (updated.autoSwitchSports && updated.trackedTeams?.length > 0) {
    espn.startPolling(slug);
  } else {
    espn.stopPolling(slug);
  }

  // Start/stop HA polling when haEntity changes
  if (updated.haEntity) {
    ha.startPolling(slug);
  } else {
    ha.stopPolling(slug);
  }

  res.json({ ok: true, slug, room: updated });
});

// DELETE /api/rooms/:slug — delete room (prevents deleting last room)
router.delete('/rooms/:slug', (req, res) => {
  const { slug } = req.params;
  if (!getRoomConfig(slug)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  if (getConfiguredRoomSlugs().length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last room' });
  }

  screensaver.stopRotation(slug);
  deleteRoomConfig(slug);
  deleteState(slug);
  res.json({ ok: true, slug });
});

// ── State endpoints ──

// GET /api/state/:room — get current state for a room
router.get('/state/:room', (req, res) => {
  const state = getState(req.params.room);
  if (!state) return res.status(404).json({ error: 'Room not found' });
  res.json(state);
});

// POST /api/display/:room — manually set display state
router.post('/display/:room', (req, res) => {
  const room = req.params.room;
  const data = req.body;
  if (!data || !data.mode) {
    return res.status(400).json({ error: 'Missing mode in body' });
  }
  setState(room, data);

  // Broadcast augmented payload
  try {
    const { getRoomPayload } = require('../index');
    const payload = getRoomPayload(room);
    if (payload) {
      broadcastToRoom(room, payload);
    } else {
      broadcastToRoom(room, data);
    }
  } catch {
    broadcastToRoom(room, data);
  }

  res.json({ ok: true, room, state: data });
});

// ── Sports endpoints ──

// GET /api/sports/live — fetch all live games from ESPN
router.get('/sports/live', async (req, res) => {
  try {
    const games = await espn.fetchAllLiveGames();
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sports/push/:room — manually push a game to a room
router.post('/sports/push/:room', (req, res) => {
  const { room } = req.params;
  const { game } = req.body || {};
  if (!game || !game.sport) {
    return res.status(400).json({ error: 'Missing game data with sport field' });
  }
  espn.pushGameToRoom(room, game);
  res.json({ ok: true });
});

// POST /api/sports/stop/:room — stop sports mode, revert to screensaver
router.post('/sports/stop/:room', async (req, res) => {
  const { room } = req.params;
  espn.stopPolling(room);

  const state = getState(room);
  if (state?.mode?.startsWith('sports-')) {
    setState(room, { ...state, mode: 'screensaver' });
    screensaver.startRotation(room).catch(err =>
      console.error(`[api] Failed to start screensaver for ${room}:`, err.message)
    );
    try {
      const { getRoomPayload } = require('../index');
      const payload = getRoomPayload(room);
      if (payload) broadcastToRoom(room, payload);
    } catch {
      broadcastToRoom(room, { ...state, mode: 'screensaver' });
    }
  }
  res.json({ ok: true });
});

module.exports = router;
