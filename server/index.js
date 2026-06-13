const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');
const { addClient, removeClient, getState, initRooms, broadcastToRoom } = require('./state');
const { getConfiguredRoomSlugs, getRoomConfig, getConfig, DATA_DIR } = require('./config');
const screensaver = require('./services/screensaver');
const espn = require('./services/espn');
const ha = require('./services/ha');
const plexPoller = require('./services/plexPoller');
const apiRoutes = require('./routes/api');
const webhookRoutes = require('./routes/webhook');

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve public dir: in Docker it's at __dirname/public, locally at ../public
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, '..', 'public');

// Sync state rooms with config on startup
initRooms(getConfiguredRoomSlugs());

// JSON body parsing for API routes
app.use('/api', express.json());

// Mount routes
app.use('/api', apiRoutes);
app.use('/webhook', webhookRoutes);

// Serve static files from public/
app.use(express.static(PUBLIC_DIR));

// Serve user-uploaded assets (e.g. sport backdrops) from the persistent data dir
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));

// Settings route — serve settings.html
app.get('/settings', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'settings.html'));
});

// Room display route — serve display.html for any /room/:slug
app.get('/room/:slug', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'display.html'));
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket server on same port
const wss = new WebSocketServer({ server });

function getRoomPayload(slug) {
  const state = getState(slug);
  if (!state) return null;
  const roomCfg = getRoomConfig(slug) || {};
  const payload = {
    ...state,
    theme: roomCfg.theme || 'default',
    bannerText: roomCfg.bannerText || 'Now Playing',
    roomName: roomCfg.name || slug,
  };

  // Augment sports payloads with sport-specific banner text
  if (state.mode?.startsWith('sports-')) {
    const SPORT_BANNERS = {
      'sports-soccer': 'Live Match',
      'sports-nfl': 'Live Game',
      'sports-nba': 'Live Game',
      'sports-ufc': 'Live Fight',
      'sports-mlb': 'Live Game',
      'sports-nhl': 'Live Game',
    };
    payload.bannerText = SPORT_BANNERS[state.mode] || 'Live';
    payload.sportBackdrops = getConfig().global.sportBackdrops || {};
  }

  // Augment YouTube/app payloads with appropriate banner text
  if (state.mode === 'youtube') {
    payload.bannerText = 'Watching Now';
  } else if (state.mode === 'app') {
    payload.bannerText = roomCfg.bannerText || 'Now Playing';
  }

  // Augment screensaver payloads with slide info and source-based banner
  if (state.mode === 'screensaver') {
    const slideInfo = screensaver.getSlideInfo(slug);
    payload.slideIndex = slideInfo.currentIndex;
    payload.slideCount = slideInfo.totalItems;
    payload.screensaverInterval = roomCfg.screensaverInterval || 15;

    // Dynamic banner text from slide source, not room config
    const SOURCE_BANNERS = {
      coming_soon: 'Coming Soon',
      recently_added: 'Recently Added',
      recently_added_tv: 'Recently Added',
      favorites: 'Favorites',
      trending: 'Popular & Trending',
    };
    payload.bannerText = SOURCE_BANNERS[state.source] || 'Marquee';
    payload.screensaverElements = roomCfg.screensaverElements || ['runtime', 'rating', 'contentRating', 'overview', 'credits'];
    payload.trailerMode = roomCfg.trailerMode || 'off';
    payload.trailerDelay = roomCfg.trailerDelay || 30;
    payload.screensaverView = roomCfg.screensaverView || 'default';
    payload.showTopBanner = roomCfg.showTopBanner !== false;
    payload.showBottomBanner = roomCfg.showBottomBanner || false;
    payload.bottomBannerText = roomCfg.bottomBannerText || '';
  }

  return payload;
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'join' && msg.room) {
        ws.room = msg.room;
        addClient(msg.room, ws);
        // Send current state augmented with config
        const payload = getRoomPayload(msg.room);
        if (payload) {
          ws.send(JSON.stringify(payload));
        }
      }
      if (msg.type === 'trailer-start' && msg.room) {
        screensaver.pauseRotation(msg.room);
      }
      if (msg.type === 'trailer-end' && msg.room) {
        screensaver.resumeRotation(msg.room);
      }
    } catch (err) {
      console.error('[ws] Bad message:', err.message);
    }
  });

  ws.on('close', () => {
    removeClient(ws);
  });
});

// Export getRoomPayload for use in webhook broadcasting
module.exports = { getRoomPayload };

server.listen(PORT, () => {
  console.log(`[marquee] Server running on http://localhost:${PORT}`);
  const { getConfig } = require('./config');
  const apiKey = getConfig().global.tmdbApiKey || process.env.TMDB_API_KEY;
  console.log(`[marquee] TMDB API key: ${apiKey ? 'configured' : 'not set (mock mode)'}`);

  // Initialize screensaver with broadcast callback
  screensaver.init((slug) => {
    const payload = getRoomPayload(slug);
    if (payload) broadcastToRoom(slug, payload);
  });

  // Start screensaver rotation for all rooms — if a room is actively playing,
  // the next webhook will stop rotation. Stale nowplaying rooms need rotation too.
  const slugs = getConfiguredRoomSlugs();
  for (const slug of slugs) {
    screensaver.startRotation(slug).catch(err =>
      console.error(`[marquee] Failed to start screensaver for ${slug}:`, err.message)
    );
  }

  // Initialize ESPN polling service
  espn.init((slug) => {
    const payload = getRoomPayload(slug);
    if (payload) broadcastToRoom(slug, payload);
  });

  // Resume ESPN polling for rooms that were showing a live game before restart
  for (const slug of slugs) {
    const state = getState(slug);
    if (state?.mode?.startsWith('sports-') && state?.gameId) {
      espn.startGamePolling(slug, state.gameId);
    }
  }

  // Initialize Home Assistant polling service
  ha.init((slug) => {
    const payload = getRoomPayload(slug);
    if (payload) broadcastToRoom(slug, payload);
  });

  // Start HA polling for rooms with haEntity configured
  for (const slug of slugs) {
    const roomCfg = getRoomConfig(slug);
    if (roomCfg?.haEntity) {
      ha.startPolling(slug);
    }
  }

  // Initialize Plex polling service
  plexPoller.init((slug) => {
    const payload = getRoomPayload(slug);
    if (payload) broadcastToRoom(slug, payload);
  });

  // Start Plex polling for rooms with plexPlayerName configured
  for (const slug of slugs) {
    const roomCfg = getRoomConfig(slug);
    if (roomCfg?.plexPlayerName) {
      plexPoller.startPolling(slug);
    }
  }
});
