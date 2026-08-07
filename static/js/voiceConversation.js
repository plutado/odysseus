// static/js/voiceConversation.js
//
// Fork feature: hands-free Voice Conversation Mode.
//
//   mic (VAD) → transcribe → auto-send → spoken reply (TTS) → auto-listen → …
//
// The loop reuses pieces that already exist:
//   • transcription  → POST /api/stt/transcribe (your local STT, e.g. CrisperWhisper)
//   • spoken replies → window.aiTTSManager (streaming sentence-by-sentence TTS)
//   • sending        → the normal #chat-form submit path
//
// The only genuinely new part is the glue: voice-activity detection (VAD) to
// decide when you've stopped talking, and orchestration of the turn-taking so
// you never touch the keyboard.
//
// Turn-end is silence-based: after speech is detected, ~4s of continuous
// silence ends your turn (tunable via window.__odysseusVAD).

const VAD = {
  // Continuous silence (ms) after speech before the turn is considered done.
  silenceMs: 4000,
  // Normalized RMS (0..1) above which a frame counts as speech. Calibrated up
  // from the measured ambient floor on entry so a noisy room self-adjusts.
  threshold: 0.02,
  // Cumulative voiced time (ms) required before we'll arm silence detection —
  // stops a cough/click from ending a turn that never really started.
  minSpeechMs: 300,
  // Hard cap on a single utterance so a stuck VAD can't record forever.
  maxUtteranceMs: 60000,
};
// Allow live tuning from the console: window.__odysseusVAD.silenceMs = 5000
try { window.__odysseusVAD = VAD; } catch (e) { /* ignore */ }

let _active = false;
let _state = 'idle';            // idle | listening | transcribing | thinking | speaking
let _stream = null;             // persistent mic MediaStream for the whole session
let _audioCtx = null;
let _analyser = null;
let _source = null;
let _recorder = null;
let _chunks = [];
let _rafId = 0;
let _prevAutoPlay = false;
let _els = null;                // overlay elements

// ── small async helpers ──────────────────────────────────────────────────

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll cond() until true or timeout; resolves true if satisfied, false on timeout.
async function _waitUntil(cond, timeoutMs, pollMs = 120) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (cond()) return true; } catch (e) { /* ignore */ }
    await _sleep(pollMs);
  }
  return false;
}

// ── busy signals (read app/chat/TTS state without importing them) ─────────

function _chatGenBusy() {
  return !!document.querySelector('.send-btn[data-mode="streaming"], .send-btn.send-pending')
    || !!window.__odysseusChatBusy
    || Date.now() < (window.__odysseusChatBusyUntil || 0);
}

function _ttsBusy() {
  const m = window.aiTTSManager;
  if (!m) return false;
  return !!(m._processing || (m._queue && m._queue.length) || m.isPlaying || m._streamActive);
}

// ── styles + overlay ──────────────────────────────────────────────────────

function _ensureStyles() {
  if (document.getElementById('voice-convo-styles')) return;
  const s = document.createElement('style');
  s.id = 'voice-convo-styles';
  s.textContent = `
    .voice-convo-overlay {
      position: fixed; left: 50%; bottom: 92px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 14px;
      background: var(--panel, #161b22); color: var(--fg, #c9d1d9);
      border: 1px solid var(--border, #30363d); border-radius: 16px;
      padding: 12px 16px; box-shadow: 0 10px 34px rgba(0,0,0,0.45);
      z-index: 10000; user-select: none; max-width: 92vw;
    }
    .voice-convo-orb {
      position: relative; width: 44px; height: 44px; border-radius: 50%;
      flex-shrink: 0; display: grid; place-items: center;
      background: color-mix(in srgb, var(--accent-primary, #3b82f6) 22%, transparent);
    }
    .voice-convo-orb svg { width: 20px; height: 20px; color: var(--accent-primary, #3b82f6); z-index: 1; }
    .voice-convo-orb::after {
      content: ''; position: absolute; inset: 0; border-radius: 50%;
      background: var(--accent-primary, #3b82f6); opacity: 0.35;
      transform: scale(var(--orb-level, 0.2)); transition: transform 0.08s linear, opacity 0.2s;
    }
    .voice-convo-overlay[data-state="listening"] .voice-convo-orb::after { opacity: 0.30; }
    .voice-convo-overlay[data-state="transcribing"] .voice-convo-orb::after,
    .voice-convo-overlay[data-state="thinking"] .voice-convo-orb::after {
      animation: voiceConvoPulse 1.2s ease-in-out infinite; transform: scale(0.7); opacity: 0.28;
    }
    .voice-convo-overlay[data-state="speaking"] .voice-convo-orb {
      background: color-mix(in srgb, var(--color-recording, #ff3b30) 22%, transparent);
    }
    .voice-convo-overlay[data-state="speaking"] .voice-convo-orb svg { color: var(--color-recording, #ff3b30); }
    .voice-convo-overlay[data-state="speaking"] .voice-convo-orb::after {
      background: var(--color-recording, #ff3b30);
      animation: voiceConvoPulse 1.1s ease-in-out infinite; transform: scale(0.75); opacity: 0.3;
    }
    @keyframes voiceConvoPulse { 0%,100% { opacity: 0.15; } 50% { opacity: 0.4; } }
    .voice-convo-body { display: flex; flex-direction: column; gap: 2px; min-width: 150px; }
    .voice-convo-status { font-size: 13.5px; font-weight: 600; }
    .voice-convo-hint { font-size: 11.5px; opacity: 0.6; }
    .voice-convo-actions { display: flex; align-items: center; gap: 8px; }
    .voice-convo-btn2 {
      display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
      border-radius: 999px; padding: 6px 12px; font-size: 12px; font-weight: 600;
      border: 1px solid var(--border, #30363d); background: transparent; color: var(--fg, #c9d1d9);
    }
    .voice-convo-btn2:hover { background: color-mix(in srgb, var(--fg, #c9d1d9) 10%, transparent); }
    .voice-convo-btn2.end { border: none; background: var(--color-recording, #ff3b30); color: #fff; }
    .voice-convo-btn2.end:hover { background: var(--color-recording-hover, #d63031); }
    .voice-convo-btn2 svg { width: 12px; height: 12px; }
    /* Active state for the composer toggle button */
    #voice-convo-btn.active { color: var(--accent-primary, #3b82f6); }
    #voice-convo-btn.active svg { color: var(--accent-primary, #3b82f6); }
  `;
  document.head.appendChild(s);
}

const _ICON_HEADSET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14v-3a9 9 0 0 1 18 0v3"/><path d="M21 16a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3z"/><path d="M3 16a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H3z"/><path d="M21 18a4 4 0 0 1-4 4h-5"/></svg>';
const _ICON_SKIP = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5 4l10 8L5 20V4z"/><rect x="17" y="4" width="2.4" height="16" rx="1"/></svg>';
const _ICON_END = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';

function _showOverlay() {
  _ensureStyles();
  _hideOverlay();
  const wrap = document.createElement('div');
  wrap.className = 'voice-convo-overlay';
  wrap.id = 'voice-convo-overlay';
  wrap.innerHTML =
    '<div class="voice-convo-orb">' + _ICON_HEADSET + '</div>' +
    '<div class="voice-convo-body">' +
      '<span class="voice-convo-status" id="voice-convo-status">Starting…</span>' +
      '<span class="voice-convo-hint" id="voice-convo-hint">Voice conversation</span>' +
    '</div>' +
    '<div class="voice-convo-actions">' +
      '<button type="button" class="voice-convo-btn2 skip" id="voice-convo-skip" title="Stop speaking and listen now" style="display:none">' + _ICON_SKIP + 'Skip</button>' +
      '<button type="button" class="voice-convo-btn2 end" id="voice-convo-end" title="End voice conversation">' + _ICON_END + 'End</button>' +
    '</div>';
  document.body.appendChild(wrap);
  _els = {
    wrap,
    status: wrap.querySelector('#voice-convo-status'),
    hint: wrap.querySelector('#voice-convo-hint'),
    orb: wrap.querySelector('.voice-convo-orb'),
    skip: wrap.querySelector('#voice-convo-skip'),
    end: wrap.querySelector('#voice-convo-end'),
  };
  _els.end.addEventListener('click', () => exit());
  _els.skip.addEventListener('click', () => _skipSpeaking());
}

function _hideOverlay() {
  const el = document.getElementById('voice-convo-overlay');
  if (el) el.remove();
  _els = null;
}

function _setState(state, status, hint) {
  _state = state;
  if (!_els) return;
  _els.wrap.dataset.state = state;
  if (status != null) _els.status.textContent = status;
  if (hint != null) _els.hint.textContent = hint;
  _els.skip.style.display = state === 'speaking' ? '' : 'none';
  if (state !== 'listening') _els.orb.style.setProperty('--orb-level', '0.2');
}

// ── one listening turn (VAD) ───────────────────────────────────────────────

function _startListenTurn() {
  if (!_active || !_stream) return;
  _chunks = [];
  try {
    _recorder = new MediaRecorder(_stream, { mimeType: 'audio/webm' });
  } catch (e) {
    // Some browsers reject the explicit mimeType — fall back to default.
    try { _recorder = new MediaRecorder(_stream); } catch (e2) {
      _fail('Recording unsupported in this browser.');
      return;
    }
  }
  _recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) _chunks.push(ev.data); };
  _recorder.onstop = () => {
    const blob = new Blob(_chunks, { type: _chunks[0]?.type || 'audio/webm' });
    _handleUtterance(blob);
  };
  _recorder.start();

  _setState('listening', 'Listening…', 'Speak — pause when you\'re done');

  // VAD loop over the persistent analyser.
  const buf = new Uint8Array(_analyser.fftSize);
  const turnStart = Date.now();
  let lastVoiceTs = Date.now();
  let voicedMs = 0;
  let speechStarted = false;
  let prevTs = Date.now();

  const tick = () => {
    if (!_active || _state !== 'listening' || !_recorder || _recorder.state !== 'recording') return;
    const now = Date.now();
    const dt = now - prevTs; prevTs = now;

    _analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = (buf[i] - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / buf.length);

    // Level ring: map rms into a visible scale.
    const level = Math.min(1.4, 0.2 + rms * 9);
    if (_els) _els.orb.style.setProperty('--orb-level', level.toFixed(2));

    if (rms >= VAD.threshold) {
      lastVoiceTs = now;
      voicedMs += dt;
      if (!speechStarted && voicedMs >= VAD.minSpeechMs) {
        speechStarted = true;
        if (_els) _els.hint.textContent = 'Listening… (pause ' + Math.round(VAD.silenceMs / 1000) + 's to send)';
      }
    }

    const silentFor = now - lastVoiceTs;
    const elapsed = now - turnStart;
    const doneTalking = speechStarted && silentFor >= VAD.silenceMs;
    const tooLong = speechStarted && elapsed >= VAD.maxUtteranceMs;

    if (doneTalking || tooLong) {
      _stopListenTurn();
      return;
    }
    _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}

function _stopListenTurn() {
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  if (_recorder && _recorder.state === 'recording') {
    try { _recorder.stop(); } catch (e) { /* onstop may not fire — guard below */ }
  }
}

async function _handleUtterance(blob) {
  if (!_active) return;
  if (!blob || blob.size < 1200) {  // basically silence / no capture
    _startListenTurn();
    return;
  }
  _setState('transcribing', 'Transcribing…', 'Turning speech into text');
  let text = '';
  try {
    text = await _transcribe(blob);
  } catch (e) {
    console.warn('[voiceConvo] transcription failed:', e);
    _toast('Transcription failed — listening again.');
  }
  if (!_active) return;

  text = (text || '').trim();
  if (!text) {
    _setState('listening', 'Didn\'t catch that…', 'Go ahead, I\'m listening');
    _startListenTurn();
    return;
  }

  _setState('thinking', 'Thinking…', 'Odysseus is composing a reply');
  const sent = _sendMessage(text);
  if (!sent) { _fail('Could not send the message.'); return; }

  await _waitForReplyAndSpeech();
  if (!_active) return;
  _startListenTurn();
}

async function _transcribe(blob) {
  const fd = new FormData();
  fd.append('file', blob, 'voice-turn.webm');
  const res = await fetch('/api/stt/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    body: fd,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || ('STT ' + res.status));
  }
  const data = await res.json();
  return data.text || '';
}

function _sendMessage(text) {
  const input = document.getElementById('message');
  const form = document.getElementById('chat-form');
  if (!input || !form) return false;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (form.requestSubmit) form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
}

// Wait for the reply to finish generating AND finish being spoken, then return.
async function _waitForReplyAndSpeech() {
  // Phase 1: let generation start (busy flips true). If it never does within
  // the window, fall through — we'll still gate on idle below.
  await _waitUntil(() => _chatGenBusy(), 10000);

  // While the model is generating, reflect that; once TTS begins, show speaking.
  const stateWatch = setInterval(() => {
    if (!_active) return;
    if (_ttsBusy()) { if (_state !== 'speaking') _setState('speaking', 'Speaking…', 'Reply is playing — Skip to jump in'); }
    else if (_chatGenBusy() && _state !== 'thinking') { _setState('thinking', 'Thinking…', 'Odysseus is composing a reply'); }
  }, 250);

  // Phase 2: require both generation and TTS idle, stable across a few polls so
  // we don't re-listen in a momentary gap between streamed sentences.
  let stable = 0;
  const NEEDED = 4;         // ~4 * 150ms = 600ms of continuous quiet
  const started = Date.now();
  const MAX = 6 * 60 * 1000;
  while (_active && Date.now() - started < MAX) {
    if (!_chatGenBusy() && !_ttsBusy()) {
      if (++stable >= NEEDED) break;
    } else {
      stable = 0;
    }
    await _sleep(150);
  }
  clearInterval(stateWatch);
}

// "Skip": stop the assistant speaking and jump straight back to listening.
function _skipSpeaking() {
  if (!_active) return;
  try { if (window.aiTTSManager) window.aiTTSManager.stop(); } catch (e) { /* ignore */ }
  // If we're mid wait-for-speech, breaking TTS busy will let the loop fall
  // through to _startListenTurn on its own. If we're already idle, kick it.
  if (_state === 'speaking') _setState('thinking', 'One sec…', '');
}

function _fail(msg) {
  _toast(msg);
  exit();
}

// ── enter / exit ───────────────────────────────────────────────────────────

async function enter() {
  if (_active) return;

  if (!window.isSecureContext) {
    _toast('Voice conversation needs HTTPS (or localhost) for the mic.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    _toast('Microphone not supported in this browser.');
    return;
  }
  // TTS must be available or there's nothing to "converse" with.
  const mgr = window.aiTTSManager;
  if (!mgr || !mgr.available || mgr._provider === 'disabled') {
    _toast('Enable Text-to-Speech first (Settings → it powers spoken replies).');
    return;
  }
  // STT must be configured server-side.
  try {
    const r = await fetch('/api/stt/stats', { credentials: 'same-origin' });
    const st = r.ok ? await r.json() : {};
    if (!st.provider || st.provider === 'disabled') {
      _toast('Enable Speech-to-Text first (Settings → Voice).');
      return;
    }
  } catch (e) { /* proceed; transcribe will error visibly if it's really off */ }

  _active = true;
  _syncToggleBtn(true);
  _ensureStyles();
  _showOverlay();
  _setState('thinking', 'Starting…', 'Requesting microphone');

  try {
    _stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    _active = false;
    _syncToggleBtn(false);
    _hideOverlay();
    _toast(e && e.name === 'NotAllowedError'
      ? 'Microphone access denied. Check browser permissions.'
      : 'Could not open the microphone.');
    return;
  }

  // Persistent analyser for VAD (not connected to output — no feedback).
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    _audioCtx = new AC();
    _source = _audioCtx.createMediaStreamSource(_stream);
    _analyser = _audioCtx.createAnalyser();
    _analyser.fftSize = 1024;
    _analyser.smoothingTimeConstant = 0.4;
    _source.connect(_analyser);
  } catch (e) {
    _fail('Audio analysis unavailable.');
    return;
  }

  // Force auto-speak on for the session; restore prior preference on exit.
  _prevAutoPlay = !!mgr.autoPlay;
  mgr.autoPlay = true;

  await _calibrate();
  if (!_active) return;
  _startListenTurn();
}

// Sample ambient noise briefly and lift the speech threshold above it.
async function _calibrate() {
  try {
    const buf = new Uint8Array(_analyser.fftSize);
    let peak = 0;
    const start = Date.now();
    while (Date.now() - start < 400) {
      _analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
      peak = Math.max(peak, Math.sqrt(sum / buf.length));
      await _sleep(40);
    }
    // Speech should sit comfortably above the room floor.
    VAD.threshold = Math.max(0.02, peak * 2.5 + 0.006);
  } catch (e) { /* keep default */ }
}

function exit() {
  if (!_active && !_stream) { _hideOverlay(); _syncToggleBtn(false); return; }
  _active = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  try { if (_recorder && _recorder.state === 'recording') _recorder.stop(); } catch (e) { /* ignore */ }
  _recorder = null;
  try { if (window.aiTTSManager) window.aiTTSManager.stop(); } catch (e) { /* ignore */ }
  try { if (_source) _source.disconnect(); } catch (e) { /* ignore */ }
  _source = null; _analyser = null;
  try { if (_audioCtx) _audioCtx.close(); } catch (e) { /* ignore */ }
  _audioCtx = null;
  try { if (_stream) _stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
  _stream = null;
  // Restore the user's Auto-speak preference.
  try { if (window.aiTTSManager) window.aiTTSManager.autoPlay = _prevAutoPlay; } catch (e) { /* ignore */ }
  _setState('idle');
  _hideOverlay();
  _syncToggleBtn(false);
}

function toggle() { if (_active) exit(); else enter(); }
function isActive() { return _active; }

function _syncToggleBtn(on) {
  const btn = document.getElementById('voice-convo-btn');
  if (!btn) return;
  btn.classList.toggle('active', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function _toast(msg) {
  try {
    if (window.uiModule && window.uiModule.showToast) { window.uiModule.showToast(msg); return; }
  } catch (e) { /* ignore */ }
  console.warn('[voiceConvo]', msg);
}

// ── init / wiring ──────────────────────────────────────────────────────────

function init() {
  const btn = document.getElementById('voice-convo-btn');
  if (btn && !btn._convoBound) {
    btn._convoBound = true;
    btn.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
  }
  // Escape ends the conversation.
  if (!window._voiceConvoKeyBound) {
    window._voiceConvoKeyBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _active) { e.preventDefault(); exit(); }
    });
  }
  // Clean up if the tab is closed mid-conversation.
  window.addEventListener('beforeunload', () => { if (_active) exit(); });
}

const voiceConversationModule = { init, toggle, enter, exit, isActive };
try { window.voiceConversation = voiceConversationModule; } catch (e) { /* ignore */ }

export { init, toggle, enter, exit, isActive };
export default voiceConversationModule;
