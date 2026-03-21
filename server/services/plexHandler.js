const { enrichMovie, enrichTVShow } = require('./tmdb');
const { getState, setState, broadcastToRoom } = require('../state');
const screensaver = require('./screensaver');
const espn = require('./espn');

function broadcast(room, state) {
  try {
    const { getRoomPayload } = require('../index');
    const payload = getRoomPayload(room);
    broadcastToRoom(room, payload || state);
  } catch {
    broadcastToRoom(room, state);
  }
}

async function handlePlexPlay(room, parsed) {
  // Stop screensaver rotation and ESPN polling
  screensaver.stopRotation(room);
  espn.stopPolling(room);

  let state;

  if (parsed.type === 'episode') {
    const tmdb = await enrichTVShow(parsed.showTitle, parsed.seasonNum, parsed.episodeNum);
    const progress = parsed.duration ? Math.round((parsed.viewOffset / parsed.duration) * 100) : 0;

    state = {
      mode: 'nowplaying-tv',
      title: parsed.showTitle,
      showTitle: tmdb?.showTitle || parsed.showTitle,
      episodeTitle: parsed.episodeTitle || parsed.title,
      seasonNum: parsed.seasonNum,
      episodeNum: parsed.episodeNum,
      overview: tmdb?.episodeOverview || parsed.summary || null,
      runtime: tmdb?.episodeRuntime || null,
      network: tmdb?.network || null,
      contentRating: tmdb?.contentRating || parsed.contentRating,
      contentRatingDesc: tmdb?.contentRatingDesc || null,
      audioCodec: parsed.audioCodec,
      audioLabel: parsed.audioLabel,
      audioClass: parsed.audioClass,
      resolution: parsed.resolution,
      resClass: parsed.resClass,
      aspectRatio: parsed.aspectRatio,
      rating: tmdb?.rating || null,
      posterUrl: tmdb?.posterUrl || null,
      backdropUrl: tmdb?.backdropUrl || null,
      trailerKey: tmdb?.trailerKey || null,
      genres: tmdb?.genres || [],
      duration: parsed.duration,
      viewOffset: parsed.viewOffset,
      progress,
    };
  } else {
    const tmdb = await enrichMovie(parsed.title, parsed.year);

    state = {
      mode: 'nowplaying',
      title: tmdb?.title || parsed.title,
      year: tmdb?.year || parsed.year,
      tagline: tmdb?.tagline || null,
      contentRating: tmdb?.contentRating || parsed.contentRating,
      contentRatingDesc: tmdb?.contentRatingDesc || null,
      audioCodec: parsed.audioCodec,
      audioLabel: parsed.audioLabel,
      audioClass: parsed.audioClass,
      resolution: parsed.resolution,
      resClass: parsed.resClass,
      aspectRatio: parsed.aspectRatio,
      rating: tmdb?.rating || null,
      posterUrl: tmdb?.posterUrl || null,
      backdropUrl: tmdb?.backdropUrl || null,
      trailerKey: tmdb?.trailerKey || null,
      genres: tmdb?.genres || [],
    };
  }

  setState(room, state);
  broadcast(room, state);
}

async function handlePlexStop(room) {
  const current = getState(room) || {};
  const state = { ...current, mode: 'screensaver' };
  setState(room, state);
  broadcast(room, state);

  screensaver.startRotation(room).catch(err =>
    console.error(`[plexHandler] Failed to start screensaver for ${room}:`, err.message)
  );
}

function handlePlexPause(room, parsed) {
  // Keep Now Playing screen on pause — just update progress
  const current = getState(room) || {};
  if (current.mode === 'nowplaying' || current.mode === 'nowplaying-tv') {
    const updates = {};
    if (parsed.viewOffset !== undefined) updates.viewOffset = parsed.viewOffset;
    if (parsed.duration) updates.progress = Math.round((parsed.viewOffset / parsed.duration) * 100);
    const state = { ...current, ...updates };
    setState(room, state);
    broadcast(room, state);
  }
}

module.exports = { handlePlexPlay, handlePlexStop, handlePlexPause };
