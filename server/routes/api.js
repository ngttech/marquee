const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { getState, setState, getRooms, broadcastToRoom, initRooms, deleteState } = require('../state');
const { getConfig, getMaskedConfig, updateConfig, getRoomConfig, setRoomConfig, deleteRoomConfig, getConfiguredRoomSlugs, DATA_DIR } = require('../config');

const screensaver = require('../services/screensaver');
const espn = require('../services/espn');
const ha = require('../services/ha');
const plexPoller = require('../services/plexPoller');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/;

// ── Sport backdrop uploads ──
const BACKDROP_SPORTS = ['soccer', 'nfl', 'nba', 'mlb', 'nhl', 'ufc'];
const BACKDROP_DIR = path.join(DATA_DIR, 'uploads', 'backdrops');
const backdropUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { fs.mkdirSync(BACKDROP_DIR, { recursive: true }); cb(null, BACKDROP_DIR); }
      catch (err) { cb(err); }
    },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${req.params.sport}-${Date.now()}${ext || '.png'}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!BACKDROP_SPORTS.includes(req.params.sport)) return cb(new Error('Invalid sport'));
    const isImage = /^image\//.test(file.mimetype) ||
      /\.(png|jpe?g|webp|gif|avif)$/i.test(file.originalname || '');
    if (!isImage) return cb(new Error('File must be an image'));
    cb(null, true);
  },
});

// Remove every stored custom file for a sport (filenames are `<sport>-<ts>.<ext>`)
function clearBackdropFiles(sport, except) {
  try {
    if (!fs.existsSync(BACKDROP_DIR)) return;
    for (const f of fs.readdirSync(BACKDROP_DIR)) {
      if (f.startsWith(`${sport}-`) && f !== except) {
        try { fs.unlinkSync(path.join(BACKDROP_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// Persist a sport's backdrop URL (or remove it when url is falsy)
function setSportBackdrop(sport, url) {
  const backdrops = { ...(getConfig().global.sportBackdrops || {}) };
  if (url) backdrops[sport] = url; else delete backdrops[sport];
  updateConfig({ global: { sportBackdrops: backdrops } });
}

// Live-update any display currently showing this sport
function broadcastSportBackdrop(sport) {
  let getRoomPayload;
  try { ({ getRoomPayload } = require('../index')); } catch { return; }
  for (const slug of getConfiguredRoomSlugs()) {
    if (getState(slug)?.mode === `sports-${sport}`) {
      const payload = getRoomPayload(slug);
      if (payload) broadcastToRoom(slug, payload);
    }
  }
}

// ── Config endpoints ──

// GET /api/config — returns masked config
router.get('/config', (req, res) => {
  res.json(getMaskedConfig());
});

// POST /api/config — saves global config (token preservation handled in updateConfig)
router.post('/config', (req, res) => {
  try {
    const updated = updateConfig(req.body);

    // Restart Plex polling if IP/port changed
    if (req.body.global && (req.body.global.plexIp !== undefined || req.body.global.plexPort !== undefined)) {
      for (const slug of getConfiguredRoomSlugs()) {
        const roomCfg = getRoomConfig(slug);
        if (roomCfg?.plexPlayerName) {
          plexPoller.startPolling(slug);
        }
      }
    }

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

// GET /api/plex/test — validate Plex connection + show active sessions
router.get('/plex/test', async (req, res) => {
  try {
    const { testPlexConnection, fetchSessions } = require('../services/plex');
    const { getPlexBaseUrl, getConfig } = require('../config');
    const cfg = getConfig().global;
    const plexBaseUrl = getPlexBaseUrl();
    const result = await testPlexConnection(plexBaseUrl, cfg.plexToken);

    // On success, also fetch active sessions
    if (result.ok && plexBaseUrl) {
      const sessions = await fetchSessions(plexBaseUrl, cfg.plexToken);
      result.sessions = sessions.map(s => ({
        playerName: s.Player?.title || 'Unknown',
        device: s.Player?.device || '',
        platform: s.Player?.platform || '',
        state: s.Player?.state || s.state || '',
        title: s.grandparentTitle
          ? `${s.grandparentTitle} — ${s.title}`
          : s.title || 'Unknown',
      }));
      result.sessionCount = sessions.length;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
});

// GET /api/plex/players — list active Plex sessions for player discovery
router.get('/plex/players', async (req, res) => {
  try {
    const { fetchSessions } = require('../services/plex');
    const { getPlexBaseUrl, getConfig } = require('../config');
    const cfg = getConfig().global;
    const plexBaseUrl = getPlexBaseUrl();
    if (!plexBaseUrl) return res.status(400).json({ error: 'Plex not configured' });

    const sessions = await fetchSessions(plexBaseUrl, cfg.plexToken);
    const players = sessions.map(s => ({
      playerName: s.Player?.title || 'Unknown',
      device: s.Player?.device || '',
      platform: s.Player?.platform || '',
      state: s.Player?.state || s.state || '',
      title: s.grandparentTitle
        ? `${s.grandparentTitle} — ${s.title}`
        : s.title || 'Unknown',
    }));
    res.json(players);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
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
    const { getConfig, getPlexBaseUrl } = require('../config');
    const cfg = getConfig().global;
    const plexBaseUrl = getPlexBaseUrl();
    if (!plexBaseUrl) return res.status(500).json({ error: 'Plex not configured' });

    const tokenParam = cfg.plexToken ? `?X-Plex-Token=${cfg.plexToken}` : '';
    const url = `${plexBaseUrl}${imgPath}${tokenParam}`;
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

  // Start/stop HA polling when haEntity changes
  if (updated.haEntity) {
    ha.startPolling(slug);
  } else {
    ha.stopPolling(slug);
  }

  // Start/stop Plex polling when plexPlayerName changes
  if (updated.plexPlayerName) {
    plexPoller.startPolling(slug);
  } else {
    plexPoller.stopPolling(slug);
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
    // Filter out finished games — only show upcoming and in-progress
    const active = games.filter(g => g.status !== 'post');
    res.json(active);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sports/worldcup — full 2026 World Cup schedule (past, live, and upcoming)
router.get('/sports/worldcup', async (req, res) => {
  try {
    const games = await espn.fetchWorldCupGames();
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sports/backdrop/:sport — upload a custom backdrop image for a sport
router.post('/sports/backdrop/:sport', (req, res) => {
  backdropUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const { sport } = req.params;
    if (!BACKDROP_SPORTS.includes(sport)) return res.status(400).json({ error: 'Invalid sport' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    clearBackdropFiles(sport, req.file.filename); // keep only the new file
    const url = `/uploads/backdrops/${req.file.filename}`;
    setSportBackdrop(sport, url);
    broadcastSportBackdrop(sport);
    res.json({ url });
  });
});

// DELETE /api/sports/backdrop/:sport — revert a sport to its bundled default backdrop
router.delete('/sports/backdrop/:sport', (req, res) => {
  const { sport } = req.params;
  if (!BACKDROP_SPORTS.includes(sport)) return res.status(400).json({ error: 'Invalid sport' });
  clearBackdropFiles(sport);
  setSportBackdrop(sport, null);
  broadcastSportBackdrop(sport);
  res.json({ ok: true });
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
