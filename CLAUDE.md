# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Dev server (auto-reload on file changes)
```
cd server && npm run dev
```

### Production server
```
cd server && npm start
```

### Restart server (kill existing process first)
```
netstat -ano | grep ':3000' | grep LISTEN
taskkill //PID <pid> //F
cd server && npm run dev
```
If `--watch` mode is stuck after a port conflict, stop the process entirely and start a new one.

### Docker
```
docker compose up -d
```

There is no build step, linter, or test suite configured.

## Architecture

Marquee is a real-time theater display system. Plex sends webhooks when media plays/stops, the server enriches metadata via TMDB, and pushes updates over WebSocket to browser-based displays.

### Server (`server/`)

| File | Role |
|------|------|
| `index.js` | Entry point — Express + WebSocket server on port 3000 |
| `config.js` | Config persistence (`data/config.json`), sensitive field masking (`MASK = "••••••••"`), token preservation on save |
| `state.js` | Per-room state persistence (`data/state.json`), WebSocket client tracking, `broadcastToRoom()` |
| `routes/api.js` | REST API — config CRUD, room CRUD, TMDB test, display state |
| `routes/webhook.js` | Plex webhook handler — parses payload, enriches via TMDB, broadcasts to room |
| `services/tmdb.js` | TMDB API client — `enrichMovie(title, year)`, `testApiKey(key)`, hardcoded mock fallback |
| `services/plex.js` | Plex payload parser — extracts title, audio codec, resolution, player name |

### Frontend (`public/`)

All pages are vanilla HTML/CSS/JS — **no UI or CSS frameworks**.

| File | Role |
|------|------|
| `index.html` | Room selection hub — fetches `/api/rooms`, links to `/room/{slug}` |
| `display.html` | Theater display — WebSocket-driven, two modes: `nowplaying` and `screensaver` |
| `settings.html` | Config UI — API keys, room CRUD, theme/banner settings |

### Data flow: Plex → Display

```
Plex webhook POST /webhook/plex
  → Parse payload (services/plex.js)
  → Map player name → room slug (config.js playerRoomMap)
  → Enrich with TMDB (services/tmdb.js)
  → setState(room, merged data)
  → broadcastToRoom(room, payload) via WebSocket
  → display.html renders nowplaying or screensaver
```

### WebSocket protocol

- Client sends `{ type: 'join', room: 'theater' }` on connect
- Server responds with full room payload (state + config merged via `getRoomPayload()`)
- Server broadcasts on state change or config update
- Client auto-reconnects after 3 seconds on disconnect

### Config structure

```
global: { tmdbApiKey, plexUrl, plexToken, haUrl, haToken }
rooms.{slug}: { name, theme, bannerText, plexPlayerName, haEntity, trailerMode, trailerDelay, screensaverInterval }
```

Sensitive fields (API keys, tokens) are masked in GET responses. On POST/PUT, masked values are detected and the real value is preserved from memory.

### Theme system

Seven themes: `default`, `christmas`, `halloween`, `ocean`, `royal`, `emerald`, `rose`. Each maps to a CSS color applied via `--b-color`, `--b-glow`, `--b-bg` custom properties. Christmas adds snowflakes; Halloween adds bats.

### Environment variables

- `PORT` — server port (default 3000)
- `DATA_DIR` — config/state storage directory (default `/app/data`, local dev uses `../data`)
- `TMDB_API_KEY` — fallback TMDB key (can also be set in config UI)
- `PLAYER_ROOM_MAP` — JSON mapping Plex player names to room slugs

### Fonts

- **Cinzel** (serif) — headers, banner, room names
- **Rajdhani** (sans-serif) — body text, form elements
- **Bebas Neue** — badges, buttons
