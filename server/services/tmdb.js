const BASE_URL = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

const GENRE_MAP = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
  80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
};

// 24h in-memory cache for upcoming movies
let upcomingCache = { data: null, fetchedAt: 0 };

// 24h in-memory cache for trending movies
let trendingCache = { data: null, fetchedAt: 0 };

function formatRuntime(minutes) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getApiKey() {
  try {
    const { getConfig } = require('../config');
    const key = getConfig().global.tmdbApiKey;
    if (key) return key;
  } catch {
    // config not loaded yet
  }
  return process.env.TMDB_API_KEY || '';
}

// Mock data for known titles when no API key
const MOCK_DATA = {
  'predator: badlands': {
    title: 'Predator: Badlands',
    year: 2025,
    tagline: 'First hunt. Last chance.',
    overview: 'A deadly hunt begins in uncharted territory.',
    posterUrl: `${IMG_BASE}/w500/pgvUGHzMfapRQh9S4LcpqvXLQtP.jpg`,
    posterUrlHd: `${IMG_BASE}/original/pgvUGHzMfapRQh9S4LcpqvXLQtP.jpg`,
    backdropUrl: `${IMG_BASE}/original/uNEFVMjEwmTMJwFnOCYRl7BDDSO.jpg`,
    genres: ['Action', 'Science Fiction', 'Thriller'],
    rating: 4.5,
    contentRating: 'PG-13',
    contentRatingDesc: 'Parents Strongly Cautioned',
    runtime: '1h 40m',
    director: 'Dan Trachtenberg',
    cast: ['Elle Fanning', 'Dane DiLiegro', 'Beau Knapp'],
    trailerKey: null,
  },
  'avengers: doomsday': {
    title: 'Avengers: Doomsday',
    year: 2026,
    tagline: 'The end begins.',
    overview: 'Earth\'s mightiest heroes face their ultimate challenge.',
    posterUrl: `${IMG_BASE}/w500/5BwqwxMEjeFtdknRV792Svo0K1v.jpg`,
    posterUrlHd: `${IMG_BASE}/original/5BwqwxMEjeFtdknRV792Svo0K1v.jpg`,
    backdropUrl: `${IMG_BASE}/original/5BwqwxMEjeFtdknRV792Svo0K1v.jpg`,
    genres: ['Action', 'Adventure'],
    rating: 4.0,
    contentRating: 'PG-13',
    contentRatingDesc: 'Parents Strongly Cautioned',
    runtime: '2h 30m',
    director: 'Joe Russo',
    cast: ['Robert Downey Jr.', 'Chris Evans', 'Scarlett Johansson'],
    trailerKey: null,
  },
};

const RATING_DESCS = {
  'G': 'General Audiences',
  'PG': 'Parental Guidance Suggested',
  'PG-13': 'Parents Strongly Cautioned',
  'R': 'Restricted',
  'NC-17': 'Adults Only',
};

async function enrichMovie(title, year) {
  const TMDB_API_KEY = getApiKey();
  if (!TMDB_API_KEY) {
    // Mock mode
    const key = title.toLowerCase().trim();
    return MOCK_DATA[key] || null;
  }

  try {
    // Search
    const searchParams = new URLSearchParams({
      api_key: TMDB_API_KEY,
      query: title,
      ...(year && { year: String(year) }),
    });
    const searchRes = await fetch(`${BASE_URL}/search/movie?${searchParams}`);
    const searchData = await searchRes.json();
    const movie = searchData.results?.[0];
    if (!movie) return null;

    // Get details with videos and release dates
    const detailParams = new URLSearchParams({
      api_key: TMDB_API_KEY,
      append_to_response: 'videos,release_dates,credits',
    });
    const detailRes = await fetch(`${BASE_URL}/movie/${movie.id}?${detailParams}`);
    const detail = await detailRes.json();

    // Extract trailer
    const trailer = detail.videos?.results?.find(
      v => v.type === 'Trailer' && v.site === 'YouTube'
    );

    // Extract US content rating
    const usRelease = detail.release_dates?.results?.find(r => r.iso_3166_1 === 'US');
    const certification = usRelease?.release_dates?.[0]?.certification || null;

    const rating = (detail.vote_average / 2).toFixed(1);

    // Extract director and top 3 cast from credits
    const director = detail.credits?.crew?.find(c => c.job === 'Director')?.name || null;
    const cast = (detail.credits?.cast || []).slice(0, 3).map(c => c.name);

    return {
      title: detail.title,
      year: new Date(detail.release_date).getFullYear(),
      tagline: detail.tagline || null,
      overview: detail.overview || null,
      posterUrl: detail.poster_path ? `${IMG_BASE}/w500${detail.poster_path}` : null,
      posterUrlHd: detail.poster_path ? `${IMG_BASE}/original${detail.poster_path}` : null,
      backdropUrl: detail.backdrop_path ? `${IMG_BASE}/original${detail.backdrop_path}` : null,
      genres: detail.genres?.map(g => g.name) || [],
      rating: parseFloat(rating),
      contentRating: certification,
      contentRatingDesc: RATING_DESCS[certification] || null,
      runtime: formatRuntime(detail.runtime),
      director,
      cast,
      trailerKey: trailer?.key || null,
    };
  } catch (err) {
    console.error('[tmdb] enrichMovie failed:', err.message);
    return null;
  }
}

const TV_RATING_DESCS = {
  'TV-Y': 'All Children',
  'TV-Y7': 'Directed to Older Children',
  'TV-G': 'General Audience',
  'TV-PG': 'Parental Guidance Suggested',
  'TV-14': 'Parents Strongly Cautioned',
  'TV-MA': 'Mature Audience Only',
};

const MOCK_TV_DATA = {
  'severance': {
    showTitle: 'Severance',
    posterUrl: `${IMG_BASE}/w500/pBp2i1JVYxOjMBEqEqMi5sERkHN.jpg`,
    posterUrlHd: `${IMG_BASE}/original/pBp2i1JVYxOjMBEqEqMi5sERkHN.jpg`,
    backdropUrl: `${IMG_BASE}/original/vHEehkdY9MHjGKGGixzPDPHNFMK.jpg`,
    genres: ['Drama', 'Mystery', 'Science Fiction'],
    contentRating: 'TV-MA',
    contentRatingDesc: 'Mature Audience Only',
    network: 'Apple TV+',
    trailerKey: null,
    rating: 4.3,
    episodeOverview: 'Mark leads the team on a search through the severed floor.',
    episodeRuntime: '52m',
    episodeStillUrl: null,
  },
};

async function enrichTVShow(showTitle, seasonNum, episodeNum) {
  const TMDB_API_KEY = getApiKey();
  if (!TMDB_API_KEY) {
    const key = showTitle.toLowerCase().trim();
    return MOCK_TV_DATA[key] || null;
  }

  try {
    // Search for the TV show
    const searchParams = new URLSearchParams({
      api_key: TMDB_API_KEY,
      query: showTitle,
    });
    const searchRes = await fetch(`${BASE_URL}/search/tv?${searchParams}`);
    const searchData = await searchRes.json();
    const show = searchData.results?.[0];
    if (!show) return null;

    // Get show details with videos and content ratings
    const detailParams = new URLSearchParams({
      api_key: TMDB_API_KEY,
      append_to_response: 'videos,content_ratings',
    });
    const detailRes = await fetch(`${BASE_URL}/tv/${show.id}?${detailParams}`);
    const detail = await detailRes.json();

    // Extract trailer
    const trailer = detail.videos?.results?.find(
      v => v.type === 'Trailer' && v.site === 'YouTube'
    );

    // Extract US content rating
    const usRating = detail.content_ratings?.results?.find(r => r.iso_3166_1 === 'US');
    const contentRating = usRating?.rating || null;

    const rating = (detail.vote_average / 2).toFixed(1);
    const network = detail.networks?.[0]?.name || null;

    // Fetch episode details if season/episode provided
    let episodeOverview = null;
    let episodeRuntime = null;
    let episodeStillUrl = null;

    if (seasonNum && episodeNum) {
      try {
        const epParams = new URLSearchParams({ api_key: TMDB_API_KEY });
        const epRes = await fetch(`${BASE_URL}/tv/${show.id}/season/${seasonNum}/episode/${episodeNum}?${epParams}`);
        if (epRes.ok) {
          const epDetail = await epRes.json();
          episodeOverview = epDetail.overview || null;
          episodeRuntime = formatRuntime(epDetail.runtime);
          episodeStillUrl = epDetail.still_path ? `${IMG_BASE}/original${epDetail.still_path}` : null;
        }
      } catch {}
    }

    return {
      showTitle: detail.name,
      posterUrl: detail.poster_path ? `${IMG_BASE}/w500${detail.poster_path}` : null,
      posterUrlHd: detail.poster_path ? `${IMG_BASE}/original${detail.poster_path}` : null,
      backdropUrl: detail.backdrop_path ? `${IMG_BASE}/original${detail.backdrop_path}` : null,
      genres: detail.genres?.map(g => g.name) || [],
      contentRating,
      contentRatingDesc: TV_RATING_DESCS[contentRating] || null,
      network,
      trailerKey: trailer?.key || null,
      rating: parseFloat(rating),
      episodeOverview,
      episodeRuntime,
      episodeStillUrl,
    };
  } catch (err) {
    console.error('[tmdb] enrichTVShow failed:', err.message);
    return null;
  }
}

async function testApiKey(key) {
  if (!key) return { ok: false, error: 'No API key provided' };
  if (!/^[a-f0-9]{32}$/i.test(key)) {
    return { ok: false, error: 'Wrong key format — use the 32-character "API Key", not the longer "Read Access Token"' };
  }
  try {
    const res = await fetch(`${BASE_URL}/movie/550?api_key=${key}`);
    if (res.ok) return { ok: true, message: 'Connected to TMDB' };
    if (res.status === 401) return { ok: false, error: 'Invalid API key' };
    return { ok: false, error: `TMDB returned HTTP ${res.status}` };
  } catch {
    return { ok: false, error: 'Could not reach TMDB — check network' };
  }
}

async function getUpcomingMovies() {
  const TMDB_API_KEY = getApiKey();
  if (!TMDB_API_KEY) return [];

  // Return cached data if fresh (24h)
  const now = Date.now();
  if (upcomingCache.data && (now - upcomingCache.fetchedAt) < 24 * 60 * 60 * 1000) {
    return upcomingCache.data;
  }

  try {
    const params = new URLSearchParams({
      api_key: TMDB_API_KEY,
      region: 'US',
      page: '1',
    });
    const res = await fetch(`${BASE_URL}/movie/upcoming?${params}`);
    if (!res.ok) return [];
    const data = await res.json();

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const basicItems = (data.results || [])
      .filter(m => m.release_date && m.release_date >= sevenDaysAgo)
      .slice(0, 20);

    // Enrich each item with full details (credits, runtime, etc.)
    const enrichResults = await Promise.allSettled(
      basicItems.map(m => enrichMovie(m.title, m.release_date ? new Date(m.release_date).getFullYear() : null))
    );

    const items = basicItems.map((m, i) => {
      const enriched = enrichResults[i].status === 'fulfilled' ? enrichResults[i].value : null;
      return {
        source: 'coming_soon',
        sourceLabel: 'Coming Soon',
        title: enriched?.title || m.title,
        subtitle: null,
        year: m.release_date ? new Date(m.release_date).getFullYear() : null,
        tagline: enriched?.tagline || null,
        overview: enriched?.overview || null,
        genres: enriched?.genres || (m.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean),
        contentRating: enriched?.contentRating || null,
        contentRatingDesc: enriched?.contentRatingDesc || null,
        posterUrl: enriched?.posterUrl || (m.poster_path ? `${IMG_BASE}/w500${m.poster_path}` : null),
        posterUrlHd: enriched?.posterUrlHd || (m.poster_path ? `${IMG_BASE}/original${m.poster_path}` : null),
        backdropUrl: enriched?.backdropUrl || (m.backdrop_path ? `${IMG_BASE}/original${m.backdrop_path}` : null),
        rating: enriched?.rating || (m.vote_average ? parseFloat((m.vote_average / 2).toFixed(1)) : null),
        runtime: enriched?.runtime || null,
        director: enriched?.director || null,
        cast: enriched?.cast || [],
        releaseDate: m.release_date || null,
        trailerKey: enriched?.trailerKey || null,
      };
    });

    console.log(`[tmdb] Upcoming: ${items.filter(i => i.trailerKey).length}/${items.length} have trailers`);
    upcomingCache = { data: items, fetchedAt: now };
    return items;
  } catch (err) {
    console.error('[tmdb] getUpcomingMovies failed:', err.message);
    return [];
  }
}

async function getTrendingMovies() {
  const TMDB_API_KEY = getApiKey();
  if (!TMDB_API_KEY) return [];

  // Return cached data if fresh (24h)
  const now = Date.now();
  if (trendingCache.data && (now - trendingCache.fetchedAt) < 24 * 60 * 60 * 1000) {
    return trendingCache.data;
  }

  try {
    const params = new URLSearchParams({ api_key: TMDB_API_KEY, page: '1' });

    // Fetch both trending and popular, merge for variety
    const [trendingRes, popularRes] = await Promise.all([
      fetch(`${BASE_URL}/trending/movie/week?${params}`),
      fetch(`${BASE_URL}/movie/popular?${params}`),
    ]);

    const trendingData = trendingRes.ok ? await trendingRes.json() : { results: [] };
    const popularData = popularRes.ok ? await popularRes.json() : { results: [] };

    // Merge and deduplicate by title
    const seen = new Set();
    const merged = [];
    for (const m of [...(trendingData.results || []), ...(popularData.results || [])]) {
      if (!seen.has(m.title)) {
        seen.add(m.title);
        merged.push(m);
      }
    }
    const basicItems = merged.slice(0, 20);

    // Enrich each item with full details
    const enrichResults = await Promise.allSettled(
      basicItems.map(m => enrichMovie(m.title, m.release_date ? new Date(m.release_date).getFullYear() : null))
    );

    const items = basicItems.map((m, i) => {
      const enriched = enrichResults[i].status === 'fulfilled' ? enrichResults[i].value : null;
      return {
        source: 'trending',
        sourceLabel: 'Popular & Trending',
        title: enriched?.title || m.title,
        subtitle: null,
        year: m.release_date ? new Date(m.release_date).getFullYear() : null,
        tagline: enriched?.tagline || null,
        overview: enriched?.overview || null,
        genres: enriched?.genres || (m.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean),
        contentRating: enriched?.contentRating || null,
        contentRatingDesc: enriched?.contentRatingDesc || null,
        posterUrl: enriched?.posterUrl || (m.poster_path ? `${IMG_BASE}/w500${m.poster_path}` : null),
        posterUrlHd: enriched?.posterUrlHd || (m.poster_path ? `${IMG_BASE}/original${m.poster_path}` : null),
        backdropUrl: enriched?.backdropUrl || (m.backdrop_path ? `${IMG_BASE}/original${m.backdrop_path}` : null),
        rating: enriched?.rating || (m.vote_average ? parseFloat((m.vote_average / 2).toFixed(1)) : null),
        runtime: enriched?.runtime || null,
        director: enriched?.director || null,
        cast: enriched?.cast || [],
        releaseDate: m.release_date || null,
        trailerKey: enriched?.trailerKey || null,
      };
    });

    console.log(`[tmdb] Trending: ${items.filter(i => i.trailerKey).length}/${items.length} have trailers`);
    trendingCache = { data: items, fetchedAt: now };
    return items;
  } catch (err) {
    console.error('[tmdb] getTrendingMovies failed:', err.message);
    return [];
  }
}

module.exports = { enrichMovie, enrichTVShow, testApiKey, getUpcomingMovies, getTrendingMovies, IMG_BASE };
