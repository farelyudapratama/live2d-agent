# PLAN: Live2D Agent — Event-Driven + Camera Reactive (Voice Clone ID)

## 1. Tujuan
Bikin Live2D agent yang tidak cuma nunggu user ngetik, tapi **reaktif terhadap kejadian**:
- `idle`  (user diam tapi ada di depan kamera)
- `away`  (user pergi / tab hidden / kamera gak lihat wajah)
- `return`(user balik)
- `mood`  (deteksi emosi user dari **wajah webcam** + teks ketikan)

Semua reaksi diucapkan pakai **suara clone** (Chatterbox TTS di Colab, endpoint dari `config.json`).

## 2. Keputusan Terkunci (locked)
- Kamera = **opt-in toggle**, default MATI. Ada checkbox di UI; klik → minta izin.
- Ekspresi wajah user → **input mood** (tahu user sedih/marah/dll) + **trigger reaksi karakter**
  (contoh: "jangan sedih", "kamu kenapa?", "kalau kamu sedih aku juga sedih nih") + **persist** ke balasan berikutnya.
  BUKAN mirror ekspresi tiap frame.
- Mood = gabungan **kamera (wajah)** + **teks** (ketikan).
- Idle = wajah ada tapi diam. Away = kamera gak lihat wajah / tab hidden. Return = wajah muncul lagi.
- Inferensi kamera **lokal di browser** (transformers.js, WebGPU/WASM) → frame tidak pernah di-upload.

## 3. Arsitektur (alur)
```
[webcam] --frame--> camera-presence.js --(throttle 0.4 fps)-->
   transformers.js (Xenova/facial_emotions_image_detection)
        |
        +--> setPresence(present)       --> agent.reactEvent('user_left'|'user_returned')
        +--> setCameraMood(label)       --> agent.setUserMood + reactEvent('mood:...')
                                               |
[user ketik] --> app.sendBubble --> classifyMood(text) --> setUserMood (gabung)
[diam 60s & presence] --> idle timer --> reactEvent('idle')
                                               v
                                   agent.reactEvent()
                                       build clientSystem (event + mood)
                                       -> POST /api/chat {system, user: synthetic}
                                       -> speakSegments() -> TTS clone
```

## 4. Skema config.json (tambahan)
```json
{
  "activeId": "...",
  "connections": [ ... ],
  "tts": { "endpoint": "https://xxxx.gradio.live" },
  "events": {
    "idleSpeak": true,
    "idleMs": 60000,
    "idleRepeatMs": 90000,
    "awaySpeak": true,
    "returnSpeak": true,
    "awayHiddenMs": 10000
  },
  "camera": {
    "enabled": false,
    "fps": 0.4,
    "presenceThreshold": 0.4,
    "device": "webgpu",
    "model": "Xenova/facial_emotions_image_detection",
    "mirror": false
  }
}
```

## 5. File Baru: js/camera-presence.js (ESM module)
- Import: `import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers'`
- `start()`: `navigator.mediaDevices.getUserMedia({video:{width:320,height:240}})`
  → `<video>` (muted, autoplay, hidden) + offscreen `<canvas>` 224x224.
- Load classifier: `pipeline('image-classification', model, { device: cfg.device, dtype:'q4' })`.
- Loop (`setInterval`, `1/fps` detik):
  - draw video frame ke canvas (crop center square).
  - `const out = await classifier(canvas)` -> top `{label, score}`.
  - **Presence**: score >= `presenceThreshold` -> `window.__agent.setPresence(true)`.
    Jika < threshold terus-menerus selama `awayHiddenMs` -> `setPresence(false)`.
  - **Mood**: debounce — hanya panggil `setCameraMood(map(label))` kalau label berubah
    & jeda > 5 dtk. Map: angry->marah, sad->sedih, happy->senang, surprise->kaget,
    fear->sedih, disgust->normal, neutral->normal.
- `stop()`: cancel interval, `track.stop()`, reset presence.
- Handle: izin ditolak -> `console.warn` + panggil `window.__agent.setPresence(null)` (mode fallback).

## 6. Perubahan js/agent.js
- `window.__agent = { think, reactEvent, setUserMood, setPresence, setCameraMood, applyExpression, speak }`
- `reactEvent(type, detail)`:
  - build `clientSystem` = base system + event line ("[EVENT: type] ...") + mood line (jika `userMood`).
  - `busy` guard.
  - `user` = synthetic prompt sesuai type (idle: "ngomong sendiri santai"; left: "user pergi";
    returned: "user balik"; mood:x: "user terlihat x").
  - `POST /api/chat { system: clientSystem, user, history:[] }` (synthetic tdk disimpan ke history).
  - `speakSegments()` hasil -> TTS clone.
- `setUserMood(m)`: set `this.userMood=m` (atau 'normal'); reset timer kalau ada.
- `setPresence(p)`:
  - `p===false` -> `reactEvent('user_left')` + `applyExpression('sedih')`.
  - `p===true` setelah absent -> `reactEvent('user_returned')`.
  - `p===null` -> fallback mode (jangan trigger away, pakai visibility saja).
- `setCameraMood(m)`: jika m negatif & berubah -> `setUserMood(m)` + `reactEvent('mood:'+m)`.
- `buildSystemPrompt()`: tambah `Jika user terlihat ${userMood}, tunjukkan empati...` saat `userMood` aktif.

## 7. Perubahan js/app.js
- State global: `let presence = null;` (null=belum tahu / fallback).
- **Idle timer**: `resetIdle()` tiap `sendBubble`/aktivitas input; `setTimeout` `idleMs`;
  saat fire -> HANYA jalan kalau `presence===true` -> `agent.reactEvent('idle')`,
  lalu schedule ulang tiap `idleRepeatMs`.
- **Toggle kamera**: checkbox di sidebar (id `useCamera`) -> `change`:
  checked -> `cameraPresence.start()`; unchecked -> `cameraPresence.stop()`.
- `sendBubble(text)`: sebelum `agent.think`, panggil `classifyMood(text)` (heuristik kata kunci
  sedih/marah/senang/dll) -> `agent.setUserMood(...)`.
- **Fallback** (izin kamera ditolak / `presence===null`):
  pakai `document.visibilitychange` + `window blur/focus` untuk away/return;
  mood hanya dari teks.

## 8. Perubahan index.html
- Tambah `<input type="checkbox" id="useCamera"> <label>Gunakan kamera</label>` di panel kontrol.
- Tambah `<script type="module" src="js/camera-presence.js"></script>` (setelah app.js/agent.js).
- Pastikan `cameraPresence` global ter-expose dari modul (export `start/stop` & assign `window.cameraPresence`).

## 9. server.js (opsional, minim)
- `/api/chat` sudah menerima `system` -> langsung dipakai sebagai system prompt event/mood. **Tidak wajib diubah.**
- (Future) `moodMethod:"llm"` -> butuh `/api/mood`; default kamera+teks jadi skip.

## 10. Mapping Emosi
| Model label | Agent mood | Reaksi contoh |
|-------------|-----------|---------------|
| angry       | marah     | "kenapa kamu marah? cerita dong" |
| sad         | sedih     | "jangan sedih ya, aku di sini" |
| happy       | senang    | "seneng lihat kamu bahagia!" |
| surprise    | kaget     | "kok kaget? ada apa?" |
| fear        | sedih     | "kamu takut? tenang aja" |
| disgust     | normal    | (abaikan) |
| neutral     | normal    | (idle normal) |

## 11. Privasi / Fallback / Performa
- **Privasi**: inferensi 100% lokal (transformers.js). Frame/webcam tidak dikirim ke server mana pun.
- **Fallback**: izin kamera ditolak -> agent tetap jalan via visibility + mood teks.
- **Performa**: throttle 0.4 fps (~1 inferensi / 2.5 dtk); WebGPU优先 (device:'webgpu'),
  fallback WASM otomatis; dtype 'q4' agar ringan di T4/CPU browser.
- **Anti-jitter**: mood hanya trigger saat label berubah + debounce 5 dtk; presence butuh
  `awayHiddenMs` konsisten sebelum "away".

## 12. Urutan Implementasi
1. `config.json` — tambah `events` + `camera`.
2. `js/camera-presence.js` — modul kamera + classifier.
3. `js/agent.js` — `reactEvent`, `setUserMood`, `setPresence`, `setCameraMood`, `window.__agent`.
4. `js/app.js` — idle timer (respect presence), toggle, classifyMood, fallback.
5. `index.html` — checkbox + module script.
6. Tes lokal: buka app, centang kamera, izinkan, lihat console, simulasi away/return/idle/mood.

## 13. Open Items (belum bisa)
- Referensi audio **marah/senang** untuk router emosi TTS belum ada -> emosi TTS pakai
  suara default dulu; router multi-ref ditunda sampai user punya file referensi per-emosi.

## 14. File Terdampak
- `F:\backup\live2d-agent\config.json`
- `F:\backup\live2d-agent\js\camera-presence.js` (BARU)
- `F:\backup\live2d-agent\js\agent.js`
- `F:\backup\live2d-agent\js\app.js`
- `F:\backup\live2d-agent\index.html`
- `F:\backup\voice-clone-indo.ipynb` (sudah ada, TTS endpoint sumber)
