# Marquee — Live Match Top Banner

Design an elaborate, broadcast-grade **top banner strip** for a live soccer match, shown on a
wall-mounted theater TV (fixed **1920×1080**, 16:9, viewed from across a room). This banner spans the
full width at the very top of the screen. A scoreboard/stats card already sits below it (see
`harness.html`) — **design only the top strip**. It should feel like a premium TV sports broadcast's
upper-third / score bug (FIFA, ESPN, Sky Sports, TNT Sports).

## Hard constraints

- **Vanilla HTML + CSS only.** No frameworks, no build step, no external JS, no external image or font
  assets. (Team crest URLs are provided in the data and may be used in `<img>` tags — that's the only
  external imagery.)
- Deliver as **ONE self-contained snippet**: a single root `<div class="lm-banner">…</div>` plus a
  single `<style>` block where **every selector is scoped under `.lm-banner`** so nothing leaks into the
  rest of the page.
- **Fonts** limited to those already loaded on the page — pick whatever fits, do not import new fonts:
  - `Cinzel` (serif) — elegant headings
  - `Rajdhani` (sans) — clean labels/body
  - `Bebas Neue` — tall condensed display
  - `Teko` (sans) — condensed numerals/team names
  - `Black Ops One` — heavy stencil/impact
- Dark, cinematic base. You may read these CSS custom properties if useful: `--b-color` (theme accent),
  `--b-glow` (accent glow rgba), `--b-bg` (dark gradient). Team colors arrive as inline
  `--home-color` / `--away-color` custom properties on the root (hex).
- **Full-width fixed-height top strip.** Target height `clamp(64px, 8vh, 120px)`. Use `clamp()` and
  `vw/vh` units throughout so it scales gracefully at other resolutions.
- Animate tastefully — live pulse, subtle shimmer, a gentle score emphasis — but keep it **readable and
  not distracting**. No seizure-inducing flashing.
- Handle three match states (toggle via a class on the root, e.g. `.is-live` / `.is-pre` / `.is-post`):
  - **live** — show running clock + period, pulsing "LIVE" indicator
  - **pre** — show kickoff time / "VS", no score yet
  - **post** — show final score + "FT"

## Data binding

Populate from these fields. Give **each value a stable hook** — a class like `.lm-home-abbr` or an
attribute like `data-slot="home-crest"` — so it can be filled by JavaScript later. See
`data-contract.json` for a concrete sample.

**Home / Away team** (each side):
- `name` — full team name (e.g. "United States")
- `abbreviation` — 3-letter code (e.g. "USA")
- `logo` — crest image URL (use in an `<img>`)
- `score` — current goals (number)
- `color` — primary hex color (also exposed as `--home-color` / `--away-color`)

**Match:**
- `isLive` (bool), `status` ("pre" | "in" | "post")
- `clock` — e.g. "45+2"
- `periodText` — e.g. "2nd Half", "Half Time", "Full Time"

**Competition:**
- `league` — e.g. "FIFA World Cup"
- `leagueLogo` — URL (optional; may be absent)
- `round` — e.g. "Round of 16" (optional)

**Optional accents (use only if they strengthen the design):**
- `winProb` — `{ home, draw, away }` integer percentages
- `venue` / `venueCity`

## Layout intent

Crest + abbreviation on each side, a bold central score block carrying the live clock / period, a
competition mark, and **team-color accents** (lean on `--home-color` / `--away-color`). Think a polished
broadcast score bug stretched into a full-width banner. Propose a distinctive, confident direction —
surprise us, within the constraints above.

## Deliverable

The single scoped HTML + `<style>` snippet (one file), plus a one-line note of which fonts/effects you
used and any `--vars` you expect the host page to set.
