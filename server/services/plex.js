const AUDIO_MAP = {
  'truehd (atmos)': { codec: 'ATMOS', label: 'Dolby Atmos', cssClass: 'atmos' },
  'eac3 (atmos)':   { codec: 'ATMOS', label: 'Dolby Atmos', cssClass: 'atmos' },
  'truehd':         { codec: 'TRUEHD', label: 'Dolby TrueHD', cssClass: 'truehd' },
  'dts-hd ma':      { codec: 'DTS-HD', label: 'Master Audio', cssClass: 'dtshd' },
  'dts-hd':         { codec: 'DTS-HD', label: 'Master Audio', cssClass: 'dtshd' },
  'dts:x':          { codec: 'DTS:X', label: 'Object Audio', cssClass: 'dtshd' },
  'dts':            { codec: 'DTS', label: 'Surround', cssClass: 'dtshd' },
  'eac3':           { codec: 'DD+', label: 'Dolby Digital Plus', cssClass: '' },
  'ac3':            { codec: 'AC3', label: 'Dolby Digital', cssClass: '' },
  'aac':            { codec: 'AAC', label: 'Stereo', cssClass: '' },
};

function normalizeResolution(res) {
  if (!res) return null;
  const s = String(res).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return '4K';
  if (s.includes('1080')) return '1080p';
  if (s.includes('720')) return '720p';
  return s.toUpperCase();
}

function resolveAudio(rawCodec) {
  if (!rawCodec) return { codec: null, label: null, cssClass: '' };
  const key = rawCodec.toLowerCase().trim();
  // Try exact match first, then partial
  if (AUDIO_MAP[key]) return AUDIO_MAP[key];
  for (const [k, v] of Object.entries(AUDIO_MAP)) {
    if (key.includes(k)) return v;
  }
  return { codec: rawCodec.toUpperCase(), label: rawCodec, cssClass: '' };
}

function parseWebhookPayload(payload) {
  const event = payload.event;
  const type = payload.Metadata?.type;
  const metadata = payload.Metadata || {};
  const media = metadata.Media?.[0] || {};
  const part = media.Part?.[0] || {};
  const audioStream = part.Stream?.find(s => s.streamType === 2) || {};

  const rawAudio = audioStream.displayTitle || audioStream.codec || null;
  const audio = resolveAudio(rawAudio);
  const resolution = normalizeResolution(media.videoResolution);

  return {
    event,
    type,
    title: metadata.title,
    year: metadata.year,
    contentRating: metadata.contentRating || null,
    resolution,
    resClass: resolution === '4K' ? 'uhd' : '',
    aspectRatio: media.aspectRatio ? parseFloat(media.aspectRatio).toFixed(2) + ' : 1' : null,
    audioCodec: audio.codec,
    audioLabel: audio.label,
    audioClass: audio.cssClass,
    playerName: payload.Player?.title || null,
    userName: payload.Account?.title || null,
    showTitle: metadata.grandparentTitle || null,
    seasonNum: metadata.parentIndex || null,
    episodeNum: metadata.index || null,
    episodeTitle: type === 'episode' ? metadata.title : null,
    summary: metadata.summary || null,
    duration: metadata.duration || null,
    viewOffset: payload.Metadata?.viewOffset || 0,
  };
}

async function getRecentlyAddedMovies(plexUrl, plexToken) {
  if (!plexUrl || !plexToken) return [];
  try {
    const { enrichMovie, IMG_BASE } = require('./tmdb');
    const url = `${plexUrl}/library/recentlyAdded?X-Plex-Token=${plexToken}&type=1&unwatched=1`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    const items = (data.MediaContainer?.Metadata || []).slice(0, 20);

    const results = [];
    for (const item of items) {
      const title = item.title;
      const year = item.year;

      // Try TMDB enrichment for high-quality images
      let tmdb = null;
      try { tmdb = await enrichMovie(title, year); } catch {}

      const posterUrl = tmdb?.posterUrl || (item.thumb ? `/api/plex-image?path=${encodeURIComponent(item.thumb)}` : null);
      const backdropUrl = tmdb?.backdropUrl || (item.art ? `/api/plex-image?path=${encodeURIComponent(item.art)}` : null);

      results.push({
        source: 'recently_added',
        sourceLabel: 'Recently Added',
        title,
        subtitle: null,
        year: year || null,
        tagline: tmdb?.tagline || null,
        overview: tmdb?.overview || null,
        genres: tmdb?.genres || (item.Genre ? item.Genre.map(g => g.tag) : []),
        contentRating: tmdb?.contentRating || item.contentRating || null,
        contentRatingDesc: tmdb?.contentRatingDesc || null,
        posterUrl,
        backdropUrl,
        rating: tmdb?.rating || (item.audienceRating ? parseFloat((item.audienceRating / 2).toFixed(1)) : null),
        runtime: tmdb?.runtime || null,
        director: tmdb?.director || null,
        cast: tmdb?.cast || [],
        releaseDate: null,
      });
    }
    return results;
  } catch (err) {
    console.error('[plex] getRecentlyAddedMovies failed:', err.message);
    return [];
  }
}

async function getRecentlyAddedTV(plexUrl, plexToken) {
  if (!plexUrl || !plexToken) return [];
  try {
    const { enrichMovie } = require('./tmdb');
    const url = `${plexUrl}/library/recentlyAdded?X-Plex-Token=${plexToken}&type=4&unwatched=1`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    const items = (data.MediaContainer?.Metadata || []).slice(0, 20);

    const results = [];
    for (const item of items) {
      const showTitle = item.grandparentTitle || item.title;
      const season = item.parentIndex;
      const episode = item.index;
      const epTitle = item.title;
      const subtitle = season && episode ? `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')} - ${epTitle}` : epTitle;

      // Try TMDB enrichment using show name
      let tmdb = null;
      try { tmdb = await enrichMovie(showTitle, null); } catch {}

      const posterUrl = tmdb?.posterUrl || (item.grandparentThumb ? `/api/plex-image?path=${encodeURIComponent(item.grandparentThumb)}` : null);
      const backdropUrl = tmdb?.backdropUrl || (item.grandparentArt || item.art ? `/api/plex-image?path=${encodeURIComponent(item.grandparentArt || item.art)}` : null);

      results.push({
        source: 'recently_added_tv',
        sourceLabel: 'Recently Added TV',
        title: showTitle,
        subtitle,
        year: item.year || null,
        tagline: null,
        overview: tmdb?.overview || null,
        genres: tmdb?.genres || (item.Genre ? item.Genre.map(g => g.tag) : []),
        contentRating: item.contentRating || null,
        contentRatingDesc: tmdb?.contentRatingDesc || null,
        posterUrl,
        backdropUrl,
        rating: tmdb?.rating || null,
        runtime: null,
        director: null,
        cast: [],
        releaseDate: null,
      });
    }
    return results;
  } catch (err) {
    console.error('[plex] getRecentlyAddedTV failed:', err.message);
    return [];
  }
}

async function testPlexConnection(plexUrl, plexToken) {
  if (!plexUrl || !plexToken) return { ok: false, error: 'Missing Plex URL or token' };
  try {
    const url = `${plexUrl}/identity?X-Plex-Token=${plexToken}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { ok: false, error: `Plex returned HTTP ${res.status}` };
    const data = await res.json();
    const serverName = data.MediaContainer?.friendlyName || 'Unknown';
    return { ok: true, serverName };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not reach Plex server' };
  }
}

module.exports = { parseWebhookPayload, getRecentlyAddedMovies, getRecentlyAddedTV, testPlexConnection };
