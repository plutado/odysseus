// static/js/voiceRecorder.js

/**
 * Voice recording with optional Speech-to-Text transcription.
 *
 * STT providers:
 *   "disabled"       — record audio as file attachment (original behavior)
 *   "browser"        — use Web Speech API for real-time transcription
 *   "local"          — send recording to server /api/stt/transcribe (Whisper)
 *   "endpoint:<id>"  — send recording to server /api/stt/transcribe (API)
 */

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingInterval = null;
let _meterCtx = null, _meterRAF = 0, _meterSource = null;

// Browser STT state
let _recognition = null;
let _browserTranscript = '';

// Cached STT provider — refreshed on settings change
let _sttProvider = 'disabled';

/**
 * Fetch current STT provider from server settings
 */
async function refreshSttProvider() {
  try {
    const res = await fetch('/api/stt/stats', { credentials: 'same-origin' });
    if (res.ok) {
      const stats = await res.json();
      _sttProvider = stats.provider || 'disabled';
      // Notify the send button to update its icon
      if (window._updateSendBtnIcon) window._updateSendBtnIcon();
    }
  } catch (e) {
    console.warn('Failed to fetch STT stats:', e);
  }
}

/**
 * Format seconds as MM:SS
 */
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

/**
 * Recording indicator: red pulsing dot + "Recording" + live MM:SS timer + Stop.
 * Injected once; shown while recording so it's never ambiguous that the mic is live.
 */
function _ensureIndicatorStyles() {
  if (document.getElementById('voice-rec-styles')) return;
  const s = document.createElement('style');
  s.id = 'voice-rec-styles';
  s.textContent = `
    .voice-rec-indicator {
      position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px;
      background: var(--panel, #161b22); color: var(--fg, #c9d1d9);
      border: 1px solid var(--border, #30363d); border-radius: 999px;
      padding: 8px 14px; box-shadow: 0 6px 24px rgba(0,0,0,0.35);
      font-size: 13px; z-index: 9999; user-select: none;
    }
    /* Pulsing mic orb — same visual language as Voice Conversation Mode, so
       "audio is being captured" always looks the same. Level-reactive: the
       glow scales with the live mic RMS (see _startMeter). */
    .voice-rec-orb { position: relative; width: 26px; height: 26px; border-radius: 50%;
      flex-shrink: 0; display: grid; place-items: center;
      background: color-mix(in srgb, var(--color-recording, #ff3b30) 24%, transparent); }
    .voice-rec-orb svg { width: 13px; height: 13px; color: var(--color-recording, #ff3b30); z-index: 1; }
    .voice-rec-orb::after { content: ''; position: absolute; inset: 0; border-radius: 50%;
      background: var(--color-recording, #ff3b30); opacity: 0.35;
      transform: scale(var(--orb-level, 0.3)); transition: transform 0.08s linear; }
    .voice-rec-label { opacity: 0.8; }
    .voice-rec-time { font-variant-numeric: tabular-nums; font-weight: 600;
      letter-spacing: 0.5px; min-width: 42px; }
    .voice-rec-stop { display: inline-flex; align-items: center; gap: 6px;
      margin-left: 4px; padding: 4px 12px; border-radius: 999px; cursor: pointer;
      background: var(--color-recording, #ff3b30); color: #fff; border: none;
      font-size: 12px; font-weight: 600; }
    .voice-rec-stop:hover { background: var(--color-recording-hover, #d63031); }
    .voice-rec-stop svg { width: 11px; height: 11px; }
  `;
  document.head.appendChild(s);
}

function _tickTimer() {
  const el = document.getElementById('voice-rec-time');
  if (!el || !recordingStartTime) return;
  const secs = Math.floor((Date.now() - recordingStartTime.getTime()) / 1000);
  el.textContent = formatTime(secs);
}

function _showRecordingIndicator(stream) {
  _ensureIndicatorStyles();
  _hideRecordingIndicator(); // guard against duplicates
  const bar = document.createElement('div');
  bar.className = 'voice-rec-indicator';
  bar.id = 'voice-rec-indicator';
  bar.innerHTML =
    '<span class="voice-rec-orb" id="voice-rec-orb">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
    '</span>' +
    '<span class="voice-rec-label">Recording</span>' +
    '<span class="voice-rec-time" id="voice-rec-time">00:00</span>' +
    '<button type="button" class="voice-rec-stop" id="voice-rec-stop" title="Stop recording">' +
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop</button>';
  document.body.appendChild(bar);
  const stopBtn = document.getElementById('voice-rec-stop');
  if (stopBtn) stopBtn.addEventListener('click', () => stopRecording());
  _tickTimer();
  if (recordingInterval) clearInterval(recordingInterval);
  recordingInterval = setInterval(_tickTimer, 1000);
  _startMeter(stream);
}

function _hideRecordingIndicator() {
  _stopMeter();
  const bar = document.getElementById('voice-rec-indicator');
  if (bar) bar.remove();
}

/**
 * Live audio-level orb: analyses the mic stream and scales the orb's glow with
 * the current RMS amplitude (same visual as Voice Conversation Mode). The
 * analyser is not connected to the output, so there's no feedback/playback.
 */
function _startMeter(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream) return;
    _meterCtx = new AC();
    _meterSource = _meterCtx.createMediaStreamSource(stream);
    const analyser = _meterCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    _meterSource.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const orb = document.getElementById('voice-rec-orb');
    const draw = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / buf.length);
      // Map RMS to a visible glow scale, matching the conversation orb.
      const level = Math.min(1.4, 0.3 + rms * 9);
      if (orb) orb.style.setProperty('--orb-level', level.toFixed(2));
      _meterRAF = requestAnimationFrame(draw);
    };
    draw();
  } catch (e) {
    console.warn('Level meter unavailable:', e);
  }
}

function _stopMeter() {
  if (_meterRAF) { cancelAnimationFrame(_meterRAF); _meterRAF = 0; }
  try { if (_meterSource) _meterSource.disconnect(); } catch (e) { /* ignore */ }
  _meterSource = null;
  if (_meterCtx) { try { _meterCtx.close(); } catch (e) { /* ignore */ } _meterCtx = null; }
}

/**
 * Reset UI state after recording ends
 */
function _resetRecordingUI() {
  isRecording = false;
  _hideRecordingIndicator();
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  // Reset send button via global callback
  const sendBtn = document.querySelector('.send-btn');
  if (sendBtn) {
    sendBtn.classList.remove('recording');
    sendBtn.dataset.mode = '';
  }
  if (window._updateSendBtnIcon) {
    setTimeout(window._updateSendBtnIcon, 50);
  }
}

/**
 * Start browser speech recognition alongside recording
 */
function startBrowserSTT() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  _browserTranscript = '';
  _recognition = new SpeechRecognition();
  _recognition.continuous = true;
  _recognition.interimResults = false;
  _recognition.lang = '';

  _recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        _browserTranscript += event.results[i][0].transcript + ' ';
      }
    }
  };

  _recognition.onerror = (e) => {
    console.warn('Browser STT error:', e.error);
  };

  _recognition.start();
}

function stopBrowserSTT() {
  if (_recognition) {
    try { _recognition.stop(); } catch (e) { /* ignore */ }
    _recognition = null;
  }
  return _browserTranscript.trim();
}

/**
 * Send audio to server for transcription
 */
async function transcribeOnServer(audioBlob) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');

  const res = await fetch('/api/stt/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || 'Transcription failed');
  }

  const data = await res.json();
  return data.text || '';
}

/**
 * Insert transcribed text into the chat input
 */
function insertTranscription(text, showToast) {
  if (!text) return;
  const input = document.getElementById('message');
  if (!input) return;

  const existing = input.value.trim();
  input.value = existing ? existing + ' ' + text : text;

  // Trigger auto-resize and icon update
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();

  if (showToast) showToast('Transcribed');
}

/**
 * Start voice recording
 */
export function startRecording(onFileCreated, showToast, showError) {
  // Check for secure context (getUserMedia requires HTTPS or localhost)
  if (!window.isSecureContext) {
    if (showError) showError('Microphone requires HTTPS. Use a reverse proxy with SSL or access via localhost.');
    _resetRecordingUI();
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (showError) showError('Microphone not supported in this browser.');
    _resetRecordingUI();
    return;
  }

  audioChunks = [];

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());

        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const provider = _sttProvider;

        if (provider === 'browser') {
          const transcript = stopBrowserSTT();
          if (transcript) {
            insertTranscription(transcript, showToast);
          } else {
            if (showToast) showToast('No speech detected');
            const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
            if (onFileCreated) onFileCreated(audioFile);
          }
        } else if (provider === 'local' || provider.startsWith('endpoint:')) {
          // Show "Transcribing..." feedback
          if (showToast) showToast('Transcribing...', 5000);
          try {
            const transcript = await transcribeOnServer(audioBlob);
            if (transcript) {
              insertTranscription(transcript, showToast);
            } else {
              if (showToast) showToast('No speech detected');
            }
          } catch (e) {
            console.error('STT transcription error:', e);
            if (showError) showError('Transcription failed: ' + e.message);
            // Fallback: attach as file
            const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
            if (onFileCreated) onFileCreated(audioFile);
          }
        } else {
          // STT disabled — attach audio file
          const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
          if (onFileCreated) onFileCreated(audioFile);
        }

        _resetRecordingUI();
      };

      mediaRecorder.start();
      isRecording = true;
      recordingStartTime = new Date();
      _showRecordingIndicator(stream);

      // Start browser STT if that's the provider
      if (_sttProvider === 'browser') {
        startBrowserSTT();
      }

      if (showToast) {
        showToast('Recording...');
      }
    })
    .catch(error => {
      console.error('Microphone access error:', error);
      if (showError) {
        if (error.name === 'NotAllowedError') {
          showError('Microphone access denied. Check browser permissions.');
        } else if (error.name === 'NotFoundError') {
          showError('No microphone found.');
        } else {
          showError('Microphone error: ' + error.message);
        }
      }
      _resetRecordingUI();
    });
}

/**
 * Stop voice recording
 */
export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    // isRecording will be set to false in _resetRecordingUI called from onstop
  } else {
    _resetRecordingUI();
  }
}

/**
 * Check if currently recording
 */
export function getIsRecording() {
  return isRecording;
}

/**
 * Initialize recording state
 */
export function init() {
  isRecording = false;
  refreshSttProvider();
}

const voiceRecorderModule = {
  startRecording,
  stopRecording,
  getIsRecording,
  init,
  refreshSttProvider,
  get _sttProvider() { return _sttProvider; },
  set _sttProvider(v) { _sttProvider = v; },
};

export default voiceRecorderModule;
