# Marquee — Theater Lobby Display System
## Full Project Specification for Claude Code

---

## Project Overview

**Marquee** is a locally-hosted, Docker-based theater lobby display system. It runs on a Ugreen NAS and serves full-screen, kiosk-ready web pages to TVs around the house. It integrates with Plex (via webhooks), TMDB (for artwork and metadata), Home Assistant (for Shield TV state), and ESPN (for live sports scores). One server serves multiple rooms, each with its own display URL.

The TV in kiosk mode just loads a URL — nothing is installed on the TV.

---

## Infrastructure

| Component | Detail |
|---|---|
| **Host machine** | Ugreen NAS |
| **Container manager** | Dockge (Docker Compose UI) |
| **Deployment** | Single `docker-compose.yml` — paste into Dockge and run |
| **Access** | All pages served on local network only |
| **Port** | `3000` (configurable via `.env`) |
| **Data persistence** | `/data/` volume mounted into container |

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Node.js 20 LTS | Alpine-based Docker image |
| Web framework | Express.js | REST API + static file serving |
| Real-time | `ws` (WebSocket) | Push state to displays instantly |
| Plex integration | Webhooks (multipart POST) | Requires Plex Pass |
| Movie metadata | TMDB API (free) | Posters, trailers, taglines, ratings |
| Sports data | ESPN public API | No key required |
| Home Assistant | REST API + WebSocket | Long-lived access token auth |
| Config/state | JSON files in `/data/` | No database needed |
| Frontend | Vanilla HTML/CSS/JS | Zero framework dependencies |
| Fonts | Google Fonts CDN | Cinzel, Rajdhani, Bebas Neue, Teko, Black Ops One |

---

## File Structure

```
marquee/
├── docker-compose.yml
├── .env.example
├── server/
│   ├── package.json
│   ├── index.js                  # Main entry — Express + WebSocket server
│   ├── routes/
│   │   ├── webhook.js            # Plex + HA webhook handlers
│   │   ├── api.js                # REST API routes
│   │   └── sports.js             # ESPN polling + sports state
│   ├── services/
│   │   ├── tmdb.js               # TMDB API wrapper
│   │   ├── plex.js               # Plex metadata parser
│   │   ├── ha.js                 # Home Assistant integration
│   │   └── screensaver.js        # Screensaver content pool manager
│   └── state.js                  # In-memory state + file persistence
├── public/
│   ├── index.html                # Hub — lists all room URLs
│   ├── display.html              # Main display page (all modes)
│   ├── settings.html             # Settings admin UI
│   └── assets/
│       ├── placeholder.png       # Fallback poster image
│       └── sounds/               # Optional audio cues (future)
└── data/                         # Persisted to Docker volume
    ├── config.json               # All settings
    └── state.json                # Last known room states
```

---

## Room Architecture

Each room gets its own URL: `http://nas-ip:3000/room/[slug]`

The `display.html` page detects the room slug from the URL, joins the correct WebSocket channel, and renders state pushed from the server.

### Default Rooms (configured at first run)

| Room | URL Slug | Default Mode |
|---|---|---|
| Theater | `/room/theater` | Movie Now Playing |
| Living Room | `/room/living-room` | Sports / General |

Rooms can be added/removed from the Settings UI without restarting the server.

---

## Display Modes

Each room can be in one of these modes at any time. Mode is pushed via WebSocket.

### 1. `nowplaying` — Movie (Plex)
**Triggered by:** Plex `media.play` / `media.resume` webhook when type = `movie`

**Layout:**
- Top banner (themed, configurable text)
- Center: Full portrait movie poster (from TMDB `original` size)
- Watched/unwatched eye icon (top-right of poster)
- "▶ Play Trailer" pill button (bottom of poster, only if trailer available)
- Bottom metadata bar containing:
  - MPAA rating badge (e.g. PG-13 with sub-label)
  - Audio format badge (Dolby Atmos / DTS-HD / TrueHD / DTS:X / Dolby Digital / etc.)
  - Aspect ratio (e.g. 2.35:1)
  - Resolution badge (1080p / 4K — 4K gets gold border)
  - HDR badge if applicable
  - Star rating (TMDB score converted to 0–5 stars)
  - Live clock (updates every second)
  - User avatar(s) from Plex session

**Data sources:**
- Plex webhook → audio codec, resolution, aspect ratio, content rating, session users
- TMDB → poster URL, tagline, trailer YouTube key, vote average

---

### 2. `nowplaying-tv` — TV Show (Plex)
**Triggered by:** Plex `media.play` webhook when type = `episode`

**Layout:**
- Top banner
- Left column: Show poster art
- Right column:
  - Show title (large)
  - Season/Episode badge (e.g. S2 · E07) + Network badge
  - Episode title
  - Episode overview text (truncated to ~3 lines)
  - Metadata row: Runtime · Rating · Audio · Video
  - Playback progress bar (from Plex `viewOffset` / `duration`)

**Data sources:**
- Plex webhook → show title, episode title, S/E numbers, viewOffset, duration, rating, codec, resolution
- TMDB → show poster, episode overview

---

### 3. `youtube` — YouTube (via Home Assistant)
**Triggered by:** HA webhook when Shield TV `app_name` contains "YouTube"

**Layout:**
- Dark red atmospheric background with subtle scanlines
- YouTube logo + wordmark (centered, large)
- Video title (if available from HA media attributes)
- Channel name + avatar initial
- View count, like count, duration (if available)
- Playback progress bar + timestamps

**Fallback:** If HA doesn't provide video metadata, show YouTube logo + "Watching Now" with the live clock.

---

### 4. `app` — Other App (via Home Assistant)
**Triggered by:** HA webhook when Shield TV is playing something that isn't Plex or YouTube

**Layout:**
- App name large centered
- App icon (emoji or logo based on app name matching)
- Media title if available
- Minimal clean design

---

### 5. `screensaver` — Idle / Screensaver
**Triggered by:** Plex `media.stop` / `media.pause`, HA `idle` / `off` state, or manually

**Behavior:**
- Cycles through a pool of content (interval configurable per room, default 15s)
- Ken Burns effect on backdrop image
- Progress bar along bottom shows time until next slide
- Dot navigation indicator

**Layout per slide:**
- Full-screen blurred/darkened backdrop (TMDB backdrop image)
- Bottom-left: Source label (e.g. "Coming Soon" / "Recently Added" / "Favorites")
- Title (large Cinzel serif)
- Year + genre pills
- Tagline (italic)
- Bottom-right: Portrait poster thumbnail

**Content sources (togglable per room in settings):**

| Source | How it works |
|---|---|
| `recently_added` | Plex API — newest unwatched movies from library |
| `recently_added_tv` | Plex API — newest unwatched TV episodes |
| `coming_soon` | TMDB `/movie/upcoming` — US region |
| `favorites` | User's manually curated list (managed in settings) |

All active sources are pooled and randomized. Each slide picks randomly from the pool.

---

### 6. `sports-soccer` — Soccer / Football
**Triggered by:** Manually, or auto-detected via ESPN API if a tracked team is live

**Background:** SVG soccer field line art (subtle, low opacity green)

**Layout:**
- Competition name (e.g. "UEFA Champions League · Round of 16")
- Live indicator + match clock (e.g. "73'")
- Team crests (emoji or logo) + team names + group/league info
- Large score center
- Venue + attendance
- Stats row: Possession bar, Shots, On Target (home vs away colored bars)
- Recent goals list (scorer name + minute)

**Color theme:** Green (`#4ade80`)

---

### 7. `sports-nfl` — NFL Football
**Background:** SVG football field with yard lines + end zones

**Layout:**
- League name
- Live indicator + quarter + game clock
- Down & distance badge (e.g. "2nd & 7")
- Team helmets (emoji) + city + team name
- Large score
- Venue
- Quarter-by-quarter score grid (Q1 / Q2 / Q3 / Q4 / TOT)
- Possession arrow + field position

**Color theme:** Blue (`#60a5fa`)

---

### 8. `sports-nba` — NBA Basketball
**Background:** SVG basketball court lines + three-point arcs

**Layout:**
- League name
- Live indicator + quarter + shot clock
- Team logos + names + season record
- Large score
- Last play description
- Three-stat comparison: FG% / 3PT% / Rebounds (bar for each)
- Season series record center
- Venue

**Color theme:** Orange (`#fb923c`)

---

### 9. `sports-ufc` — UFC / MMA
**Background:** SVG octagon outline

**Layout:**
- Event name (e.g. "UFC 312 · Main Event")
- Venue + city
- Live indicator + round + round clock
- Red corner fighter (country flag, avatar, name, nickname, record)
- Blue corner fighter (same)
- VS center with weight class + title belt badge
- Round score (e.g. 2–1 rounds)
- Four stat bars: Significant Strikes / Takedowns / Knockdowns / Accuracy

**Color theme:** Gold (`#facc15`)

---

### 10. `sports-mlb` — Baseball
**Background:** SVG diamond + outfield arc

**Layout:**
- League name
- Team logos + names + records
- Large score center
- Inning indicator with up/down arrow (Top/Bottom)
- Base diagram (3 bases highlighted when occupied)
- Count display: Balls (green) / Strikes (red) / Outs (yellow) dots
- Venue

**Color theme:** Amber (`#f9a825`)

---

## Banner System

The top banner is present in all modes. It is theme-aware and configurable per room.

**Structure:**
```
[ornament]  [BANNER TEXT]  [ornament]
```

**Text examples by mode:**
- Default: "Now Playing"
- Christmas: "Now Showing"
- Halloween: "Now Haunting"
- July 4th: "Now Playing"
- Sports: "Live Match" / "Live Game" / "Live Fight"
- Screensaver: "Coming Soon" / "Recently Added" / "Favorites"

**Banner text** is configurable per room in Settings.

---

## Theme System

Themes affect the banner, ambient glow, border colors, and accent colors. Themes are set per room in Settings.

| Theme | Primary Color | Special Effects |
|---|---|---|
| `default` | Gold `#c9a84c` | — |
| `christmas` | Red `#c41e3a` / accent green | Animated snowflakes in banner |
| `halloween` | Orange `#ff6600` / accent purple | Animated bats in banner |
| `independence` | Blue `#3a7bd5` / accent red | — |
| `neon` | Cyan `#00ffe1` / accent pink | — |

**Auto-scheduling (optional):** Themes can be automatically applied based on date ranges configured in settings (e.g. Dec 1–26 → christmas, Oct 15–31 → halloween).

---

## Trailer System

When a movie is displayed in `nowplaying` mode and a trailer is available (from TMDB), a "▶ Play Trailer" pill appears on the poster.

**Trailer modes (configurable per room):**

| Mode | Behavior |
|---|---|
| `off` | No trailer button shown |
| `manual` | Button appears, plays on click |
| `auto` | Button appears, auto-plays after configurable delay (default 30s) |

**Player:** YouTube embed in a full-screen overlay (`allowfullscreen`, `autoplay=1`, `mute=0`). Overlay has a "✕ CLOSE" button to return to poster view.

**Trailer delay** (for `auto` mode): Configurable in seconds per room.

---

## Plex Integration

### Webhook Setup (user does this once in Plex UI)
1. Plex Web → Settings → Webhooks → Add Webhook
2. URL: `http://[nas-ip]:3000/webhook/plex`

### Events handled

| Plex Event | Marquee Action |
|---|---|
| `media.play` | Parse metadata → enrich with TMDB → push `nowplaying` state to matched room |
| `media.resume` | Same as play |
| `media.pause` | Push `screensaver` state |
| `media.stop` | Push `screensaver` state |
| `media.scrobble` | (optional) mark as watched |

### Room Matching
Each room config has a `plex_player_name` field. When a webhook arrives, the `Player.title` field is matched against all room configs. If no match, defaults to `theater`.

### Metadata Extraction from Plex Webhook Payload
- `Metadata.title` → movie/show title
- `Metadata.year` → year
- `Metadata.type` → `movie` or `episode`
- `Metadata.grandparentTitle` → show name (for episodes)
- `Metadata.contentRating` → MPAA rating
- `Metadata.Media[0]` → resolution, aspect ratio
- `Metadata.Media[0].Part[0].Stream[]` → audio codec (find `streamType === 2`)
- `Player.title` → player name for room matching
- `Account` → user avatar/name

### Audio Codec Parsing
Parse `audio.displayTitle` or `audio.codec` and map to display labels:
- Contains "atmos" → `Dolby Atmos`
- Contains "dts:x" or "dtsx" → `DTS:X`
- Contains "dts-hd" or "dtshd" → `DTS-HD Master Audio`
- Contains "truehd" → `Dolby TrueHD`
- Contains "dts" → `DTS`
- Contains "eac3" or "dd+" → `Dolby Digital+`
- Contains "ac3" → `Dolby Digital`

---

## TMDB Integration

Base URL: `https://api.themoviedb.org/3`
Auth: `?api_key=YOUR_KEY` query param (v3 key)

### Calls made per movie play
1. `GET /search/movie?query={title}&year={year}` → get `id`, `poster_path`, `vote_average`
2. `GET /movie/{id}?append_to_response=videos,release_dates` → get `tagline`, `genres`, `videos.results[]`
3. From videos: find `type === "Trailer"` && `site === "YouTube"` → extract `key` for embed

### Image URLs
- Poster: `https://image.tmdb.org/t/p/original{poster_path}`
- Backdrop: `https://image.tmdb.org/t/p/original{backdrop_path}`
- Screensaver/small: `https://image.tmdb.org/t/p/w342{poster_path}`

### Upcoming movies (screensaver)
`GET /movie/upcoming?region=US` — refresh every 24 hours, cache results

---

## Home Assistant Integration

Auth: Long-lived access token in `Authorization: Bearer {token}` header

### Option A — HA Calls Marquee (Recommended)
Create a REST Command + Automation in HA:

```yaml
# configuration.yaml
rest_command:
  marquee_update:
    url: "http://nas-ip:3000/webhook/ha"
    method: POST
    content_type: "application/json"
    payload: >
      {"entity_id": "{{ entity_id }}", "state": "{{ state }}",
       "attributes": {{ attributes | tojson }}, "room": "{{ room }}"}
```

Automation triggers on `media_player.shield_tv` state change → calls `rest_command.marquee_update`.

### Option B — Marquee Polls HA
`GET /api/states/{entity_id}` with Bearer token — poll every 5 seconds per configured entity.

### State Mapping

| HA State | Marquee Action |
|---|---|
| `playing` + app = YouTube | Push `youtube` mode |
| `playing` + app = Plex | Let Plex webhook handle it |
| `playing` + other app | Push `app` mode with app name |
| `paused` | Push `screensaver` |
| `idle` / `off` / `standby` | Push `screensaver` |

### HA Entity per Room
Each room config has a `ha_entity` field (e.g. `media_player.shield_tv_theater`).

---

## Sports Integration (ESPN)

ESPN has public APIs that require no key. Base: `https://site.api.espn.com/apis/site/v2/sports/`

### Endpoints

| Sport | Endpoint |
|---|---|
| NFL | `/football/nfl/scoreboard` |
| NBA | `/basketball/nba/scoreboard` |
| MLB | `/baseball/mlb/scoreboard` |
| Soccer (UCL) | `/soccer/uefa.champions/scoreboard` |
| Soccer (MLS) | `/soccer/usa.1/scoreboard` |
| Soccer (EPL) | `/soccer/eng.1/scoreboard` |
| College Football | `/football/college-football/scoreboard` |

### Polling Strategy
- Poll every 30 seconds when any room is in `screensaver` or `sports` mode
- Poll every 15 seconds when a game is live
- Stop polling when server has no WebSocket clients connected

### Auto-Switch Logic (optional, configurable per room)
If a room has `auto_switch_sports: true` and a tracked team goes live, the room automatically switches from `screensaver` to the appropriate sports mode.

Tracked teams are configured as an array of ESPN team IDs in room settings.

---

## Settings UI

Accessible at `http://nas-ip:3000/settings`

This is a clean web UI (not a JSON editor). It must be usable on a phone or tablet on the local network.

### Sections

#### Global Settings
- TMDB API key (masked input, shows `••••••••` when saved)
- Plex server URL (e.g. `http://192.168.1.x:32400`)
- Plex token (masked)
- Home Assistant URL
- Home Assistant long-lived access token (masked)

#### Room Management
- List of all rooms with edit/delete
- "Add Room" — requires name + slug
- Per-room settings:
  - Display name
  - Plex player name (must match exactly as shown in Plex)
  - HA entity ID (e.g. `media_player.shield_tv`)
  - Theme (dropdown: default / christmas / halloween / independence / neon)
  - Banner text (free text input)
  - Theme auto-schedule (date ranges → theme mappings)
  - Trailer mode (`off` / `manual` / `auto`)
  - Trailer auto-play delay (seconds, shown only when `auto` selected)
  - Screensaver interval (seconds, default 15)
  - Screensaver sources (multi-checkbox: recently_added / recently_added_tv / coming_soon / favorites)
  - Auto-switch to sports (toggle)
  - Tracked teams (multi-select from ESPN team list)

#### Favorites Manager
- Search box → queries TMDB → shows results with poster thumbnails
- Click to add to favorites list
- Drag to reorder
- Toggle active/inactive per item
- Delete button per item
- Favorites are used by the screensaver when `favorites` source is enabled

#### Sports Override
- Manual "push" UI: select a sport and it pushes a mock live game to a room
- Useful for testing without a real game happening

#### Display Override (Manual Mode)
- Select a room
- Enter a title, image URL, subtitle, body text
- Push button → sends custom display to that room immediately
- "Clear" button returns room to screensaver

---

## REST API Reference

All endpoints are unauthenticated (local network only). Add basic auth in a future phase if needed.

### State

| Method | Path | Description |
|---|---|---|
| GET | `/api/state/:room` | Get current state for a room |
| POST | `/api/display/:room` | Manually push display state to a room |

### Config

| Method | Path | Description |
|---|---|---|
| GET | `/api/config` | Get config (tokens masked) |
| POST | `/api/config` | Save config (masked tokens preserved) |

### Rooms

| Method | Path | Description |
|---|---|---|
| GET | `/api/rooms` | List all rooms |
| POST | `/api/rooms` | Create a room (`{slug, name}`) |
| DELETE | `/api/rooms/:slug` | Delete a room |

### Content

| Method | Path | Description |
|---|---|---|
| GET | `/api/upcoming` | TMDB upcoming movies |
| GET | `/api/tmdb/search?q=` | Search TMDB for favorites |
| GET | `/api/favorites` | Get favorites list |
| POST | `/api/favorites` | Add to favorites |
| DELETE | `/api/favorites/:tmdbId` | Remove from favorites |

### Sports

| Method | Path | Description |
|---|---|---|
| GET | `/api/sports/live` | Get all currently live games |
| POST | `/api/sports/push/:room` | Push a specific game to a room |

### Webhooks

| Method | Path | Description |
|---|---|---|
| POST | `/webhook/plex` | Plex media webhook receiver |
| POST | `/webhook/ha` | Home Assistant state webhook receiver |

---

## WebSocket Protocol

Client connects to `ws://nas-ip:3000`

### Client → Server

```json
{ "type": "join", "room": "theater" }
```

### Server → Client (on join and on every state change)

```json
{
  "type": "state",
  "mode": "nowplaying",
  "theme": "default",
  "bannerText": "Now Playing",
  "nowPlaying": {
    "title": "Predator: Badlands",
    "year": "2025",
    "type": "movie",
    "tagline": "First hunt. Last chance.",
    "posterUrl": "https://image.tmdb.org/t/p/original/...",
    "backdropUrl": "https://image.tmdb.org/t/p/original/...",
    "ratingLabel": "PG-13",
    "audioCodec": "dts-hd",
    "resolution": "1080p",
    "aspectRatio": "2.35",
    "rating": "4.1",
    "trailerKey": "abc123xyz",
    "watched": false,
    "users": [{ "name": "Martin", "thumb": "..." }]
  }
}
```

### Reconnection
Client must auto-reconnect with 3s delay on disconnect. Re-join the room on reconnect.

---

## Docker Compose

```yaml
version: "3.9"
services:
  marquee:
    image: node:20-alpine
    container_name: marquee
    working_dir: /app
    command: sh -c "npm install && node index.js"
    ports:
      - "${PORT:-3000}:3000"
    volumes:
      - ./server:/app
      - ./public:/app/public
      - marquee-data:/app/data
    environment:
      - PORT=3000
      - TMDB_API_KEY=${TMDB_API_KEY}
      - PLEX_URL=${PLEX_URL}
      - PLEX_TOKEN=${PLEX_TOKEN}
      - HA_URL=${HA_URL}
      - HA_TOKEN=${HA_TOKEN}
    restart: unless-stopped

volumes:
  marquee-data:
```

---

## .env.example

```env
PORT=3000
TMDB_API_KEY=your_tmdb_v3_api_key_here
PLEX_URL=http://192.168.1.x:32400
PLEX_TOKEN=your_plex_token_here
HA_URL=http://192.168.1.x:8123
HA_TOKEN=your_ha_long_lived_token_here
```

---

## Visual Design Rules

These must be preserved throughout all display pages. Do not use generic/default styling.

### Fonts
| Usage | Font | Weight |
|---|---|---|
| Banner text, titles, screensaver | Cinzel (serif) | 700–900 |
| Body, labels, metadata | Rajdhani (sans) | 400–600 |
| Score numbers, clocks, badges | Bebas Neue | 400 |
| Sports team names (NFL/UFC) | Black Ops One | 400 |
| Sports labels, quarters | Teko | 500–700 |

All fonts loaded from Google Fonts CDN.

### Color System (CSS Variables)
```css
:root {
  --gold: #c9a84c;
  --gold-light: #e8c96b;
  --text: #f0e8d8;
}
```

Each sports mode has its own accent color. See Display Modes section.

### Motion
- Poster/content entering: `revealUp` — fade + translateY(14px), `cubic-bezier(0.16, 1, 0.3, 1)`, 0.8–1.2s
- Staggered child elements: 0.1s delay increments
- Ambient glow: radial gradient behind poster, transitions on theme change
- Ken Burns (screensaver): slow scale + translate, 20s alternate
- Live pulse dot: `opacity` pulse, 1.5s infinite
- Trailer button: appears with `revealUp` after 1.5s delay

### Layout Principles
- All layouts are `position: fixed; inset: 0` — true full screen
- Banner is always top, 48–56px tall
- Meta bar (movie mode) always bottom
- Sports modes: content centered with `flex-direction: column; align-items: center`
- TV show mode: side-by-side grid (`grid-template-columns: auto 1fr`)
- No scrollbars ever — `overflow: hidden` on html/body

### Background Treatment
- Movie/TV: `radial-gradient` from dark gray center to black
- Sports: Sport-specific SVG field/court/ring lines at 7–18% opacity
- Screensaver: TMDB backdrop image, blurred + darkened, Ken Burns
- YouTube: Dark red radial gradient + subtle scanlines
- All: ambient glow using sport/mode accent color at low opacity

---

## Build Phases

Build in this order. Each phase is independently usable.

### Phase 1 — Core Foundation
- [ ] Docker setup + `docker-compose.yml` + `.env.example`
- [ ] Express server with WebSocket (`ws` library)
- [ ] Plex webhook receiver (parse multipart/form-data)
- [ ] TMDB service (search + movie details + trailer key)
- [ ] Room state management (in-memory + JSON persistence)
- [ ] `display.html` — `nowplaying` movie mode only
- [ ] `display.html` — `screensaver` mode (static, no sources yet)
- [ ] WebSocket client in display.html with auto-reconnect
- [ ] `index.html` — simple room list/launcher page

**Done = TV shows movie poster automatically when Plex plays a movie.**

### Phase 2 — Settings + Multi-Room
- [ ] `config.json` schema + load/save service
- [ ] `settings.html` — global settings (API keys, Plex, HA)
- [ ] `settings.html` — room management (add/edit/delete)
- [ ] `settings.html` — per-room config (theme, banner, player name, HA entity)
- [ ] Theme system in `display.html` (CSS variable switching + christmas/halloween effects)
- [ ] Banner text configurable per room

**Done = Multiple rooms, each independently themed and configured.**

### Phase 3 — Screensaver Sources
- [ ] Plex API client (recently added movies + TV)
- [ ] TMDB upcoming movies (cached, refreshed every 24h)
- [ ] Screensaver content pool manager
- [ ] `display.html` — screensaver with Ken Burns + rotating content
- [ ] Screensaver source toggles wired to settings
- [ ] Dot navigation + progress bar

**Done = Beautiful idle screensaver cycling through content.**

### Phase 4 — TV Shows + Trailer
- [ ] `display.html` — `nowplaying-tv` mode (side-by-side layout)
- [ ] Episode metadata from Plex + TMDB enrichment
- [ ] Playback progress bar (from Plex `viewOffset`)
- [ ] Trailer overlay player (YouTube embed)
- [ ] Trailer mode config wired to settings
- [ ] Trailer auto-play timer

**Done = TV shows display correctly. Trailers play on demand or automatically.**

### Phase 5 — Sports
- [ ] ESPN API service (multi-sport scoreboard polling)
- [ ] Sports state pushed via WebSocket
- [ ] `display.html` — soccer mode (field bg + stats + goal events)
- [ ] `display.html` — NFL mode (field bg + score grid + possession)
- [ ] `display.html` — NBA mode (court bg + team stats)
- [ ] `display.html` — UFC mode (octagon bg + fighter cards + stats)
- [ ] `display.html` — MLB mode (diamond bg + bases + count)
- [ ] Manual sports push from settings
- [ ] Auto-switch to sports when tracked team goes live (optional toggle)

**Done = Every major sport has a beautiful live scoreboard.**

### Phase 6 — Home Assistant
- [ ] HA REST API client
- [ ] HA webhook receiver
- [ ] YouTube mode in `display.html`
- [ ] App mode in `display.html` (generic catch-all)
- [ ] HA entity mapping per room in settings
- [ ] HA connection status indicator in settings

**Done = Shield TV playing YouTube shows on the display automatically.**

### Phase 7 — Favorites + Polish
- [ ] `settings.html` — favorites manager with TMDB search
- [ ] Favorites wired into screensaver pool
- [ ] Manual display override in settings
- [ ] Watched badge toggle (persisted per room state)
- [ ] Theme auto-scheduling (date range → theme)
- [ ] `settings.html` — sports tracked teams selector
- [ ] User avatar display in movie mode (from Plex session)

---

## Important Notes for Claude Code

1. **Never use a UI framework** — vanilla HTML/CSS/JS only for display pages. No React, Vue, etc.
2. **Never use a CSS framework** — no Tailwind, Bootstrap. All CSS is custom with CSS variables.
3. **The display page must work with JS disabled for the static layout** — JS adds the WebSocket layer on top.
4. **Always handle TMDB/ESPN failures gracefully** — if enrichment fails, display what Plex provided. Never crash.
5. **The Plex webhook is multipart/form-data** — use `multer` with `upload.none()` to parse `req.body.payload`.
6. **Token security** — when returning config via `GET /api/config`, always mask real token values with `••••••••`. When saving, preserve existing token if masked value is sent back.
7. **WebSocket reconnection** — the display page must reconnect silently and re-join its room. The TV may be on 24/7.
8. **No authentication** — this is local-network-only. Keep it simple.
9. **Google Fonts must be loaded** — `Cinzel`, `Rajdhani`, `Bebas Neue`, `Teko`, `Black Ops One`. Load all from a single `<link>` in the `<head>`.
10. **All display layouts are full-screen** — `position: fixed; inset: 0; overflow: hidden`. No scrolling ever.
11. **Sports SVG backgrounds** — draw field/court/ring lines using inline SVG with `position: absolute; inset: 0; opacity: 0.07-0.18`. They are decorative, not functional.
12. **Start with Phase 1** and confirm it works end-to-end before moving to Phase 2.

---

## Reference: Existing Mockup

A visual mockup HTML file exists showing all display modes with full styling. It is named `marquee-all-modes.html`. Use it as the visual reference for all display styles, colors, layouts, font sizes, and badge designs. Do not deviate from the visual language established there.

Key visual elements to match exactly:
- The `revealUp` animation on content entrance
- The ambient radial glow behind the poster
- The banner structure with ornaments flanking the text
- The metadata badge styles (rating box, audio stack, resolution border)
- The sports accent colors (green=soccer, blue=NFL, orange=NBA, gold=UFC, amber=MLB)
- The screensaver text hierarchy (source label → title → meta row → tagline)

---

*Spec version 1.0 — Generated March 2026*
*Project: Marquee Theater Display System*
*Owner: Martin @ NGT Technology*
