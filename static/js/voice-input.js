// voice-input.js — STT dua arah (push-to-talk), 100% LOKAL di browser.
// Audio TIDAK PERNAH di-upload ke server mana pun — sama dengan keputusan
// terkunci kamera (lihat docs/SHEET-SYSTEM.md §agen reaktif). Whisper
// (transformers.js) diunduh sekali dari CDN lalu di-cache browser.
//
// Pola mengikuti camera-presence.js:
//   - modul ES mandiri, self-wire ke elemen UI yang sudah ada (#btn-mic)
//   - konfigurasi diambil dari /api/config (section `stt`) saat pertama dipakai
//   - device webgpu → fallback wasm
//   - cleanup disiplin: setiap jalur gagal melepas mic
//
// Antisipasi echo: merekam DITOLAK saat karakter sedang bicara TTS
// (window.__l2dDebug.state.talking) — kalau tidak, Whisper mentranskripsi
// suara karakter sendiri dan dia mengobrol dengan dirinya sendiri.
//
// Exposes window.voiceInput = { toggle, isRecording, isBusy }.

const DEFAULTS = {
  model: 'Xenova/whisper-base',
  language: 'indonesian',   // 'auto' → biar Whisper deteksi sendiri
  autoSend: true,           // langsung kirim setelah transkrip (false = isi input saja)
  silenceMs: 1500,          // berhenti otomatis setelah sekian ms senyap
  maxMs: 30000,             // batas keras durasi rekaman
  vadThreshold: 0.015,      // RMS di atas ini dianggap "ada suara"
};

let cfg = { ...DEFAULTS };
let cfgLoaded = false;

let asr = null;             // pipeline STT (lazy, sekali)
let asrLoading = null;      // promise pemuatan (anti double-load)
let recording = false;
let busy = false;           // true saat transkripsi (tombol dikunci)
let stream = null;
let recorder = null;
let audioCtx = null;
let analyser = null;
let monitorTimer = null;
let chunks = [];
let lastVoiceAt = 0;
let startedAt = 0;
let spokeOnce = false;

const btn = () => document.getElementById('btn-mic');
const input = () => document.getElementById('bubble-input');

function setStatus(text) {
  const el = input();
  if (el) el.placeholder = text || 'Ketik pesan lalu Enter...';
  const b = btn();
  if (b) b.title = text || 'Voice: bicara lalu kirim (klik lagi untuk berhenti)';
}

function setRecordingUI(on) {
  const b = btn();
  if (b) b.classList.toggle('recording', on);
}

// ── pure helpers (diuji di test/voice-input.test.ts) ─────────────
export function rms(buf) {
  if (!buf || !buf.length) return 0;
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// Linear resampler ke 16 kHz mono — Whisper butuh 16k. Dibuat murni supaya
// bisa diuji di bun dan supaya berjalan di browser yang menolak
// AudioContext({sampleRate:16000}) (mis. beberapa versi Safari).
export function resampleTo16k(f32, srcRate) {
  const dst = 16000;
  if (!f32 || !f32.length || !srcRate || srcRate === dst) return f32 instanceof Float32Array ? f32 : new Float32Array(f32 || []);
  const ratio = srcRate / dst;
  const outLen = Math.max(1, Math.floor(f32.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(f32.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = f32[i0] * (1 - frac) + f32[i1] * frac;
  }
  return out;
}

// Keputusan auto-stop: berhenti bila sudah pernah ada suara lalu senyap
// selama silenceMs, ATAU durasi total melampaui maxMs (jaring pengaman).
export function shouldAutoStop(now, { spokeOnce: spoke, lastVoiceAt: lv, startedAt: st, silenceMs, maxMs }) {
  if (spoke && now - lv >= silenceMs) return 'silence';
  if (now - st >= maxMs) return 'max';
  return null;
}

// ── config ───────────────────────────────────────────────────────
async function ensureConfig() {
  if (cfgLoaded) return;
  try {
    const resp = await fetch('/api/config');
    if (resp.ok) {
      const c = await resp.json();
      if (c && c.stt && typeof c.stt === 'object') cfg = Object.assign({ ...DEFAULTS }, c.stt);
    }
  } catch (e) { /* offline config → pakai default */ }
  cfgLoaded = true;
}

// ── model ────────────────────────────────────────────────────────
async function webgpuReady() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  try { return !!(await navigator.gpu.requestAdapter()); } catch { return false; }
}

async function loadASR() {
  if (asr) return asr;
  if (asrLoading) return asrLoading;
  asrLoading = (async () => {
    const tf = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers');
    const { pipeline, env } = tf;
    env.allowLocalModels = false;   // model diambil dari CDN
    const attempts = [];
    if (cfg.device !== 'wasm' && await webgpuReady()) {
      // Konfigurasi Whisper-webgpu yang direkomendasikan HF: encoder fp32,
      // decoder merged q4 — ukuran turun drastis tanpa merusak akurasi.
      attempts.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
    }
    attempts.push({ device: 'wasm', dtype: 'q8' });   // fallback universal
    let lastErr;
    for (const opts of attempts) {
      try {
        console.log('[voice] loading STT model', cfg.model, 'with', opts.device);
        return await pipeline('automatic-speech-recognition', cfg.model, opts);
      } catch (e) {
        lastErr = e;
        console.warn('[voice] gagal load dengan', opts.device, '->', e && e.message);
      }
    }
    throw lastErr || new Error('gagal memuat model STT');
  })();
  try {
    asr = await asrLoading;
    return asr;
  } finally {
    asrLoading = null;
  }
}

// ── recording ────────────────────────────────────────────────────
async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('browser tidak mendukung getUserMedia');
  }
  // Echo guard: jangan tumpuk suara karakter ke dalam perekaman.
  const dbg = window.__l2dDebug;
  if (dbg && dbg.state && dbg.state.talking) {
    throw new Error('karakter sedang bicara — tunggu sampai selesai dulu');
  }

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];
  spokeOnce = false;
  startedAt = Date.now();
  lastVoiceAt = startedAt;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);

  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => { transcribeAndSend().catch((e) => fail(e)); };
  recorder.start(250);

  recording = true;
  setRecordingUI(true);
  setStatus('🎤 mendengarkan... (klik lagi untuk berhenti)');

  // Monitor senyap: rantai setTimeout (bukan interval) supaya tidak menumpuk.
  const buf = new Float32Array(analyser.fftSize);
  const monitor = () => {
    if (!recording || !analyser) return;
    analyser.getFloatTimeDomainData(buf);
    if (rms(buf) > cfg.vadThreshold) { lastVoiceAt = Date.now(); spokeOnce = true; }
    const why = shouldAutoStop(Date.now(), { spokeOnce, lastVoiceAt, startedAt, silenceMs: cfg.silenceMs, maxMs: cfg.maxMs });
    if (why) { stopRecording(); return; }
    monitorTimer = setTimeout(monitor, 100);
  };
  monitorTimer = setTimeout(monitor, 100);
}

function stopRecording() {
  if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
  recording = false;
  setRecordingUI(false);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (analyser) { analyser = null; }
}

function releaseAll() {
  stopRecording();
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
  chunks = [];
}

function fail(e) {
  console.warn('[voice]', e && e.message);
  releaseAll();
  busy = false;
  setStatus('⚠️ ' + (e && e.message ? e.message : 'gagal'));
  setTimeout(() => setStatus(''), 4000);
  syncButtonState();
}

async function transcribeAndSend() {
  busy = true;
  syncButtonState();
  setStatus('⏳ mentranskripsi...');
  try {
    const blob = new Blob(chunks, { type: recorder && recorder.mimeType || 'audio/webm' });
    const buf = await blob.arrayBuffer();
    // Context 16k bila didukung; kalau tidak, decode default + resample manual.
    let f32;
    try {
      const ctx16 = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioCtx = ctx16;
      const decoded = await ctx16.decodeAudioData(buf);
      f32 = decoded.getChannelData(0);
    } catch {
      const ctxAny = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx = ctxAny;
      const decoded = await ctxAny.decodeAudioData(buf);
      f32 = resampleTo16k(decoded.getChannelData(0), decoded.sampleRate);
    }
    const model = await loadASR();
    const genOpts = { chunk_length_s: 30, stride_length_s: 5 };
    if (cfg.language && cfg.language !== 'auto') { genOpts.language = cfg.language; genOpts.task = 'transcribe'; }
    const out = await model(f32, genOpts);
    const text = String((out && out.text) || '').trim();
    console.log('[voice] transkrip:', JSON.stringify(text));

    const inp = input();
    if (text && inp) {
      inp.value = text;
      if (cfg.autoSend) {
        const send = document.getElementById('btn-bubble');
        if (send) send.click();               // jalur kirim milik app.js — tanpa duplikasi
      } else {
        setStatus('teks siap — Enter untuk kirim');
        inp.focus();
      }
    } else {
      setStatus('tidak ada ucapan terdeteksi');
      setTimeout(() => setStatus(''), 2500);
    }
  } finally {
    releaseAll();
    busy = false;
    if (!cfg.autoSend) setTimeout(() => setStatus(''), 6000);
    else setTimeout(() => setStatus(''), 1500);
    syncButtonState();
  }
}

// ── public API + self-wiring ─────────────────────────────────────
export function toggle() {
  if (busy) return;                       // transkripsi berjalan — tombol dikunci
  if (recording) { stopRecording(); return; }
  ensureConfig()
    .then(() => startRecording())
    .catch((e) => fail(e));
}
export function isRecording() { return recording; }
export function isBusy() { return busy; }

function syncButtonState() {
  const b = btn();
  if (!b) return;
  b.disabled = false;                     // layak pakai — nyalakan permanen
  b.classList.toggle('busy', busy);
}

if (typeof document !== 'undefined') {
  const init = () => {
    const b = btn();
    if (!b) return;
    syncButtonState();
    b.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    window.addEventListener('beforeunload', releaseAll);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

if (typeof window !== 'undefined') {
  window.voiceInput = { toggle, isRecording, isBusy };
}
