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
    .voice-rec-dot { width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0;
      background: var(--color-recording, #ff3b30);
      animation: voiceRecPulse 1.1s ease-in-out infinite; }
    .voice-rec-label { opacity: 0.8; }
    .voice-rec-meter { display: inline-flex; align-items: flex-end; gap: 2px;
      height: 18px; margin: 0 2px; }
    .voice-rec-bar { width: 3px; height: 3px; border-radius: 2px;
      background: color-mix(in srgb, var(--fg, #c9d1d9) 60%, transparent);
      transition: height 0.07s linear; }
    .voice-rec-time { font-variant-numeric: tabular-nums; font-weight: 600;
      letter-spacing: 0.5px; min-width: 42px; }
    .voice-rec-stop { display: inline-flex; align-items: center; gap: 6px;
      margin-left: 4px; padding: 4px 12px; border-radius: 999px; cursor: pointer;
      background: var(--color-recording, #ff3b30); color: #fff; border: none;
      font-size: 12px; font-weight: 600; }
    .voice-rec-stop:hover { background: var(--color-recording-hover, #d63031); }
    .voice-rec-stop svg { width: 11px; height: 11px; }
    @keyframes voiceRecPulse { 0%,100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.35; transform: scale(0.8); } }
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
    '<span class="voice-rec-dot"></span>' +
    '<span class="voice-rec-label">Recording</span>' +
    '<span class="voice-rec-meter" id="voice-rec-meter">' +
      '<i class="voice-rec-bar"></i>'.repeat(5) +
    '</span>' +
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
 * Live audio-level meter: analyses the mic stream and drives the bar heights.
 * The analyser is not connected to the output, so there's no feedback/playback.
 */
function _startMeter(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream) return;
    _meterCtx = new AC();
    _meterSource = _meterCtx.createMediaStreamSource(stream);
    const analyser = _meterCtx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.7;
    _meterSource.connect(analyser);
    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    // Skip the lowest bins (DC offset + low-frequency rumble) — they always read
    // hot and would otherwise pin the first bar high regardless of speech.
    const LOW = 2;
    const usable = Math.max(1, bins - LOW);
    const bars = Array.prototype.slice.call(document.querySelectorAll('#voice-rec-meter .voice-rec-bar'));
    const draw = () => {
      analyser.getByteFrequencyData(data);
      for (let i = 0; i < bars.length; i++) {
        const start = LOW + Math.floor((i / bars.length) * usable);
        const end = Math.max(start + 1, LOW + Math.floor(((i + 1) / bars.length) * usable));
        let sum = 0;
        for (let j = start; j < end; j++) sum += data[j];
        const v = sum / (end - start);            // 0..255
        bars[i].style.height = (3 + (v / 255) * 15).toFixed(1) + 'px';
      }
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
