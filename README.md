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

`plutado/odysseus`, branch **`local-customizations`**. These are quality-of-life tweaks layered on upstream Odysseus. Most are **frontend + config** (JavaScript / CSS / HTML + `docker-compose.yml`) and serve live via the static bind-mount; there is also **one small backend fix** (see [Models & endpoints](#models--endpoints)) which requires a one-time image rebuild (`docker compose up -d --build`).

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

### Chat

- **The assistant knows what Odysseus is (and your workspace state).** The chat model is a generic LLM with no inherent knowledge of the app it runs inside, so out of the box it can't tell you what Odysseus can do. Two layers of self-awareness are injected into the main chat:
  - **Capabilities (static).** A fixed "app self-knowledge" system message describing the built-in areas (Chat/Agents, Email, Calendar, Tasks & Notes, Brain/Memory, Documents/Library, Gallery, Deep Research, Web, Settings/Models, Compare, Cookbook) so the model can answer "what can you / this app do?" instead of inventing features. It's written to bias toward **action, not narration**: it tells the model that in **agent mode** it has real tools to *carry out* most of these tasks itself (create calendar events, send/triage email, manage tasks/notes/memory, generate images, run deep research, change settings…) and to prefer doing the task over explaining where to click — falling back to guidance only when it genuinely lacks a tool or is in plain chat mode. Kept **static** so it stays inside the KV-cached system prefix (near-zero cost after the first turn). Edit `ODYSSEUS_APP_CONTEXT` in `src/chat_processor.py`.
    - *Knowledge vs. agency:* this message is the **knowledge** layer; the **agency** comes from Odysseus's existing agent-mode tool suite (~80 tools). Self-awareness makes the model reach for those tools instead of reciting. Agency is gated by the composer's **Agent / Chat** toggle (Chat mode auto-promotes to agent when it detects an action intent like "add a calendar event").
    - *Guardrail:* because "knowing about" a feature isn't the same as "having the tool", the message explicitly forbids the model from guessing/fabricating tool names or call syntax — it must only call tools actually provided that turn, and otherwise offer to do it in agent mode. This prevents a real failure mode where a request doesn't get the right tool and the self-aware model hallucinates a call it has no schema for.
    - *Hyphen fix:* the word **"to-do"** (and "to do") slipped through two `todo`-only matchers, so a "to-do" request neither promoted to agent (`src/action_intents.py`) nor force-included the notes tool (`src/tool_index.py` keyword hints → `manage_notes`), leaving the model with no way to act. Both now match `to[-\s]?do`. (Note: a to-do maps to **`manage_notes`**, the Keep-style notes/checklist tool — `manage_tasks` is the cron scheduler.)
    - ⚠️ *The prerequisite for any of this to actually work — local models need `supports_tools=True`.* Agency was silently a no-op at first: for local **Ollama** endpoints Odysseus keeps native tool-calling **opt-in** (`ModelEndpoint.supports_tools`; see `src/agent_loop.py` `_is_api_model` logic), because some local models mishandle schemas. With it unset, agent mode logs `tools_sent=0` — the model gets **no callable tool schemas** and can only emit a fake *text* tool-call (e.g. `manage_tasks.create_task(...)`) that never executes, which reads exactly like "reciting". The fix is to set **`supports_tools=True`** on the endpoint (per-endpoint toggle in the endpoint/Add-Models settings, or the DB). Verified: qwen3.6 does native function-calling flawlessly via Ollama `/v1` once schemas are sent — it created a real note. Apply this to **any** new local endpoint whose model supports tools, or agent actions will no-op. (This is a per-machine endpoint setting, not repo code — captured here because it's the actual thing that turns "knows about the app" into "affects the app".)
  - **Live workspace snapshot (dynamic).** A separate, **non-cached** context message with the user's actual setup — connected email accounts, calendars, saved-memory count, indexed RAG documents, and default model — so the model can answer "how many email accounts do I have?" accurately. Gathered per turn, fully defensive (any source that errors is skipped), owner-scoped, and skipped for greetings/incognito. Built in `_build_app_state_message` (`routes/chat_helpers.py`).
  - **Toggle:** *Settings → Chat Area → "App Self-Awareness"* (default on). Backed by the `app_awareness` **server pref** (`/api/prefs/app_awareness`, read in `chat_helpers.py`) — not localStorage, since it drives backend prompt-building; the settings UI uses a `data-pref-key` attribute for pref-backed toggles.
  - Files: `src/chat_processor.py`, `routes/chat_helpers.py` (backend); `static/index.html`, `static/js/settings.js` (toggle). Applies to the main chat only (not the email/memory/etc. sub-prompts).
  - ⚠️ **Backend change** → `docker compose up -d --build`.
- **Attach audio → transcribe on send.** Attach an audio file (`.wav/.mp3/.m4a/.ogg/.flac/…`) to a chat and it's transcribed on send via the STT service, with the transcript injected into the message the (text/vision-only) model receives — so you can attach a recording and ask the model to summarize / answer / translate it. The transcript also shows in your sent message.
  - **Verbatim spoken-form:** transcripts are lowercased with sentence/pause punctuation stripped (apostrophes and word-internal hyphens kept), rather than Whisper's cleaned/punctuated output. Mic dictation is unaffected (stays clean for composing).
  - The transcription **engine** is your **local STT config**, not part of this fork — e.g. Whisper, or [CrisperWhisper](https://github.com/nyrahealth/CrisperWhisper) for verbatim capture of fillers/stutters/false-starts. See your local setup doc.
  - Files: `static/js/chat.js` (frontend); `routes/stt_routes.py` + `services/stt/stt_service.py` (backend — `/api/stt/transcribe` gained an optional `prompt` field forwarded to the STT engine).
  - ⚠️ **Backend change** (stt routes/service) → `docker compose up -d --build`.

### Voice (speak & listen)

Voice lives in **one place** — the composer toolbar. The **mic** is how you talk to the model (tap, speak, and your words land in the message box, editable; hit Send); the **speaker** button beside it is how the model talks back. Both halves sit together, so there's no hunting through settings.

- **Talk to it — dictation with responsive Stop.** Tap the mic, speak, and the transcript drops into the message box for you to edit and send.
  - **Auto-stop on pause:** once you've spoken, ~2.5s of silence ends the turn automatically (voice-activity detection) — no Stop tap needed. You can still tap **Stop** any time. Toggle it off at *Settings → Chat Area → "Auto-stop Dictation on Pause"* (default on); thresholds are live-tunable via `window.__odysseusDictationVAD` (`silenceMs`, `threshold`, `minSpeechMs`).
  - **Instant feedback:** the moment recording stops (auto or manual), the pill flips to a "Transcribing…" spinner (and the composer button shows one too) so it never looks stuck on "Recording." Extra Stop clicks are ignored while the result is in flight, so a double-click can't orphan the transcription. On failure you get a clear "try again" message rather than a silent, useless audio attachment.
  - Files: `static/js/voiceRecorder.js`.
- **It talks back — Auto-speak, toggled from the composer.** A **speaker** button in the composer toolbar toggles reading replies aloud (streamed sentence-by-sentence via the TTS service). It shares one source of truth with *Settings → Chat Area → "Auto-speak Replies"* (`localStorage.odysseusTTSAutoSpeak` → `aiTTSManager.autoPlay`, via `window._setAutospeak`), so toggling either keeps the other in sync; muting also stops any reply already playing.
  - **Answer only — never the reasoning.** The spoken text strips the model's `<think>…</think>` trace, including tags with attributes (`<think time="3">`) and a block that's still open mid-stream, so the thought process is never vocalized.
  - **Interrupt (barge-in).** While a reply is being read aloud you can cut it off: tap the **mic** (which stops the speech and starts listening), click the floating **"Stop speaking"** pill, or press **Esc**.
  - **Pick a voice.** *Settings → AI Defaults → Text to Speech* (previously hidden — un-hidden as part of this fork) exposes the local Kokoro model's real voices (American/British, female/male — e.g. **Heart** ⭐ warm default, **Bella** ⭐ expressive, **Nicole** soft, **Fenrir** deep, **Emma** British), grouped and ordered best-first, instead of only the six OpenAI-style names. The voice server passes Kokoro ids (`af_`/`am_`/`bf_`/`bm_…`) straight through (unknown names fall back to the default); OpenAI names still work too (mapped). Selecting a voice auto-saves + clears the TTS cache; **Preview** auditions it. (The grouped dropdown appears for endpoint providers; a host-gateway voice server counts.)
  - **Voice-server selectable as a TTS provider; broken "local" option removed.** The TTS provider list filtered endpoints to model names containing `tts`/`audio`; a host voice server whose only model is literally `kokoro` was excluded, so TTS silently fell back to the stock in-container `local` provider — which **can't work on Docker-for-Mac** (it needs CUDA and the `kokoro` package, neither present in the container). The keyword filter now also matches local TTS engine names (`kokoro`, `xtts`, `piper`, `bark`, …), host-gateway endpoints are labeled `(Local)`, and the misleading stock **"Local (Kokoro-82M)"** provider option is removed so it can't be picked by mistake.
  - Files: `static/index.html`, `static/app.js`, `static/js/settings.js`, `static/js/tts-ai.js`, `services/tts/tts_service.py` (clarifying comments only). (Voice list is the 28 English voices in `mlx-community/Kokoro-82M-bf16`; the shim also has non-English voices you can set by id.)

> **Where the voice models run.** All speech models run **natively on the host, not in the container** — Docker on macOS has no Metal/CUDA access. STT (CrisperWhisper / Whisper) and TTS (**Kokoro-82M via `mlx-audio`, Metal**) are served by a small local voice server and consumed by Odysseus as an `endpoint:` provider (`host.docker.internal:8720`). The container therefore has **no Kokoro/Whisper build dependency**; the in-container `local`-Kokoro code in `services/tts/tts_service.py` is upstream CUDA-only code that is unused here (see the FORK NOTE comments there). The voice server itself lives outside this repo — see the machine-local setup doc.
- **Unified recording orb.** The recording indicator is a level-reactive pulsing orb (its glow tracks your live mic level) — the same visual everywhere audio is being captured — with the elapsed `MM:SS` timer and an explicit **Stop**.
  - Files: `static/js/voiceRecorder.js`, `static/style.css`.

### Interface

- **Larger sidebar navigation.** Sidebar nav items and section headers are lifted to the shared `--app-min-font` (16px) floor for readability (they otherwise inherit a smaller root size).
- **16px readable-text floor (app-wide, one knob).** Several panels shipped with sub-16px text — Notes worst of all (filter tabs 10px, search/"Select"/inline quick-add 11px, title 13px, checklist 14px, card 15px), Tasks 12px, etc. A fork block at the end of `static/style.css` establishes **16px as the minimum readable size**, tuned in one place via the `--app-min-font` CSS variable (in `:root`). Two layers per panel: (1) the panel *root* font-size is set to the variable — this lifts only *inherited* text, so fixed-px grids/badges/icons keep their size (low-risk); (2) specific fixed-px readable elements (which set their own size) are bumped explicitly. Covers the **Notes** pane + fullscreen editor; the main **app chrome** (left-sidebar nav, composer `textarea#message`, model/mode controls, welcome-screen sub-copy, sidebar user name); and the **tool modals** — Brain/Memory, Documents/Library, Gallery, Cookbook, Compare, Deep Research, Tasks, Calendar, Email, Settings (via their shared `.admin-*` / `.doclib-*` / `.memory-*` / `.gallery-*` / `.cookbook-*` / `.email-*` / `.compare-*` / `.settings-*` element classes). Change one `--app-min-font` value to rescale everything.
  - The tool-modal pass is **generated** (~400 selectors, appended at the end of `static/style.css` so it wins same-specificity ties): it re-declares each sub-16px *readable-text* rule at `var(--app-min-font)`, but **deliberately leaves micro-elements small** — badges, dots, counts, timestamps/meta, per-card `#hashtag` chips (14px), the dense **Cookbook** model table, the **Calendar** month-grid cells, and the user-controlled **email-body** font — so those layouts don't break. To regenerate after upstream adds new modal CSS, re-run the extraction (a rule with `font-size:<16px` on a modal-prefixed selector, minus the exclusion list).
  - **Two-tier floor.** A second variable, **`--app-min-font-min` (14px)**, is an *absolute* floor: a generated app-wide pass (~530 selectors) lifts every remaining 9–13px *readable* rule to 14px, so no readable text in the app is smaller than 14px, while headline/body text sits at the 16px `--app-min-font`. Pure decoration (dots, marks, pseudo-elements), the density-root sizes, and anything already at 16px are excluded. Net: **16px for primary text, 14px hard floor for everything else readable.**
  - Files: `static/style.css`.

### Models & endpoints

- **Local (host-gateway) endpoints are detected as local.** `host.docker.internal` and `gateway.docker.internal` — the Docker Desktop aliases a container uses to reach services on the *host* (the standard "Odysseus in Docker + native Ollama / models on the host" setup) — are now classified as **local** endpoints. Previously they were treated as remote `"api"` endpoints, which puts the model picker into pinning/allow-list mode, so locally-served models don't show up for selection unless explicitly pinned. With this fix, host-served local models appear automatically.
  - Files: `routes/model_routes.py` (`_LOCAL_HOSTS`); test in `tests/test_model_routes.py` (`TestClassifyEndpoint.test_docker_host_gateway_is_local`).
  - ⚠️ **Backend change** — this is baked into the image, so apply it with `docker compose up -d --build` (a rebuild), not just a page reload.

### Developer notes (for extending this fork)

- **Live frontend edits:** `docker-compose.yml` bind-mounts `./static:/app/static:ro`, so frontend changes serve on reload — no image rebuild. **Backend changes** (anything under `routes/`, etc.) are baked into the image and need `docker compose up -d --build` to take effect.
- **Cache-busting (important):** frontend modules are imported with a static `?v=` query and precached by the service worker. When you change a versioned file, **bump its `?v=` everywhere it's referenced *and* bump `CACHE_NAME` in `static/sw.js`**, or browsers serve the stale module. The served files are always fresh (the static dir is `no-cache` + bind-mounted); the staleness is purely the browser's module/HTTP cache keyed on the unchanged URL.
  - The SW serves the **app shell (`/`) network-first** (fork change) so a fresh `index.html` — and therefore the new `?v=` CSS/JS — loads on **one** reload, instead of the old stale-while-revalidate behavior that took two reloads and could pin an old shell indefinitely. A one-time cache clear is still needed to *install* a new SW when the old one is stuck (`Application → Storage → Clear site data`, or unregister via the console).
- Machine-specific setup notes (paths, secrets, model choices) are kept out of Git via `.gitignore`.

---

## ⬇︎ Original upstream README (everything below this line)

Everything **above** this line is this fork's additions. **Everything below is the unmodified README from the upstream project, [odysseus-dev/odysseus](https://github.com/odysseus-dev/odysseus)** — kept verbatim for install steps, the feature list, and general reference. None of it is fork-specific, so if you just want to understand or run stock Odysseus, the **[original repository](https://github.com/odysseus-dev/odysseus)** is the source of truth (and has the newest changes).

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
