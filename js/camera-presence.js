// camera-presence.js — webcam presence + mood detection (LOCAL, browser-only)
// No frames leave the device. Uses transformers.js (Xenova/facial_emotions_image_detection).
// Exposes window.cameraPresence = { start, stop, isRunning }.
// Talks to the brain via window.__agent.setPresence(present) and setCameraMood(mood).

// Map the model's 7 labels -> agent mood vocabulary (marah/sedih/senang/kaget/normal).
const MOOD_MAP = {
  angry: 'marah',
  sad: 'sedih',
  happy: 'senang',
  surprise: 'kaget',
  fear: 'sedih',
  disgust: 'normal',
  neutral: 'normal',
};

let running = false;
let stream = null;
let video = null;
let canvas = null;
let ctx = null;
let classifier = null;
let loopTimer = null;

let cfg = { fps: 0.4, presenceThreshold: 0.4, device: 'webgpu', model: 'Xenova/facial_emotions_image_detection', awayHiddenMs: 10000 };

let lowStreak = 0;          // consecutive low-confidence intervals (no face)
let lastMood = 'normal';    // last camera mood we reported
let lastMoodAt = 0;         // timestamp of last mood report (debounce)
let lastPresence = null;    // last presence boolean we sent
let startedAt = 0;          // kapan kamera mulai (grace period)
let lastRawMood = 'normal'; // mood mentah tick terakhir (stability check)
let moodSameCount = 0;      // berapa tick berturut-turut mood sama
const MOOD_GRACE_MS = 20000; // gak langsung merespons pas kamera baru nyala

function getAgent() { return window.__agent; }

function sendPresence(p) {
  if (p === lastPresence) return;
  lastPresence = p;
  const a = getAgent();
  if (a && a.setPresence) a.setPresence(p);
}

function sendMood(m) {
  // Grace period: jangan langsung merespons pas kamera baru dinyalakan
  if (Date.now() - startedAt < MOOD_GRACE_MS) return;
  const now = Date.now();
  if (m === lastMood) return;
  // debounce: only react on change, and at most once per 5s
  if (now - lastMoodAt < 5000) return;
  lastMood = m;
  lastMoodAt = now;
  const a = getAgent();
  if (a && a.setCameraMood) a.setCameraMood(m);
}

async function webgpuReady() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) {
    return false;
  }
}

async function loadClassifier() {
  const tf = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers');
  const { pipeline, env } = tf;
  // Model diambil dari CDN, jangan coba fetch lokal.
  env.allowLocalModels = false;

  const attempts = [];
  if (cfg.device === 'webgpu' && await webgpuReady()) {
    attempts.push({ device: 'webgpu', dtype: 'q4' });
  }
  attempts.push({ device: 'wasm' }); // fallback universal (CPU)

  let lastErr;
  for (const opts of attempts) {
    try {
      console.log('[camera] loading emotion model with', opts);
      return await pipeline('image-classification', cfg.model, opts);
    } catch (e) {
      lastErr = e;
      console.warn('[camera] gagal load dengan', opts, '->', e && e.message);
    }
  }
  throw lastErr || new Error('gagal memuat model emotion (webgpu & wasm gagal)');
}

async function tick() {
  if (!running || !classifier || !video || video.readyState < 2) return;
  try {
    const w = video.videoWidth || 320;
    const h = video.videoHeight || 240;
    const s = Math.min(w, h);
    const sx = (w - s) / 2, sy = (h - s) / 2;
    canvas.width = 224; canvas.height = 224;
    ctx.drawImage(video, sx, sy, s, s, 0, 0, 224, 224);

    const out = await classifier(canvas);
    if (!out || !out.length) return;
    const top = out[0]; // { label, score }
    const score = typeof top.score === 'number' ? top.score : (top.score && top.score[0]) || 0;
    const label = (top.label || '').toLowerCase();

    console.log('[camera]', label, score.toFixed(3));

    // Presence: confident face detected?
    if (score >= cfg.presenceThreshold) {
      lowStreak = 0;
      sendPresence(true);
      const mood = MOOD_MAP[label] || 'normal';
      // butuh 2 tick berturut-turut mood sama sebelum trigger (anti flaky / bertubi-tubi)
      if (mood !== lastRawMood) { lastRawMood = mood; moodSameCount = 1; }
      else moodSameCount++;
      if (moodSameCount >= 2) sendMood(mood);
    } else {
      lowStreak++;
      lastRawMood = 'normal'; moodSameCount = 0;
      const intervalMs = 1000 / cfg.fps;
      if (lowStreak * intervalMs >= cfg.awayHiddenMs) {
        sendPresence(false);
      }
    }
  } catch (e) {
    console.warn('[camera] tick error:', e.message);
  }
}

async function start(userCfg) {
  if (running) return;
  if (userCfg) cfg = Object.assign(cfg, userCfg);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('browser tidak mendukung getUserMedia');
  }

  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });

  video = document.createElement('video');
  video.autoplay = true; video.muted = true; video.playsInline = true;
  video.style.display = 'none';
  video.srcObject = stream;
  document.body.appendChild(video);
  await video.play().catch(() => {});

  canvas = document.createElement('canvas');
  canvas.style.display = 'none';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d', { willReadFrequently: true });

  classifier = await loadClassifier();

  running = true;
  window.__cameraActive = true;
  lastPresence = null; lastMood = 'normal'; lowStreak = 0;
  startedAt = Date.now(); lastRawMood = 'normal'; moodSameCount = 0;

  const intervalMs = 1000 / cfg.fps;
  loopTimer = setInterval(tick, intervalMs);
  console.log('[camera] started, inferencing every', intervalMs, 'ms');
}

function stop() {
  running = false;
  window.__cameraActive = false;
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (video && video.parentNode) video.parentNode.removeChild(video);
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  video = canvas = ctx = classifier = null;
  // tell brain we no longer know presence -> let fallback (visibility) take over
  const a = getAgent();
  if (a && a.setPresence) a.setPresence(null);
  lastPresence = null;
  console.log('[camera] stopped');
}

window.cameraPresence = { start, stop, isRunning: () => running };
