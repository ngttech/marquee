const { getClientCount } = require('../state');
const { getRoomConfig } = require('../config');

// Broadcast callback — set via init() to avoid circular dependency
let broadcastFn = null;

// Per-room polling state
const roomPollers = {};

// Per-sport cache — each sport's data cached independently so a single failure doesn't wipe others
const sportCaches = {}; // { mlb: { games: [], time: 0 }, nba: { ... }, ... }
const CACHE_TTL = 15000;

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

const SPORT_ENDPOINTS = {
  nfl: '/football/nfl/scoreboard',
  nba: '/basketball/nba/scoreboard',
  mlb: '/baseball/mlb/scoreboard',
  'soccer-ucl': '/soccer/uefa.champions/scoreboard',
  'soccer-mls': '/soccer/usa.1/scoreboard',
  'soccer-epl': '/soccer/eng.1/scoreboard',
  'soccer-laliga': '/soccer/esp.1/scoreboard',
  'soccer-bundesliga': '/soccer/ger.1/scoreboard',
  'soccer-seriea': '/soccer/ita.1/scoreboard',
  'soccer-ligue1': '/soccer/fra.1/scoreboard',
  'soccer-worldcup': '/soccer/fifa.world/scoreboard',
  'soccer-cwc': '/soccer/fifa.cwc/scoreboard',
  'soccer-wcq-concacaf': '/soccer/fifa.worldq.concacaf/scoreboard',
  'soccer-friendlies': '/soccer/fifa.friendly/scoreboard',
  'soccer-libertadores': '/soccer/conmebol.libertadores/scoreboard',
  ufc: '/mma/ufc/scoreboard',
  nhl: '/hockey/nhl/scoreboard',
  'baseball-wbc': '/baseball/world-baseball-classic/scoreboard',
};

// Map sport keys to display mode names
const SPORT_MODE_MAP = {
  nfl: 'sports-nfl',
  nba: 'sports-nba',
  mlb: 'sports-mlb',
  'soccer-ucl': 'sports-soccer',
  'soccer-mls': 'sports-soccer',
  'soccer-epl': 'sports-soccer',
  'soccer-laliga': 'sports-soccer',
  'soccer-bundesliga': 'sports-soccer',
  'soccer-seriea': 'sports-soccer',
  'soccer-ligue1': 'sports-soccer',
  'soccer-worldcup': 'sports-soccer',
  'soccer-cwc': 'sports-soccer',
  'soccer-wcq-concacaf': 'sports-soccer',
  'soccer-friendlies': 'sports-soccer',
  'soccer-libertadores': 'sports-soccer',
  ufc: 'sports-ufc',
  nhl: 'sports-nhl',
  'baseball-wbc': 'sports-mlb',
};

function init(callback) {
  broadcastFn = callback;
  console.log('[espn] Initialized with broadcast callback');
}

async function fetchScoreboard(sportKey, query) {
  const endpoint = SPORT_ENDPOINTS[sportKey];
  if (!endpoint) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const qs = query ? `?${query}` : '';
    const res = await fetch(`${ESPN_BASE}${endpoint}${qs}`, { signal: controller.signal });
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
  if (type === 'STATUS_FINAL' || type === 'STATUS_FINAL_OT' || type === 'STATUS_FULL_TIME') {
    return { status: 'post', isLive: false };
  }
  // Fallback: use ESPN's own state classification
  const state = statusObj.type?.state;
  if (state === 'post') return { status: 'post', isLive: false };
  if (state === 'in') return { status: 'in', isLive: true };
  return { status: 'pre', isLive: false };
}

// ── Shared extractors ──
function extractLeaders(comp) {
  const leaders = [];
  for (const leader of (comp.leaders || [])) {
    const top = leader.leaders?.[0];
    if (top) {
      leaders.push({
        category: leader.name || '',
        displayName: leader.displayName || '',
        athlete: {
          name: top.athlete?.displayName || '',
          shortName: top.athlete?.shortName || '',
          headshot: top.athlete?.headshot?.href || top.athlete?.headshot || '',
          jersey: top.athlete?.jersey || '',
          team: top.athlete?.team?.abbreviation || '',
        },
        displayValue: top.displayValue || '',
      });
    }
  }
  return leaders;
}

function extractOdds(comp) {
  const odds = comp.odds?.[0];
  if (!odds) return undefined;
  return { provider: odds.provider?.name || '', overUnder: odds.overUnder || '', spread: odds.spread || '', details: odds.details || '' };
}

function extractTickets(comp) {
  const t = comp.tickets?.[0];
  if (!t) return undefined;
  return { summary: t.summary || '', count: t.numberAvailable || 0 };
}

function extractBroadcast(comp) {
  return comp.broadcasts?.[0]?.names?.[0] || comp.geoBroadcasts?.[0]?.media?.shortName || '';
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
    id: c.team?.id || '',
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
    date: event.date || '',
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
    const SOCCER_LEAGUE_NAMES = {
      'soccer-ucl': 'UEFA Champions League',
      'soccer-epl': 'English Premier League',
      'soccer-mls': 'MLS',
      'soccer-laliga': 'La Liga',
      'soccer-bundesliga': 'Bundesliga',
      'soccer-seriea': 'Serie A',
      'soccer-ligue1': 'Ligue 1',
      'soccer-worldcup': 'FIFA World Cup',
      'soccer-cwc': 'FIFA Club World Cup',
      'soccer-wcq-concacaf': 'WCQ CONCACAF',
      'soccer-friendlies': 'Int\'l Friendlies',
      'soccer-libertadores': 'Copa Libertadores',
    };
    game.league = SOCCER_LEAGUE_NAMES[sportKey] || 'Soccer';
    // World Cup round slug ('group-stage', 'round-of-16', 'final', ...) — drives
    // group-table vs knockout enrichment downstream. See WC_ROUND_LABELS.
    if (sportKey === 'soccer-worldcup') game.roundSlug = event.season?.slug || '';
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
    game.fouls = { home: stats.home_foulsCommitted || '', away: stats.away_foulsCommitted || '' };
    game.corners = { home: stats.home_wonCorners || '', away: stats.away_wonCorners || '' };

    // Cards (yellow/red)
    game.cards = (comp.details || [])
      .filter(d => d.yellowCard || d.redCard || (d.type?.text && (d.type.text.includes('Yellow') || d.type.text.includes('Red'))))
      .map(d => ({
        player: d.athletesInvolved?.[0]?.displayName || 'Unknown',
        minute: d.clock?.displayValue || '',
        team: d.team?.displayName || '',
        type: d.redCard || d.type?.text?.includes('Red') ? 'red' : 'yellow',
      }));

    // Form (recent results)
    game.homeForm = homeComp.form || '';
    game.awayForm = awayComp.form || '';

    // Attendance
    if (comp.attendance) game.attendance = comp.attendance;

    game.venueCity = comp.venue?.address?.city || '';
    game.venueState = comp.venue?.address?.state || comp.venue?.address?.country || '';
    const odds = extractOdds(comp);
    if (odds) game.odds = odds;
    const tickets = extractTickets(comp);
    if (tickets) game.tickets = tickets;
    game.broadcast = extractBroadcast(comp);
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

    // Leaders (passing, rushing, receiving)
    const leaders = extractLeaders(comp);
    if (leaders.length) game.leaders = leaders;

    game.venueCity = comp.venue?.address?.city || '';
    game.venueState = comp.venue?.address?.state || '';
    const tickets = extractTickets(comp);
    if (tickets) game.tickets = tickets;
    game.broadcast = extractBroadcast(comp);
  }

  if (baseSport === 'nba') {
    game.lastPlay = comp.situation?.lastPlay?.text || '';
    // Team stats
    const hStats = {};
    const aStats = {};
    for (const s of (homeComp.statistics || [])) { hStats[s.name] = s.displayValue; }
    for (const s of (awayComp.statistics || [])) { aStats[s.name] = s.displayValue; }
    game.teamStats = { home: hStats, away: aStats };

    // Quarter scores from linescores (handles OT)
    game.quarterScores = {
      home: (homeComp.linescores || []).map(l => parseInt(l.value) || 0),
      away: (awayComp.linescores || []).map(l => parseInt(l.value) || 0),
    };

    // Leaders (points, rebounds, assists)
    const leaders = extractLeaders(comp);
    if (leaders.length) game.leaders = leaders;

    game.venueCity = comp.venue?.address?.city || '';
    game.venueState = comp.venue?.address?.state || '';
    const odds = extractOdds(comp);
    if (odds) game.odds = odds;
    const tickets = extractTickets(comp);
    if (tickets) game.tickets = tickets;
    game.broadcast = extractBroadcast(comp);
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

    game.venueCity = comp.venue?.address?.city || '';
    game.venueState = comp.venue?.address?.state || '';
    game.broadcast = extractBroadcast(comp);
  }

  if (baseSport === 'mlb') {
    game.league = sportKey === 'baseball-wbc' ? 'World Baseball Classic' : 'MLB';
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

    // Inning-by-inning linescore
    game.inningScores = {
      home: (homeComp.linescores || []).map(l => parseInt(l.value) || 0),
      away: (awayComp.linescores || []).map(l => parseInt(l.value) || 0),
    };

    // Team stats (H, R, E)
    const hStats = {}, aStats = {};
    for (const s of (homeComp.statistics || [])) { hStats[s.abbreviation] = s.displayValue; }
    for (const s of (awayComp.statistics || [])) { aStats[s.abbreviation] = s.displayValue; }
    game.teamStats = { home: hStats, away: aStats };

    // Batter & Pitcher from situation
    const batter = situation.batter || {};
    const pitcher = situation.pitcher || {};
    const bAthl = batter.athlete || {};
    const pAthl = pitcher.athlete || {};
    game.batter = {
      name: bAthl.fullName || bAthl.displayName || '',
      shortName: bAthl.shortName || '',
      summary: batter.summary || '',
      headshot: bAthl.headshot || '',
      jersey: bAthl.jersey || '',
      position: typeof bAthl.position === 'object' ? bAthl.position.abbreviation : (bAthl.position || ''),
    };
    game.pitcher = {
      name: pAthl.fullName || pAthl.displayName || '',
      shortName: pAthl.shortName || '',
      summary: pitcher.summary || '',
      headshot: pAthl.headshot || '',
      jersey: pAthl.jersey || '',
      position: typeof pAthl.position === 'object' ? pAthl.position.abbreviation : (pAthl.position || ''),
    };

    // Venue state
    game.venueState = comp.venue?.address?.state || '';

    // Outs text (pre-formatted)
    game.outsText = situation.outsText || '';

    // Weather
    const weather = comp.weather || {};
    if (weather.temperature) {
      game.weather = {
        temperature: weather.temperature,
        displayValue: weather.displayValue || '',
        conditionId: weather.conditionId || '',
      };
    }

    // Odds
    const odds = comp.odds?.[0];
    if (odds) {
      game.odds = {
        provider: odds.provider?.name || '',
        overUnder: odds.overUnder || '',
        spread: odds.spread || '',
        details: odds.details || '',
      };
    }

    // Tickets
    const tickets = comp.tickets?.[0];
    if (tickets) {
      game.tickets = {
        summary: tickets.summary || '',
        count: tickets.numberAvailable || 0,
      };
    }

    // Notes
    if (comp.notes?.length) {
      game.notes = comp.notes.map(n => n.headline || n.text || '');
    }

    // Highlights
    if (comp.highlights?.length) {
      game.highlights = comp.highlights;
    }
  }

  if (baseSport === 'nhl') {
    game.nhlPeriod = period <= 3 ? `${period}${period === 1 ? 'st' : period === 2 ? 'nd' : 'rd'}` : 'OT';
    const situation = comp.situation || {};
    game.powerPlay = situation.shortDetail || '';
    game.lastPlay = comp.situation?.lastPlay?.text || '';

    // Period scores from linescores
    game.periodScores = {
      home: (homeComp.linescores || []).map(l => parseInt(l.value) || 0),
      away: (awayComp.linescores || []).map(l => parseInt(l.value) || 0),
    };

    // Team stats (SOG, saves, etc.)
    const hStats = {}, aStats = {};
    for (const s of (homeComp.statistics || [])) { hStats[s.name || s.abbreviation] = s.displayValue; }
    for (const s of (awayComp.statistics || [])) { aStats[s.name || s.abbreviation] = s.displayValue; }
    game.teamStats = { home: hStats, away: aStats };

    // Leaders (goals, assists, points)
    const leaders = extractLeaders(comp);
    if (leaders.length) game.leaders = leaders;

    // Starting goalies from probables
    const probables = (comp.probables || []).filter(p => p.type === 'starter' || p.position === 'G' || p.type?.abbreviation === 'G');
    if (probables.length) {
      game.probables = probables.map(p => ({
        name: p.athlete?.displayName || '',
        shortName: p.athlete?.shortName || '',
        headshot: p.athlete?.headshot?.href || p.athlete?.headshot || '',
        jersey: p.athlete?.jersey || '',
        record: p.statistics?.[0]?.summary || p.displayValue || '',
        team: p.athlete?.team?.abbreviation || '',
      }));
    }

    game.venueState = comp.venue?.address?.state || '';
    const odds = extractOdds(comp);
    if (odds) game.odds = odds;
    const tickets = extractTickets(comp);
    if (tickets) game.tickets = tickets;
    game.broadcast = extractBroadcast(comp);
  }

  return game;
}

async function fetchAllLiveGames() {
  const now = Date.now();

  // Check if all sport caches are fresh
  const allFresh = Object.keys(SPORT_ENDPOINTS).every(k =>
    sportCaches[k] && now - sportCaches[k].time < CACHE_TTL
  );
  if (allFresh) {
    return getAllCachedGames();
  }

  // Always fetch all sports — per-sport cache with TTL prevents redundant fetches
  const keysToFetch = Object.keys(SPORT_ENDPOINTS).filter(k =>
    !sportCaches[k] || now - sportCaches[k].time >= CACHE_TTL
  );

  if (keysToFetch.length === 0) return getAllCachedGames();

  const results = await Promise.allSettled(keysToFetch.map(k => fetchScoreboard(k)));

  for (let i = 0; i < results.length; i++) {
    const sportKey = keysToFetch[i];
    const r = results[i];
    if (r.status === 'fulfilled' && r.value?.events) {
      const games = [];
      for (const event of r.value.events) {
        const game = normalizeGame(sportKey, event);
        if (game) games.push(game);
      }
      sportCaches[sportKey] = { games, time: now };
    } else {
      // On failure, keep previous cached games instead of dropping them
      if (!sportCaches[sportKey]) {
        sportCaches[sportKey] = { games: [], time: now };
      }
      console.warn(`[espn] Failed to fetch ${sportKey}, keeping ${sportCaches[sportKey].games.length} cached games`);
    }
  }

  return getAllCachedGames();
}

function getAllCachedGames() {
  let games = [];
  for (const cache of Object.values(sportCaches)) {
    games = games.concat(cache.games);
  }
  return games;
}

// ── FIFA World Cup 2026 (Jun 11 – Jul 19) ──
// The default scoreboard only returns the current matchday, so fetch the whole
// tournament via ESPN's ?dates=YYYYMMDD-YYYYMMDD range param. Split into windows
// to stay under any per-request cap; merge + dedupe by gameId.
const WORLDCUP_DATE_WINDOWS = ['20260611-20260624', '20260625-20260708', '20260709-20260719'];
const WC_CACHE_TTL = 60000; // 60s — 3 upstream calls per refresh, scores change slowly enough
let wcCache = { games: [], time: 0 };

async function fetchWorldCupGames() {
  const now = Date.now();
  if (wcCache.time && now - wcCache.time < WC_CACHE_TTL) {
    return wcCache.games;
  }

  const results = await Promise.allSettled(
    WORLDCUP_DATE_WINDOWS.map(w => fetchScoreboard('soccer-worldcup', `dates=${w}`))
  );

  const byId = new Map();
  let anySuccess = false;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.events) {
      anySuccess = true;
      for (const event of r.value.events) {
        const game = normalizeGame('soccer-worldcup', event);
        if (game) byId.set(game.gameId, game); // dedupe overlapping window edges
      }
    }
  }

  // If every window failed, keep the last good snapshot rather than wiping it
  if (!anySuccess) {
    console.warn(`[espn] World Cup fetch failed for all windows, keeping ${wcCache.games.length} cached games`);
    return wcCache.games;
  }

  const games = Array.from(byId.values())
    .sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0));
  wcCache = { games, time: now };
  return games;
}

// ── World Cup standings (group tables) ──
// Different host path than ESPN_BASE: /apis/v2/ (no /site/). ?level=3 ensures the
// full group depth is returned.
const ESPN_STANDINGS_URL =
  'https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?level=3';
const STANDINGS_CACHE_TTL = 120000; // 120s — only changes when a match ends
let standingsCache = { groups: [], time: 0 };

// Map a stats[] array (name → displayValue/value) to a flat lookup
function statMap(stats) {
  const m = {};
  for (const s of stats || []) m[s.name] = { value: s.value, display: s.displayValue };
  return m;
}

async function fetchWorldCupStandings() {
  const now = Date.now();
  if (standingsCache.time && now - standingsCache.time < STANDINGS_CACHE_TTL) {
    return standingsCache.groups;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(ESPN_STANDINGS_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const groups = (data.children || []).map(g => {
      const entries = g.standings?.entries || [];
      const teams = entries.map(e => {
        const st = statMap(e.stats);
        const num = (k) => parseInt(st[k]?.value ?? st[k]?.display ?? 0) || 0;
        return {
          id: e.team?.id || '',
          name: e.team?.displayName || e.team?.name || 'TBD',
          abbreviation: e.team?.abbreviation || '',
          logo: e.team?.logos?.[0]?.href || e.team?.logo || '',
          rank: num('rank'),
          played: num('gamesPlayed'),
          wins: num('wins'),
          draws: num('ties'),
          losses: num('losses'),
          goalsFor: num('pointsFor'),
          goalsAgainst: num('pointsAgainst'),
          goalDiff: st['pointDifferential']?.display || String(num('pointDifferential')),
          points: num('points'),
        };
      }).sort((a, b) => (a.rank || 99) - (b.rank || 99));
      const name = g.name || g.shortName || '';
      const letter = (name.match(/Group\s+([A-Z])/i) || [])[1] || name.replace(/Group\s*/i, '');
      return { letter, name: name || `Group ${letter}`, teams };
    }).filter(g => g.teams.length);

    standingsCache = { groups, time: now };
    return groups;
  } catch (err) {
    console.warn('[espn] World Cup standings fetch failed:', err.message,
      `— keeping ${standingsCache.groups.length} cached groups`);
    return standingsCache.groups;
  }
}

// Find the group whose teams include either of the two team ids (fallback: name).
function findGroupForTeams(groups, home, away) {
  const ids = [home?.id, away?.id].filter(Boolean);
  const names = [home?.name, away?.name].filter(Boolean).map(n => n.toLowerCase());
  return groups.find(g =>
    g.teams.some(t =>
      (t.id && ids.includes(t.id)) || (t.name && names.includes(t.name.toLowerCase()))
    )
  ) || null;
}

// ── World Cup knockout bracket ──
// Built from the games we already fetch; round comes from each game's roundSlug
// (event.season.slug). Group-stage games are excluded.
const WC_ROUND_LABELS = {
  'round-of-32': 'Round of 32',
  'round-of-16': 'Round of 16',
  'quarterfinals': 'Quarterfinals',
  'semifinals': 'Semifinals',
  '3rd-place-match': 'Third-Place Match',
  'third-place': 'Third-Place Match',
  'final': 'Final',
};
const WC_ROUND_ORDER = [
  'round-of-32', 'round-of-16', 'quarterfinals', 'semifinals', '3rd-place-match', 'third-place', 'final',
];

function bracketEntry(g) {
  return {
    gameId: g.gameId,
    name: g.competition,
    date: g.date,
    status: g.status,
    isLive: g.isLive,
    roundSlug: g.roundSlug,
    round: WC_ROUND_LABELS[g.roundSlug] || '',
    homeTeam: g.homeTeam,
    awayTeam: g.awayTeam,
  };
}

async function fetchWorldCupBracket() {
  const games = await fetchWorldCupGames();
  const rounds = {};
  for (const g of games) {
    if (!WC_ROUND_LABELS[g.roundSlug]) continue; // skip group stage
    (rounds[g.roundSlug] = rounds[g.roundSlug] || []).push(bracketEntry(g));
  }
  // Ordered list of populated rounds, matches sorted by date
  return WC_ROUND_ORDER
    .filter(slug => rounds[slug]?.length)
    .map(slug => ({
      slug,
      label: WC_ROUND_LABELS[slug],
      matches: rounds[slug].sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0)),
    }));
}

// ── World Cup top scorers (Golden Boot) ──
// Candidate endpoint — return [] on any failure so the UI hides the panel.
const ESPN_SCORERS_URL =
  'https://site.web.api.espn.com/apis/common/v3/sports/soccer/fifa.world/statistics/byathlete?sort=offensive.totalGoals&category=offensive';
const SCORERS_CACHE_TTL = 300000; // 5min
let scorersCache = { players: [], time: 0 };

async function fetchWorldCupScorers() {
  const now = Date.now();
  if (scorersCache.time && now - scorersCache.time < SCORERS_CACHE_TTL) {
    return scorersCache.players;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(ESPN_SCORERS_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const athletes = data.athletes || data.statistics?.athletes || [];
    const players = athletes.map(a => {
      const ath = a.athlete || a;
      // goals live in a categories/stats array — search for a goals stat
      let goals = 0;
      const cats = a.categories || ath.categories || [];
      for (const c of cats) {
        const stats = c.stats || c.totals || [];
        for (const s of stats) {
          if (/goal/i.test(s.name || s.displayName || '') && !/assist|against|conceded/i.test(s.name || s.displayName || '')) {
            goals = parseInt(s.value ?? s.displayValue ?? 0) || goals;
          }
        }
      }
      return {
        player: ath.displayName || ath.fullName || 'Unknown',
        team: ath.team?.abbreviation || ath.teamName || a.team?.abbreviation || '',
        goals,
      };
    }).filter(p => p.goals > 0)
      .sort((a, b) => b.goals - a.goals)
      .slice(0, 12)
      .map((p, i) => ({ rank: i + 1, ...p }));

    scorersCache = { players, time: now };
    return players;
  } catch (err) {
    console.warn('[espn] World Cup scorers fetch failed:', err.message);
    return scorersCache.players; // last good, or []
  }
}

// Attach group table / knockout context to a live World Cup game (mutates + returns).
async function enrichWorldCupGame(game) {
  if (!game || game.sportKey !== 'soccer-worldcup') return game;
  const isKnockout = !!WC_ROUND_LABELS[game.roundSlug];

  if (isKnockout) {
    game.round = WC_ROUND_LABELS[game.roundSlug];
  } else {
    const groups = await fetchWorldCupStandings();
    game.group = findGroupForTeams(groups, game.homeTeam, game.awayTeam);
  }

  // Next-match preview: soonest upcoming fixture featuring either team
  try {
    const all = await fetchWorldCupGames();
    const ids = [game.homeTeam?.id, game.awayTeam?.id].filter(Boolean);
    const upcoming = all
      .filter(g => g.gameId !== game.gameId && g.status === 'pre')
      .filter(g => ids.includes(g.homeTeam?.id) || ids.includes(g.awayTeam?.id))
      .sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0))[0];
    if (upcoming) {
      game.nextMatch = {
        home: upcoming.homeTeam?.name, away: upcoming.awayTeam?.name,
        date: upcoming.date, round: WC_ROUND_LABELS[upcoming.roundSlug] || '',
      };
    }
  } catch (e) { /* non-fatal */ }

  return game;
}

function startGamePolling(slug, gameId) {
  stopPolling(slug);

  async function poll() {
    try {
      const clientCount = getClientCount(slug);
      const allGames = await fetchAllLiveGames();
      const game = allGames.find(g => g.gameId === gameId);

      console.log(`[espn] Poll for "${slug}" gameId=${gameId} — ${allGames.length} games cached, match: ${game ? game.competition + ' (' + game.status + ')' : 'not found'}, clients: ${clientCount}`);

      if (!game) return; // Game not found in cache, keep trying

      if (game.status === 'post') {
        // Game ended — revert to screensaver
        console.log(`[espn] Game ${gameId} ended for "${slug}" — reverting to screensaver`);
        const { getState, setState } = require('../state');
        const current = getState(slug) || {};
        setState(slug, { ...current, mode: 'screensaver' });
        try {
          const screensaver = require('./screensaver');
          screensaver.startRotation(slug).catch(() => {});
        } catch (e) { /* ignore */ }
        if (clientCount > 0 && broadcastFn) broadcastFn(slug);
        stopPolling(slug);
        return;
      }

      // Game still active — update state with fresh data
      await enrichWorldCupGame(game);
      const { getState, setState } = require('../state');
      const current = getState(slug) || {};
      const mode = `sports-${game.sport}`;
      setState(slug, { ...current, mode, ...game });
      if (clientCount > 0 && broadcastFn) broadcastFn(slug);
    } catch (err) {
      console.warn(`[espn] Poll error for ${slug}:`, err.message);
    }
  }

  // Initial poll
  poll();

  // 15s interval for live game updates
  const timer = setInterval(poll, 15000);
  roomPollers[slug] = { timer, gameId };
  console.log(`[espn] Game polling started for "${slug}" gameId=${gameId} (15s interval)`);
}

function stopPolling(slug) {
  if (roomPollers[slug]) {
    clearInterval(roomPollers[slug].timer);
    delete roomPollers[slug];
    console.log(`[espn] Polling stopped for "${slug}"`);
  }
}

async function pushGameToRoom(slug, gameData) {
  await enrichWorldCupGame(gameData);
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

  // Start polling to keep score live and auto-revert when game ends
  if (gameData.gameId) {
    startGamePolling(slug, gameData.gameId);
  }
}

module.exports = {
  init, fetchAllLiveGames, fetchWorldCupGames, pushGameToRoom, startGamePolling, stopPolling,
  fetchWorldCupStandings, fetchWorldCupBracket, fetchWorldCupScorers,
};
