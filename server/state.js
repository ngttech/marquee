const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_ROOM_STATE = {
  mode: 'screensaver',
  title: null,
  year: null,
  tagline: null,
  contentRating: null,
  contentRatingDesc: null,
  audioCodec: null,
  audioLabel: null,
  audioClass: '',
  resolution: null,
  resClass: '',
  aspectRatio: null,
  overview: null,
  runtime: null,
  director: null,
  cast: [],
  rating: null,
  posterUrl: null,
  backdropUrl: null,
  trailerKey: null,
  genres: [],
  showTitle: null,
  episodeTitle: null,
  seasonNum: null,
  episodeNum: null,
  network: null,
  duration: null,
  viewOffset: 0,
  progress: 0,
};

// In-memory state
let state = {};

// WebSocket clients per room: { roomSlug: Set<ws> }
const clients = {};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      state = JSON.parse(raw);
      return;
    }
  } catch (err) {
    console.error('[state] Failed to load state.json, using empty state:', err.message);
  }
  state = {};
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[state] Failed to save state.json:', err.message);
  }
}

function initRooms(slugs) {
  for (const slug of slugs) {
    if (!state[slug]) {
      state[slug] = { ...DEFAULT_ROOM_STATE };
    }
  }
  // Remove rooms from state that aren't in config
  for (const slug of Object.keys(state)) {
    if (!slugs.includes(slug)) {
      delete state[slug];
      delete clients[slug];
    }
  }
  saveState();
}

function getState(room) {
  return state[room] || null;
}

function setState(room, obj) {
  state[room] = obj;
  saveState();
}

function deleteState(slug) {
  delete state[slug];
  delete clients[slug];
  saveState();
}

function getRooms() {
  return Object.keys(state);
}

function addClient(room, ws) {
  if (!clients[room]) clients[room] = new Set();
  clients[room].add(ws);
}

function removeClient(ws) {
  for (const room of Object.keys(clients)) {
    clients[room].delete(ws);
  }
}

function broadcastToRoom(room, data) {
  const set = clients[room];
  if (!set) return;
  const msg = JSON.stringify(data);
  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

// Load on startup
loadState();

function getClientCount(room) {
  return clients[room]?.size || 0;
}

function getTotalClientCount() {
  let total = 0;
  for (const room of Object.keys(clients)) {
    total += clients[room].size;
  }
  return total;
}

module.exports = { getState, setState, deleteState, getRooms, initRooms, addClient, removeClient, broadcastToRoom, getClientCount, getTotalClientCount };
