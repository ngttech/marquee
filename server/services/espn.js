const { getClientCount } = require('../state');
const { getRoomConfig } = require('../config');

// Broadcast callback — set via init() to avoid circular dependency
let broadcastFn = null;

// Per-room polling state
const roomPollers = {};

// In-memory cache for ESPN responses (15 second TTL)
let gamesCache = null;
let gamesCacheTime = 0;
const CACHE_TTL = 15000;

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const SPORT_ENDPOINTS = {
  nfl: '/football/nfl/scoreboard',
  nba: '/basketball/nba/scoreboard',
  mlb: '/baseball/mlb/scoreboard',
  'soccer-ucl': '/soccer/uefa.champions/scoreboard',
  'soccer-mls': '/soccer/usa.1/scoreboard',
  'soccer-epl': '/soccer/eng.1/scoreboard',
  ufc: '/mma/ufc/scoreboard',
  nhl: '/hockey/nhl/scoreboard',
};

// Map sport keys to display mode names
const SPORT_MODE_MAP = {
  nfl: 'sports-nfl',
  nba: 'sports-nba',
  mlb: 'sports-mlb',
  'soccer-ucl': 'sports-soccer',
  'soccer-mls': 'sports-soccer',
  'soccer-epl': 'sports-soccer',
  ufc: 'sports-ufc',
  nhl: 'sports-nhl',
};

function init(callback) {
  broadcastFn = callback;
  console.log('[espn] Initialized with broadcast callback');
}

async function fetchScoreboard(sportKey) {
  const endpoint = SPORT_ENDPOINTS[sportKey];
  if (!endpoint) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${ESPN_BASE}${endpoint}`, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.status === 429) {
      console.warn(`[espn] Rate limited on ${sportKey}, backing off`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[espn] HTTP ${res.status} for ${sportKey}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[espn] Timeout fetching ${sportKey}`);
    } else {
      console.warn(`[espn] Error fetching ${sportKey}:`, err.message);
    }
    return null;
  }
}

function parseStatus(statusObj) {
  if (!statusObj) return { status: 'pre', isLive: false };
  const type = statusObj.type?.name || '';
  if (type === 'STATUS_IN_PROGRESS' || type === 'STATUS_HALFTIME' || type === 'STATUS_END_PERIOD') {
    return { status: 'in', isLive: true };
  }
  if (type === 'STATUS_FINAL' || type === 'STATUS_FINAL_OT') {
    return { status: 'post', isLive: false };
  }
  return { status: 'pre', isLive: false };
}

function normalizeGame(sportKey, event) {
  if (!event || !event.competitions?.[0]) return null;

  const comp = event.competitions[0];
  const competitors = comp.competitors || [];
  const homeComp = competitors.find(c => c.homeAway === 'home') || competitors[0];
  const awayComp = competitors.find(c => c.homeAway === 'away') || competitors[1];

  if (!homeComp || !awayComp) return null;

  const statusObj = comp.status || event.status;
  const { status, isLive } = parseStatus(statusObj);
  const clock = statusObj?.displayClock || '';
  const period = statusObj?.period || 0;
  const periodText = statusObj?.type?.shortDetail || '';

  const sportMode = SPORT_MODE_MAP[sportKey] || 'sports-soccer';
  const baseSport = sportMode.replace('sports-', '');

  const buildTeam = (c) => ({
    name: c.team?.displayName || c.team?.name || 'TBD',
    abbreviation: c.team?.abbreviation || '',
    logo: c.team?.logo || '',
    record: c.records?.[0]?.summary || '',
    score: parseInt(c.score) || 0,
    color: c.team?.color ? `#${c.team.color}` : null,
  });

  const game = {
    sport: baseSport,
    sportKey,
    gameId: event.id,
    status,
    isLive,
    competition: event.name || `${homeComp.team?.displayName} vs ${awayComp.team?.displayName}`,
    venue: comp.venue?.fullName || '',
    venueCity: comp.venue?.address?.city || '',
    clock,
    period,
    periodText,
    homeTeam: buildTeam(homeComp),
    awayTeam: buildTeam(awayComp),
  };

  // Sport-specific enrichment
  if (baseSport === 'soccer') {
    game.league = sportKey === 'soccer-ucl' ? 'UEFA Champions League'
      : sportKey === 'soccer-epl' ? 'English Premier League'
      : 'MLS';
    // Goals from scoring plays
    game.goals = (comp.details || [])
      .filter(d => d.type?.text === 'Goal' || d.scoringPlay)
      .map(d => ({
        player: d.athletesInvolved?.[0]?.displayName || 'Unknown',
        minute: d.clock?.displayValue || '',
        team: d.team?.displayName || '',
      }));
    // Stats
    const stats = {};
    for (const s of (homeComp.statistics || [])) { stats[`home_${s.name}`] = s.displayValue; }
    for (const s of (awayComp.statistics || [])) { stats[`away_${s.name}`] = s.displayValue; }
    game.possession = { home: stats.home_possessionPct || '', away: stats.away_possessionPct || '' };
    game.shots = { home: stats.home_shotsTotal || '0', away: stats.away_shotsTotal || '0' };
    game.shotsOnTarget = { home: stats.home_shotsOnTarget || '0', away: stats.away_shotsOnTarget || '0' };
  }

  if (baseSport === 'nfl') {
    const situation = comp.situation || {};
    game.down = situation.shortDownDistanceText || '';
    game.possession_team = situation.possession || '';
    game.yardLine = situation.possessionText || '';
    // Quarter scores from linescores
    game.quarterScores = {
      home: (homeComp.linescores || []).map(l => parseInt(l.value) || 0),
      away: (awayComp.linescores || []).map(l => parseInt(l.value) || 0),
    };
  }

  if (baseSport === 'nba') {
    game.lastPlay = comp.situation?.lastPlay?.text || '';
    // Team stats
    const hStats = {};
    const aStats = {};
    for (const s of (homeComp.statistics || [])) { hStats[s.name] = s.displayValue; }
    for (const s of (awayComp.statistics || [])) { aStats[s.name] = s.displayValue; }
    game.teamStats = { home: hStats, away: aStats };
  }

  if (baseSport === 'ufc') {
    // UFC fighters are competitors
    game.weightClass = comp.type?.text || '';
    game.fighters = {
      red: {
        name: homeComp.athlete?.displayName || homeComp.team?.displayName || 'TBD',
        record: homeComp.records?.[0]?.summary || '',
        flag: homeComp.athlete?.flag?.href || '',
        country: homeComp.athlete?.nationality || '',
      },
      blue: {
        name: awayComp.athlete?.displayName || awayComp.team?.displayName || 'TBD',
        record: awayComp.records?.[0]?.summary || '',
        flag: awayComp.athlete?.flag?.href || '',
        country: awayComp.athlete?.nationality || '',
      },
    };
    game.round = period;
  }

  if (baseSport === 'mlb') {
    const situation = comp.situation || {};
    game.inning = period;
    game.isTop = statusObj?.type?.shortDetail?.includes('Top') || false;
    game.bases = {
      first: situation.onFirst || false,
      second: situation.onSecond || false,
      third: situation.onThird || false,
    };
    game.count = {
      balls: situation.balls || 0,
      strikes: situation.strikes || 0,
      outs: situation.outs || 0,
    };
  }

  if (baseSport === 'nhl') {
    game.nhlPeriod = period <= 3 ? `${period}${period === 1 ? 'st' : period === 2 ? 'nd' : 'rd'}` : 'OT';
    const situation = comp.situation || {};
    game.powerPlay = situation.shortDetail || '';
    game.lastPlay = comp.situation?.lastPlay?.text || '';
  }

  return game;
}

async function fetchAllLiveGames() {
  // Return cache if fresh
  if (gamesCache && Date.now() - gamesCacheTime < CACHE_TTL) {
    return gamesCache;
  }

  const keys = Object.keys(SPORT_ENDPOINTS);
  const results = await Promise.allSettled(keys.map(k => fetchScoreboard(k)));

  let games = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value?.events) continue;
    for (const event of r.value.events) {
      const game = normalizeGame(keys[i], event);
      if (game) games.push(game);
    }
  }

  gamesCache = games;
  gamesCacheTime = Date.now();
  return games;
}

function getTrackedGameForRoom(slug) {
  const roomCfg = getRoomConfig(slug);
  if (!roomCfg?.trackedTeams?.length) return null;
  if (!gamesCache) return null;

  const tracked = roomCfg.trackedTeams;

  // Find a live game matching tracked teams first, then pre-game, then post-game
  const priority = { in: 0, pre: 1, post: 2 };
  const matches = gamesCache.filter(g => {
    const names = [
      g.homeTeam.name, g.homeTeam.abbreviation,
      g.awayTeam.name, g.awayTeam.abbreviation,
    ].map(n => n.toLowerCase());
    return tracked.some(t => names.includes(t.toLowerCase()));
  });

  matches.sort((a, b) => (priority[a.status] || 9) - (priority[b.status] || 9));
  return matches[0] || null;
}

function startPolling(slug) {
  stopPolling(slug);

  const roomCfg = getRoomConfig(slug);
  if (!roomCfg?.autoSwitchSports || !roomCfg?.trackedTeams?.length) return;

  const pollInterval = 30000; // 30 seconds default

  async function poll() {
    try {
      if (getClientCount(slug) === 0) return;

      await fetchAllLiveGames();
      const game = getTrackedGameForRoom(slug);

      if (game && (game.status === 'in' || game.status === 'pre')) {
        const { getState, setState } = require('../state');
        const current = getState(slug);
        const mode = `sports-${game.sport}`;

        // Set sports state
        setState(slug, {
          ...current,
          mode,
          ...game,
        });

        // Stop screensaver if running
        try {
          const screensaver = require('./screensaver');
          screensaver.stopRotation(slug);
        } catch (e) { /* ignore */ }

        if (broadcastFn) broadcastFn(slug);

        // Speed up polling when game is live
        if (game.isLive && roomPollers[slug]?.intervalMs !== 15000) {
          roomPollers[slug].intervalMs = 15000;
          clearInterval(roomPollers[slug].timer);
          roomPollers[slug].timer = setInterval(poll, 15000);
        }
      } else if (!game) {
        // No tracked game active — check if room is in sports mode and revert
        const { getState, setState } = require('../state');
        const current = getState(slug);
        if (current?.mode?.startsWith('sports-')) {
          setState(slug, { ...current, mode: 'screensaver' });
          try {
            const screensaver = require('./screensaver');
            screensaver.startRotation(slug).catch(() => {});
          } catch (e) { /* ignore */ }
          if (broadcastFn) broadcastFn(slug);
        }
      }
    } catch (err) {
      console.warn(`[espn] Poll error for ${slug}:`, err.message);
    }
  }

  // Initial poll
  poll();

  // Start interval
  const timer = setInterval(poll, pollInterval);
  roomPollers[slug] = { timer, intervalMs: pollInterval };
  console.log(`[espn] Polling started for "${slug}" (${pollInterval / 1000}s interval)`);
}

function stopPolling(slug) {
  if (roomPollers[slug]) {
    clearInterval(roomPollers[slug].timer);
    delete roomPollers[slug];
    console.log(`[espn] Polling stopped for "${slug}"`);
  }
}

function pushGameToRoom(slug, gameData) {
  const { getState, setState } = require('../state');
  const current = getState(slug) || {};
  const mode = `sports-${gameData.sport}`;

  setState(slug, {
    ...current,
    mode,
    ...gameData,
  });

  // Stop screensaver
  try {
    const screensaver = require('./screensaver');
    screensaver.stopRotation(slug);
  } catch (e) { /* ignore */ }

  if (broadcastFn) broadcastFn(slug);
}

module.exports = { init, fetchAllLiveGames, pushGameToRoom, startPolling, stopPolling, getTrackedGameForRoom };
