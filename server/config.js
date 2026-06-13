const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MASK = '••••••••';

const SENSITIVE_FIELDS = ['tmdbApiKey', 'plexToken', 'haToken'];

const DEFAULT_CONFIG = {
  global: {
    tmdbApiKey: '',
    plexIp: '',
    plexPort: 32400,
    plexToken: '',
    haUrl: '',
    haToken: '',
    sportBackdrops: {},
  },
  rooms: {
    theater: {
      name: 'Theater',
      theme: 'default',
      bannerText: 'Now Playing',
      plexPlayerName: '',
      haEntity: '',
      trailerMode: 'off',
      trailerDelay: 30,
      screensaverInterval: 15,
      screensaverSources: ['recently_added', 'coming_soon'],
      screensaverElements: ['runtime', 'rating', 'contentRating', 'overview', 'credits'],
    },
  },
};

const DEFAULT_ROOM = {
  name: '',
  theme: 'default',
  bannerText: 'Now Playing',
  plexPlayerName: '',
  haEntity: '',
  trailerMode: 'off',
  trailerDelay: 30,
  screensaverInterval: 15,
  screensaverSources: ['recently_added', 'coming_soon'],
  screensaverElements: ['runtime', 'rating', 'contentRating', 'overview', 'credits'],
  screensaverView: 'default',
  showTopBanner: true,
  showBottomBanner: false,
  bottomBannerText: '',
};

let config = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      config = JSON.parse(raw);
      // Ensure structure
      if (!config.global) config.global = { ...DEFAULT_CONFIG.global };
      if (!config.rooms) config.rooms = {};
      // Fill missing global fields
      for (const [k, v] of Object.entries(DEFAULT_CONFIG.global)) {
        if (config.global[k] === undefined) config.global[k] = v;
      }
      // Fresh per-config object so endpoint writes never alias DEFAULT_CONFIG
      config.global.sportBackdrops = { ...(config.global.sportBackdrops || {}) };
      // Migrate plexUrl → plexIp + plexPort
      if (config.global.plexUrl) {
        try {
          const u = new URL(config.global.plexUrl);
          config.global.plexIp = u.hostname;
          config.global.plexPort = parseInt(u.port) || 32400;
        } catch {
          // Best-effort: treat entire value as IP
          config.global.plexIp = config.global.plexUrl.replace(/^https?:\/\//, '').replace(/:\d+.*$/, '');
          config.global.plexPort = 32400;
        }
        delete config.global.plexUrl;
        saveConfig();
      }
      return;
    }
  } catch (err) {
    console.error('[config] Failed to load config.json:', err.message);
  }

  // First boot — build config from env vars + state.json rooms
  config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.global.tmdbApiKey = process.env.TMDB_API_KEY || '';

  // Try to pick up rooms from existing state.json
  const stateFile = path.join(DATA_DIR, 'state.json');
  try {
    if (fs.existsSync(stateFile)) {
      const stateData = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      const slugs = Object.keys(stateData);
      if (slugs.length > 0) {
        config.rooms = {};
        for (const slug of slugs) {
          config.rooms[slug] = {
            ...DEFAULT_ROOM,
            name: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          };
        }
      }
    }
  } catch (err) {
    // ignore
  }

  // Parse env PLAYER_ROOM_MAP into room configs
  try {
    const envMap = JSON.parse(process.env.PLAYER_ROOM_MAP || '{}');
    for (const [player, slug] of Object.entries(envMap)) {
      if (config.rooms[slug]) {
        config.rooms[slug].plexPlayerName = player;
      }
    }
  } catch (err) {
    // ignore
  }

  saveConfig();
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[config] Failed to save config.json:', err.message);
  }
}

function getConfig() {
  if (!config) loadConfig();
  return config;
}

function getMaskedConfig() {
  const c = JSON.parse(JSON.stringify(getConfig()));
  for (const field of SENSITIVE_FIELDS) {
    if (c.global[field]) c.global[field] = MASK;
  }
  return c;
}

function updateConfig(incoming) {
  const current = getConfig();

  // Merge global — preserve tokens if masked
  if (incoming.global) {
    for (const [k, v] of Object.entries(incoming.global)) {
      if (SENSITIVE_FIELDS.includes(k) && v === MASK) continue;
      current.global[k] = v;
    }
  }

  // Rooms are updated via their own endpoints, but allow bulk set
  if (incoming.rooms) {
    for (const [slug, roomData] of Object.entries(incoming.rooms)) {
      current.rooms[slug] = { ...DEFAULT_ROOM, ...current.rooms[slug], ...roomData };
    }
  }

  saveConfig();
  return current;
}

function getRoomConfig(slug) {
  return getConfig().rooms[slug] || null;
}

function setRoomConfig(slug, data) {
  const c = getConfig();
  c.rooms[slug] = { ...DEFAULT_ROOM, ...c.rooms[slug], ...data };
  saveConfig();
  return c.rooms[slug];
}

function deleteRoomConfig(slug) {
  const c = getConfig();
  delete c.rooms[slug];
  saveConfig();
}

function getConfiguredRoomSlugs() {
  return Object.keys(getConfig().rooms);
}

function getPlexBaseUrl() {
  const c = getConfig();
  if (!c.global.plexIp) return '';
  return `http://${c.global.plexIp}:${c.global.plexPort || 32400}`;
}

function getPlayerRoomMap() {
  const c = getConfig();
  const map = {};
  for (const [slug, room] of Object.entries(c.rooms)) {
    if (room.plexPlayerName) {
      map[room.plexPlayerName] = slug;
    }
  }
  return map;
}

loadConfig();

module.exports = {
  getConfig,
  getMaskedConfig,
  updateConfig,
  getRoomConfig,
  setRoomConfig,
  deleteRoomConfig,
  getConfiguredRoomSlugs,
  getPlayerRoomMap,
  getPlexBaseUrl,
  MASK,
  DATA_DIR,
};
