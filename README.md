<p align="center">
  <img src="docs/odysseus-wordmark.png" alt="Odysseus" width="238">
</p>

<p align="center">
  A self-hosted AI workspace for chat, agents, research, documents, email, notes, calendar, and local model workflows.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="docs/setup.md">Setup Guide</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <a href="https://repology.org/project/odysseus-ai/versions"><img src="https://repology.org/badge/vertical-allrepos/odysseus-ai.svg" alt="Packaging status"></a>
</p>

<p align="center">
  <img src="docs/odysseus-browser.jpg" alt="Odysseus interface">
</p>

---

> ⚙️ **This is a customized fork of [odysseus-dev/odysseus](https://github.com/odysseus-dev/odysseus).** The changes this fork adds — and how to use them — are documented under **[Fork customizations](#fork-customizations)**. The stock upstream README (Quick Start, Features, etc.) follows below and still applies.

## Fork customizations

`plutado/odysseus`, branch **`local-customizations`**. These are quality-of-life tweaks layered on upstream Odysseus. They're **frontend + config only** (JavaScript / CSS / HTML + `docker-compose.yml`) — no backend or database changes — so they apply cleanly on top of the stock image.

### Run this fork

```bash
git clone -b local-customizations https://github.com/plutado/odysseus.git
cd odysseus
cp .env.example .env
docker compose up -d --build
```

Everything in the upstream [Quick Start](#quick-start) and [setup guide](docs/setup.md) still applies.

> **macOS note:** port 7000 collides with the **AirPlay Receiver** (AirTunes), so `http://localhost:7000` may fail to load. Set a free host port — e.g. `APP_PORT=7070` — in `.env` before `docker compose up`, then open that port instead. (This is a stock `.env` setting, not a fork change; the compose port is already `${APP_PORT:-7000}`.)

### Email

- **Inline images auto-load.** Remote and embedded (`cid:`) images render automatically instead of the click-to-"Load all" flow; failed spacer/tracking images are dropped rather than left as "blocked" placeholders, and the per-image download-icon clutter is removed.
  - **Toggle:** *Settings → Privacy → "Auto-load Email Images"* (on by default; off restores the upstream click-to-load privacy flow). Persisted in `localStorage.odysseusEmailImagesManual`.
  - Files: `static/js/emailLibrary.js`, `static/index.html`, `static/js/settings.js`, `static/style.css`.
- **Numbers render correctly.** Email bodies no longer force `font-variant-emoji: emoji`, which had turned every digit / `©` / `#` into a tiny keycap-style emoji glyph while leaving letters normal. Real emoji still colorize.
  - Files: `static/style.css` (`.email-reader-body`, `.email-mode` compose editor).

### Calendar

- **New events default to a sync-out calendar.** The new-event form defaults its calendar to a CalDAV-backed one (so events push to the remote, e.g. Google) instead of a local-only calendar, and **remembers the last calendar you used** (`localStorage.odysseusDefaultCalendarHref`). Editing an event keeps its own calendar.
  - Files: `static/js/calendar.js`.

### Interface

- **Voice recording indicator.** While dictating: a pulsing dot, elapsed `MM:SS` timer, a live audio-level meter, and an explicit **Stop** button.
  - Files: `static/js/voiceRecorder.js`, `static/style.css`.
- **Larger sidebar navigation.** Sidebar nav items and section headers are set to 14px for readability (they otherwise inherit a smaller root size).
  - Files: `static/style.css`.

### Developer notes (for extending this fork)

- **Live frontend edits:** `docker-compose.yml` bind-mounts `./static:/app/static:ro`, so frontend changes serve on reload — no image rebuild.
- **Cache-busting (important):** frontend modules are imported with a static `?v=` query and precached by the service worker. When you change a versioned file, **bump its `?v=` everywhere it's referenced *and* bump `CACHE_NAME` in `static/sw.js`**, or browsers serve the stale module. The served files are always fresh (the static dir is `no-cache` + bind-mounted); the staleness is purely the browser's module/HTTP cache keyed on the unchanged URL.
- Machine-specific setup notes (paths, secrets, model choices) are kept out of Git via `.gitignore`.

---

## Quick Start

> `dev` is the default branch and gets the newest changes first. Use [`main`](https://github.com/odysseus-dev/odysseus/tree/main) if you want the more curated branch.

```bash
git clone https://github.com/odysseus-dev/odysseus.git
cd odysseus
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:7000` when the containers are healthy. The first admin password is printed in `docker compose logs odysseus`.

Native installs, GPU notes, Windows/macOS instructions, HTTPS, and configuration live in the [setup guide](docs/setup.md).

## Features

- **Chat + Agents** — local/API models, tools, MCP, files, shell, skills, and memory.
- **Cookbook** — hardware-aware model recommendations, downloads, and serving.
- **Deep Research** — multi-step web research with source reading and report generation.
- **Compare** — blind side-by-side model testing and synthesis.
- **Documents** — writing-first editor with AI edits, suggestions, Markdown, HTML, CSV, and syntax highlighting.
- **Email** — IMAP/SMTP inbox with triage, tags, summaries, reminders, and reply drafts.
- **Notes, Tasks + Calendar** — reminders, todos, scheduled agent tasks, and CalDAV sync.
- **Extras** — gallery/image editor, themes, uploads, web search, presets, sessions, and 2FA.

## Demo

A full hover-to-play tour lives on the landing page: [`docs/index.html`](docs/index.html).

## Contributing

Help is welcome. The best entry points are fresh-install testing, provider setup bugs, mobile/editor polish, docs, and small focused refactors. See [CONTRIBUTING.md](CONTRIBUTING.md) and [ROADMAP.md](ROADMAP.md).

## Security

Odysseus is a self-hosted workspace with powerful local tools. Keep auth enabled, keep private data out of Git, and do not expose raw model/service ports publicly. Deployment details are in the [setup guide](docs/setup.md#security-notes).

## Star History

<a href="https://www.star-history.com/?repos=odysseus-dev%2Fodysseus&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=odysseus-dev/odysseus&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=odysseus-dev/odysseus&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=odysseus-dev/odysseus&type=date&legend=top-left" />
 </picture>
</a>

## License

AGPL-3.0-or-later -- see [LICENSE](LICENSE) and [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).
