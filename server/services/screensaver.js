const { getRecentlyAddedMovies, getRecentlyAddedTV } = require('./plex');
const { getUpcomingMovies, getTrendingMovies } = require('./tmdb');
const { getRoomConfig, getConfig } = require('../config');
const { getState, setState } = require('../state');

// In-memory state per room
const roomPools = {};

// Broadcast callback — set via init() to avoid circular dependency
let broadcastFn = null;

const POOL_STALE_MS = 30 * 60 * 1000; // 30 minutes

function init(callback) {
  broadcastFn = callback;
  console.log('[screensaver] Initialized with broadcast callback');
}

// Fisher-Yates shuffle
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function buildPool(slug) {
  const roomCfg = getRoomConfig(slug);
  const sources = roomCfg?.screensaverSources || ['recently_added', 'coming_soon'];
  const globalCfg = getConfig().global;

  console.log(`[screensaver] Building pool for "${slug}" with sources: ${sources.join(', ')}`);

  const fetchers = [];
  if (sources.includes('recently_added')) {
    fetchers.push(getRecentlyAddedMovies(globalCfg.plexUrl, globalCfg.plexToken));
  }
  if (sources.includes('recently_added_tv')) {
    fetchers.push(getRecentlyAddedTV(globalCfg.plexUrl, globalCfg.plexToken));
  }
  if (sources.includes('coming_soon')) {
    fetchers.push(getUpcomingMovies());
  }
  if (sources.includes('trending')) {
    fetchers.push(getTrendingMovies());
  }

  const results = await Promise.allSettled(fetchers);
  let items = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      items = items.concat(r.value);
    }
  }

  // Shuffle merged pool
  shuffle(items);

  // Fallback if pool is empty
  if (items.length === 0) {
    items.push({
      source: 'fallback',
      sourceLabel: 'Welcome',
      title: 'Marquee',
      subtitle: null,
      year: null,
      tagline: 'Your theater display system',
      overview: null,
      genres: [],
      contentRating: null,
      contentRatingDesc: null,
      posterUrl: null,
      backdropUrl: null,
      rating: null,
      runtime: null,
      director: null,
      cast: [],
      releaseDate: null,
    });
  }

  if (!roomPools[slug]) {
    roomPools[slug] = { items: [], currentIndex: 0, timer: null, lastRefresh: 0 };
  }
  roomPools[slug].items = items;
  roomPools[slug].currentIndex = 0;
  roomPools[slug].lastRefresh = Date.now();

  const withTrailers = items.filter(i => i.trailerKey).length;
  console.log(`[screensaver] Pool for "${slug}": ${items.length} items, ${withTrailers} have trailers`);
}

function advanceSlide(slug) {
  const pool = roomPools[slug];
  if (!pool || pool.items.length === 0) return;

  // Advance index (wrap around)
  pool.currentIndex = (pool.currentIndex + 1) % pool.items.length;

  // Check if pool is stale and rebuild in background
  if (Date.now() - pool.lastRefresh > POOL_STALE_MS) {
    buildPool(slug).catch(err => console.error('[screensaver] Background rebuild failed:', err.message));
  }

  const slide = pool.items[pool.currentIndex];

  // Update room state with slide data
  setState(slug, {
    mode: 'screensaver',
    title: slide.title,
    subtitle: slide.subtitle || null,
    year: slide.year,
    tagline: slide.tagline,
    overview: slide.overview || null,
    genres: slide.genres || [],
    contentRating: slide.contentRating || null,
    contentRatingDesc: slide.contentRatingDesc || null,
    posterUrl: slide.posterUrl,
    backdropUrl: slide.backdropUrl,
    rating: slide.rating || null,
    runtime: slide.runtime || null,
    director: slide.director || null,
    cast: slide.cast || [],
    sourceLabel: slide.sourceLabel,
    source: slide.source,
    releaseDate: slide.releaseDate || null,
    // Null out nowplaying-specific fields
    audioCodec: null,
    audioLabel: null,
    audioClass: '',
    resolution: null,
    resClass: '',
    aspectRatio: null,
    trailerKey: slide.trailerKey || null,
  });

  // Broadcast via callback
  if (broadcastFn) broadcastFn(slug);
}

async function startRotation(slug) {
  stopRotation(slug);

  const roomCfg = getRoomConfig(slug);
  const interval = (roomCfg?.screensaverInterval || 15) * 1000;

  // Build pool if missing or stale
  if (!roomPools[slug] || Date.now() - roomPools[slug].lastRefresh > POOL_STALE_MS) {
    await buildPool(slug);
  }

  const pool = roomPools[slug];
  if (!pool || pool.items.length === 0) return;

  // Broadcast first slide immediately
  const slide = pool.items[pool.currentIndex];
  setState(slug, {
    mode: 'screensaver',
    title: slide.title,
    subtitle: slide.subtitle || null,
    year: slide.year,
    tagline: slide.tagline,
    overview: slide.overview || null,
    genres: slide.genres || [],
    contentRating: slide.contentRating || null,
    contentRatingDesc: slide.contentRatingDesc || null,
    posterUrl: slide.posterUrl,
    backdropUrl: slide.backdropUrl,
    rating: slide.rating || null,
    runtime: slide.runtime || null,
    director: slide.director || null,
    cast: slide.cast || [],
    sourceLabel: slide.sourceLabel,
    source: slide.source,
    releaseDate: slide.releaseDate || null,
    audioCodec: null,
    audioLabel: null,
    audioClass: '',
    resolution: null,
    resClass: '',
    aspectRatio: null,
    trailerKey: slide.trailerKey || null,
  });
  if (broadcastFn) broadcastFn(slug);

  // Start interval timer
  pool.timer = setInterval(() => advanceSlide(slug), interval);
  console.log(`[screensaver] Rotation started for "${slug}" (${interval / 1000}s interval, ${pool.items.length} slides)`);
}

function stopRotation(slug) {
  const pool = roomPools[slug];
  if (pool?.timer) {
    clearInterval(pool.timer);
    pool.timer = null;
    console.log(`[screensaver] Rotation stopped for "${slug}"`);
  }
}

function getSlideInfo(slug) {
  const pool = roomPools[slug];
  if (!pool) return { currentIndex: 0, totalItems: 0 };
  return { currentIndex: pool.currentIndex, totalItems: pool.items.length };
}

async function rebuildPool(slug) {
  stopRotation(slug);
  await buildPool(slug);
  // Always start rotation after rebuild — if the room is actively playing,
  // the next webhook will stop it
  await startRotation(slug);
}

function pauseRotation(slug) {
  const pool = roomPools[slug];
  if (pool?.timer) {
    clearInterval(pool.timer);
    pool.timer = null;
    pool.paused = true;
    // Safety timeout — auto-resume after 3 minutes if client never sends trailer-end
    pool.pauseTimeout = setTimeout(() => {
      console.log(`[screensaver] Safety timeout — resuming rotation for "${slug}"`);
      resumeRotation(slug);
    }, 180000);
    console.log(`[screensaver] Rotation paused for "${slug}" (trailer playing)`);
  }
}

function resumeRotation(slug) {
  const pool = roomPools[slug];
  if (!pool?.paused) return;
  pool.paused = false;
  if (pool.pauseTimeout) { clearTimeout(pool.pauseTimeout); pool.pauseTimeout = null; }
  const roomCfg = getRoomConfig(slug);
  const interval = (roomCfg?.screensaverInterval || 15) * 1000;
  pool.timer = setInterval(() => advanceSlide(slug), interval);
  console.log(`[screensaver] Rotation resumed for "${slug}"`);
}

module.exports = { init, startRotation, stopRotation, getSlideInfo, rebuildPool, pauseRotation, resumeRotation };
