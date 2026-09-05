# 🎭 Live2D Agent

Karakter Live2D (Cubism 4 & 5) yang dikendalikan AI — ngobrol lewat teks atau suara, karakter menjawab dengan gerak, ekspresi, dan suara (TTS), dan tetap hidup saat kamu diam: bicara sendiri saat idle, menyapa saat kamu pergi/balik, membaca mood dari webcam. Runtime **Bun** (zero-dep), inti logika **TypeScript**.

> **Model-agnostic:** jalan dengan model Cubism 4/5 **apa pun** di `data/model/<nama>/`. Aturan mengikat: [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md).

## 🚀 Cara Menjalankan

```bash
cd live2d-agent
bun run build                # WAJIB untuk clone baru — static/js/bundle.js di-gitignore
bun run src/server/index.ts  # default http://127.0.0.1:8310
PORT=9000 bun run src/server/index.ts   # port lain — frontend ikut location.origin
HOST=0.0.0.0 bun run src/server/index.ts  # ekspos ke LAN (default loopback!)
# atau klik start.bat (Windows — otomatis build dulu, lalu start server)
```

`bun run dev` = alias `bun run src/server/index.ts` · `bun run build` = `bun run src/build.ts` → `static/js/bundle.js`. **Lewati `bun run build` dan aplikasi jalan tapi tanpa otak**: chat mati diam-diam karena `window.__agent` tidak ada (engine degrade gracefully, bukan crash). `bun install` hanya perlu untuk `bun test` / `tsc` (devDep `bun-types`) — server dan build tidak butuh node_modules. `PORT` dihormati, `location.origin` dipakai frontend jadi LAN/https jalan tanpa ubah kode.

**Clone baru (tanpa model)?** `data/model/` kosong karena aset berlisensi tidak di-commit — aplikasi tetap terbuka dengan **layar impor**: klik 📂 pilih folder model atau 🗜️ impor `.zip` (bisa juga copy manual ke `data/model/`). Model terakhir yang dibuka **diingat otomatis** dan dimuat lagi saat berikutnya; menghapus model dari UI **tidak** menghapus sheet/preset/motion buatanmu — impor ulang model dengan nama sama dan semuanya tersambung kembali. Sheet karakter juga **tidak ikut repo** (privasi): dibuat ulang lewat 🔍 Inspeksi Model, tapi preset & catatan yang kamu tulis hanya hidup di mesin tempat kamu mengetiknya — backup manual `data/sheets/` sebelum pindah mesin.

## 📦 Rilis Portable (bagikan tanpa Bun/Rust)

```bash
bun run build:pet   # sekali — bangun cangkang Tauri (butuh Rust toolchain)
bun run dist        # rakit dist/Live2D-Agent/ — siap di-zip & dibagikan
```

Mau **satu file**? Pasang Inno Setup 6 sekali (`winget install JRSoftware.InnoSetup`) — `bun run dist` otomatis menjalankan [`installer.iss`](installer.iss) di langkah terakhir dan menghasilkan **`dist/Live2D-Agent-Setup.exe`** (±32 MB): installer per-user tanpa admin, install ke `%LOCALAPPDATA%\Programs\Live2D-Agent`, shortcut desktop opsional, data user tetap hidup di samping exe (uninstall membiarkan `data/` utuh), plus deteksi WebView2 yang memandu pasang runtime bila tidak ada. Tanpa Inno Setup, langkah installer dilewati dengan pesan — alur zip tetap jalan seperti biasa.

Hasil `dist/Live2D-Agent/`: `live2d-shell.exe` (cangkang WebView2) + `live2d-agent.exe` (server, runtime Bun ter-embed via `bun build --compile`, dependensi npm ikut di-bundle) + `static/`. **User cukup dobel-klik `live2d-shell.exe`** — shell menyalakan server sendiri (sidecar) dan mematikannya saat ditutup; tanpa Bun, tanpa build, tanpa Rust. `data/` tercipta saat first-run di samping exe: taruh model di `data/model/`, isi API key LLM/TTS lewat panel — jangan ditaruh di bawah `C:\Program Files` (butuh folder yang bisa ditulis). Exe shell per-OS harus dibangun di OS-nya masing-masing; server bisa di-cross-compile: `bun run dist -- bun-linux-x64` (target: `bun-linux-x64`, `bun-darwin-arm64`, dst — lihat `src/dist.ts`).

## 🧩 Arsitektur

Satu aplikasi dengan dua lapisan yang saling menopang: **inti logika di TypeScript** (punya unit test), **engine/UI legacy di `static/js/`** (sudah teruji jalan, dijaga guard). Kode TS client di-bundle `src/build.ts` → `static/js/bundle.js` (IIFE), dimuat **sebelum** `app.js`, dan memasang bridge `window.MotionTaxonomy / MotionDSL / MotionRegistry / MotionRuntime / __agent` — engine legacy mengonsumsi global itu, `app.js` tetap pemilik render loop, pemuatan model, dan UI.

| Lapisan | Lokasi | Karakter |
|---|---|---|
| Server — 40+ route API, LLM proxy, static, upload | `src/server/index.ts` + `src/shared/{config,llm-client,types}.ts` | TS penuh, teruji unit |
| Otak agent — prompt, directive, proaktif | `src/client/agent/{brain,directive-parser}.ts` | TS penuh, teruji unit |
| Motion core — DSL, registry, runtime, easing | `src/client/animation/*.ts` | TS penuh, teruji unit |
| Motion taxonomy — klasifikasi klip native | `src/client/engine/motion-taxonomy.ts` | TS — dipakai server & bundle |
| Mode system — VTuber / Assistant / Pet + ModeManager | `src/server/{vtuber,assistant,pet}.ts` + `static/js/mode-runtime.js` | 1 mode aktif; pindah mode = runtime lama dihancurkan |
| Release portable — compile server + rakit folder | `src/dist.ts` (`bun run dist`) → `dist/Live2D-Agent/` | server jadi exe (`bun build --compile`), sidecar shell |
| Cangkang jendela — WebView2, sidecar server | `agent-shell/` (Rust/Tauri, exe ±3 MB) | dobel-klik = app; menyalakan & mematikan server sendiri di mode portable |
| Engine/UI — render loop, chat, panel, sheet, role mapping | `static/js/app.js` (±6.300 baris) | **legacy** — dijaga guard |
| Motion Studio UI | `static/js/motion-editor.js` | legacy — terisolasi |
| Webcam presence | `static/js/camera-presence.js` | legacy — terisolasi |
| STT push-to-talk | `static/js/voice-input.js` | modul ES mandiri |

**Aturan kontribusi — "port saat disentuh":** bagian legacy yang perlu diubah suatu hari di-port potongannya di commit yang sama dengan perubahannya, bersama guard-nya. Dua area logika yang paling bernilai di-port bila kelak disentuh: **sistem sheet** (`migrateSheet`/`resolvePresets` — guard 220 assertion siap di `test/legacy/`) dan **role mapping + inspect model** (`mapRoles`/`pokeRole*` — guard 84 assertion). Chat UI/panel DOM tidak direncanakan di-port.

```
src/server/index.ts        # Bun.serve (loopback default) — 40+ route API + static
src/server/{vtuber,assistant,pet}.ts   # runtime 3 mode (satu mode aktif)
src/shared/{types,config,llm-client,paths}.ts   # paths.ts: akar app dev vs exe compile
src/client/animation/{easing,motion-dsl,motion-registry,motion-runtime}.ts  # → bundle.js
src/client/engine/motion-taxonomy.ts   # klasifikasi klip native — server & bundle
src/client/agent/{directive-parser,brain}.ts   # otak agent → window.__agent
src/build.ts               # bundle-entry.ts → static/js/bundle.js (IIFE, dimuat SEBELUM app.js)
src/dist.ts                # bun run dist — rakit dist/Live2D-Agent/ (exe + static)
agent-shell/src/main.rs    # cangkang Tauri (main/pet) — sidecar server portable
static/{index.html,css/app.css,js/app.js}      # engine/UI legacy (punya render loop)
static/js/mode-runtime.js   # client runtime 3 mode + switcher sidebar
static/pet.html             # halaman jendela Desktop Pet
static/js/{bundle.js,motion-editor.js,camera-presence.js,voice-input.js}
data/{config.json,sheets/,motions/,model/}     # data user — TIDAK disajikan sembarangan
docs/                      # panduan mengikat (lihat bawah)
```

Urutan muat `index.html`: **`bundle.js`** (Taxonomy+DSL+Registry+Runtime+brain) → `app.js` → `motion-editor.js` → `camera-presence.js` → `voice-input.js`.

LLM: `browser → POST /api/chat → llmForRole('chat') → llmWithFallback (eksplisit-role dulu, cooldown, fallback) → provider → reply → parseSegments → animateTextViaDirector (POST /api/animate-text, role 'motion' + paramNotes + persona) → MotionRuntime`. Tabel parameter **tidak** dikirim ke prompt pembicara — pindah ke director (multi-LLM role routing; ±3.400 token/pesan dihemat pada model 223-param). Persona per-karakter — nama (`sheet.config.displayName`) + catatan karakter (`sheet.userNote`) — ikut ke prompt pembicara **dan** director, jadi teks dan ekspresi mengikuti kepribadian karakter tanpa perlu dideklarasikan di koneksi LLM.

Motion: `Motion Asset → Registry (builtin + native + user) → Runtime (priority+blend+watchdog rAF) → Live2D`.

## 🎮 Fitur & Status

| Fitur | Status | Catatan |
|-------|--------|---------|
| Viewer Live2D | ✅ | `data/model/<nama>/` apa pun, CJK `神宫白子` OK |
| Sheet per model (schema v4) | ✅ | `GET/POST /api/sheet` + `queueJsonWrite` atomic — aturan terkunci: [`docs/SHEET-SYSTEM.md`](docs/SHEET-SYSTEM.md) |
| Preset 4 kategori | ✅ | `emosi`/`properti`/`aksesoris`/`gerak`, user > AI |
| Analisa sheet oleh LLM | ✅ | `POST /api/model/analyze-sheet` (clamp & dedup ketat) |
| Adopsi `.exp3` tak terdaftar | ✅ | `discoverExpressions` + opt-out per file |
| Injeksi gerak LLM | ✅ | `[EMOTION:] [GESTURE:] [MOTION:] [INTENSITY:] [ACC:] [PROP:] [HEAD:] [EYES:] [MOUTH:] [BODY:]` |
| Pose dari emosi tanpa directive | ✅ | `inferMovementFromEmotion` + jitter ±2.5°, scaled ke range param model |
| Arbitrase motion/gesture | ✅ | `[MOTION:]` prioritas 80; gagal → jatuh ke gesture; gesture (60) kini menyusun DI BAWAH motion — field benturan ditekan runtime (multi-layer, ownership per field) |
| `lockAI()/unlockAI()` | ✅ | fidget & interaksi dibekukan selama playback segmen |
| Timing segmen ikut TTS | ✅ | segmen berikut mulai saat TTS segmen ini selesai (+180 ms) |
| Agent proaktif | ✅ | `idle/away/return/mood` + panel **🎚️ Kelakuan** — `quietMs` dibaca LIVE dari config |
| Mood via webcam | ✅ | opt-in, inferensi lokal `transformers.js` — frame tidak di-upload |
| Mouse-follow | ✅ | mata + kepala + badan |
| TTS multi-provider | ✅ | Provider: **Browser / Gradio / OpenAI-compatible / ElevenLabs / Gemini TTS / API Kustom** — UI di ⚙️ Pengaturan Model → *Mesin Suara (TTS)*; voice & model auto-populated (Gemini & OpenAI katalog resmi, ElevenLabs & OpenAI-compat ditarik live), **Gaya bicara** (aksen/emosi/tempo via prompt), API key tersimpan di `config.json` (dimask di UI); fallback otomatis ke suara browser saat provider gagal/kuota habis |
| Pipeline TTS per-kalimat | ✅ | Teks panjang dipecah per kalimat; segmen berikut di-**prefetch selagi yang sekarang diputar**; latensi request pertama diukur nyata → sisa kalimat digabung adaptif (durasi audio ≥ latensi) → jeda antar segmen ≈ nol; bubble mengikuti kalimat yang dibacakan; cache server 30 mnt per (config+teks) = kalimat sama tak mengulang API |
| Avatar PNG per model | ✅ | `GET /api/model/avatar` — `avatar.png` diutamakan, lalu gambar pertama di folder model; tanpa gambar → inisial huruf |
| Otak LLM (multi-provider + fallback) | ✅ | `openai-compatible/gemini/groq/openai/anthropic/mock` + **role routing** (`chat`/`motion`/`sheet` — kosongkan = semua peran; prompt pembicara bebas tabel parameter, deskripsi param pindah ke director) + 13 `ERROR_RULES` di `src/shared/llm-client.ts` |
| Indikator hidup | ✅ | presence/mood/quiet |
| Motion Studio (editor keyframe per param) | ✅ | `static/js/motion-editor.js` + `POST /api/motions` (sanitize via `motion-dsl`) — spec: [`docs/MOTION-SYSTEM-SPEC.md`](docs/MOTION-SYSTEM-SPEC.md) |
| Motion Registry + Runtime | ✅ | 3 sumber (builtin 9 gesture + native .motion3 + user), priority+cooldown+blending, multi-layer (N motion paralel, ownership per field) |
| Motion dipakai AI | ✅ | `[MOTION:id]` divalidasi runtime & server; playback dilar (stretch, maks 2×) mengikuti estimasi durasi TTS segmen |
| ✨ Analisa AI motion | ✅ | `POST /api/motions/analyze` — butuh persetujuan user |
| 🪄 Buat motion dari teks | ✅ | `POST /api/motions/generate` — draft, di-preview lalu disetujui |
| 🎤 STT mic (ngobrol 2 arah) | ✅ | push-to-talk — Whisper lokal di browser (transformers.js); audio tidak pernah di-upload |
| 🎥 Mode AI VTuber | ✅ | Konektor **Twitch** (IRC anonim, cukup nama channel) / **YouTube Live** (API key + video ID; superchat = donasi) / **Mock** (simulasi tanpa key). Feed live, AI balas chat otomatis dengan gaya atur-sendiri + jeda antar balas, banner & ucapan terima kasih donasi |
| 🧠 Mode AI Assistant | ✅ | Agent lokal dengan tools `list_dir` / `read_file` (otomatis) + `write_file` / `run_shell` (wajib izin via kartu approval); multi-turn LLM + folder kerja bisa diganti. Bisa juga dari terminal: `bun run agent [--cwd path] [--yes]` — REPL ke API yang sama, approval konfirmasi y/n di terminal. `run_shell` asinkron — server tetap responsif selama perintah jalan |
| 🐾 Mode Desktop Pet | ✅ | Shell Tauri (`bun run build:pet`, WebView2 bawaan Windows): jendela transparan melayang, selalu di atas, bisa klik-tembus — ±40-90MB RAM, tanpa Electron. Shell yang sama buka jendela utama (start.bat). Fallback Chrome/Edge `--app` (Win32 SetWindowPos). `static/pet.html` — mata ikut kursor, sapaan berkala; pindah mode menutup jendela otomatis |
| Lip-sync presisi (dari audio) | ✅ | amplitudo audio asli via Web Audio AnalyserNode → envelope → mulut (role space, model-agnostic); senyap antar kata benar-benar menutup mulut. speechSynthesis tanpa stream audio tetap osilasi; kalau AudioContext ditahan autoplay, audio tetap bunyi + osilasi fallback |
| 🌐 Bahasa UI (id/en) | ✅ | Select di ⚙ Pengaturan → Model; deteksi otomatis `navigator.language` saat first-run; bahasa balasan AI (chat/Assistant/VTuber) ikut setting; kata kunci directive (`[EMOTION:]` dst.) tetap kosakata Indonesia karena itu protokol. Guard test: parity kamus + coverage kunci HTML |

### 🌐 Bahasa (Localization)

Dua bahasa: **Indonesia** (identity/fallback) dan **English**. Pilih lewat ⚙ Pengaturan → Model → *Bahasa* — tersimpan di `data/config.json` (`i18n.lang`) + `localStorage`, lalu halaman di-reload. Kunjungan pertama tanpa pilihan: bahasa dideteksi dari browser. Core i18n zero-dep (`src/client/i18n/`) ter-bundle di `bundle.js` + file kecil `js/i18n.js` untuk `pet.html`; markup statis diterjemahkan lewat atribut `data-i18n*`, string runtime lewat `window.__i18n.t()`. Menambah bahasa = buat `dict-xx.ts` baru + satu `<option>` di select — parity & coverage dijaga `test/i18n.test.ts`. Pesan error dari server masih bahasa Indonesia (fase berikutnya).

### Interaksi
- **Gerak mouse** → mata + kepala + badan ikut · **Drag** → geser posisi · **Scroll** → zoom · **Double-click** → reset framing

### 🎤 Ngobrol 2 arah (STT)
Klik **🎤** di panel chat → bicara → berhenti otomatis saat senyap (atau klik lagi) → teks masuk chat dan terkirim. Push-to-talk murni: **tidak ada perekaman latar**, dan memulai rekam **ditolak saat karakter sedang bicara TTS** (anti-echo — kalau tidak, dia mengobrol dengan dirinya sendiri). Inferensi 100% lokal di browser; audio tidak pernah di-upload. Model Whisper diunduh dari CDN **saat pertama dipakai** (butuh internet sekali, lalu ter-cache browser): default `Xenova/whisper-base` — untuk bahasa Indonesia yang lebih akurat ganti `stt.model` ke `Xenova/whisper-small` di `data/config.json` (lebih besar, ±250 MB). `stt.autoSend: false` bila mau review teks sebelum kirim. Bagian murni (RMS, resampler 16 kHz, auto-stop) diuji di `test/voice-input.test.ts`.

Catatan arsitektur: fitur ini butuh **nol perubahan `app.js`** — semua hook yang dibutuhkan sudah disiapkan (`#btn-mic` yang dulu disabled, `window.__l2dDebug.state.talking`, kirim via klik `#btn-bubble`).

### 🎛️ Sistem 3 Mode (VTuber / Assistant / Pet)

Switcher 4 tombol di atas sidebar: **💬 Panggung** (default, semua fitur lama) · **🎥 VTuber** · **🧠 Assistant** · **🐾 Pet**. Kontrak ketat: **hanya satu mode aktif** — pindah mode menghancurkan runtime lama dulu (interval, WebSocket, feed, riwayat; client *dan* server) baru menyalakan yang baru. Runtime server: `src/server/vtuber.ts`, `src/server/assistant.ts`, `src/server/pet.ts`; runtime client: `static/js/mode-runtime.js`; status gabungan: `GET /api/mode`, pindah: `POST /api/mode {mode}`.

- **🎥 VTuber**: `POST /api/vtuber/start` → *mock* (simulasi penonton + donasi tanpa key), *twitch* (IRC `wss://irc-ws.chat.twitch.tv`, anonim `justinfan` cukup nama channel, auto-reconnect, PING→PONG), *youtube* (API key + video ID live; `videos.liveStreamingDetails.activeLiveChatId` → poll `liveChatMessages.list` mengikuti `pollingIntervalMillis`; `superChatDetails` → event donasi). Client poll `GET /api/vtuber/events?since=<id>` tiap 2,5 s; AI membalas via LLM dengan gaya atur-sendiri + cooldown antar balas; donasi memunculkan banner + ucapan terima kasih. Catatan: beberapa ISP/proxy memblokir TMI Twitch — kalau feed kosong padahal "Terhubung", coba jaringan lain.
- **🧠 Assistant**: `POST /api/assistant/ask` — agent multi-turn dengan tools `list_dir` / `read_file` (otomatis) dan `write_file` / `run_shell` (butuh kartu approval di panel, server menahan sampai `POST /api/assistant/approve`). Folder kerja default = folder project; bisa diganti. LLM memakai koneksi aktif (role `assistant`). CLI: `bun run agent [--cwd path] [--yes]` — REPL yang memanggil API yang sama; approval dikonfirmasi y/n langsung di terminal.
- **🐾 Pet**: `POST /api/pet/launch` membuka jendela pet berisi `static/pet.html` (model transparan, mata ikut kursor, sapaan berkala). Cangkang dipilih otomatis: **shell Tauri** (`bun run build:pet`, exe ±3MB di `agent-shell/target/release/` — jendela WebView2 transparan, selalu di atas, klik-tembus via toggle "Klik Tembus" di panel; butuh Rust saat build saja) atau fallback **Chrome/Edge `--app`** + always-on-top via Win32 `SetWindowPos` (opaque). Pindah mode menutup jendelanya otomatis.

## 🔒 Keamanan

- `data/config.json` (apiKey plaintext) **tidak pernah disajikan** lewat HTTP statis — 403.
- Path traversal (`../`) → 403; default bind **loopback** (`HOST=0.0.0.0` untuk LAN — sadari semua orang di jaringan bisa membaca server).
- Body cap per endpoint (413): sheet 5 MB, upload 200 MB, import-zip 500 MB, lainnya 1 MB.
- `/api/*` tak dikenal → 404 JSON, bukan SPA fallback.
- `data/` di luar folder model tidak bisa disentuh endpoint model (guard `startsWith` + pemisah direktori).
- Privasi sensor: inferensi kamera & STT **100% lokal di browser** (transformers.js) — frame/audio tidak pernah di-upload.

## 🧭 Keputusan desain yang disengaja

1. **Keamanan di atas kenyamanan** — apiKey tidak pernah keluar via HTTP, bind loopback default, body cap per endpoint, asset sensitif diblokir.
2. **`llmWithFallback` mempertahankan koneksi aktif** antar panggilan; reply kosong/error tetap tampil sebagai bubble chat — kegagalan terlihat, tidak diam.
3. **SPA fallback dipersempit** — path tanpa ekstensi → `index.html` 200 (rute UI), tetapi asset `.js`/`.css`/model yang missing → 404 yang jelas, bukan HTML ber-extension js.
4. **Satu kosakata target motion** — nama gaya SPEC (`angleX`, `eyeX`, …) diterima lalu **dikanoniskan** ke `ax/ay/ex/ey` saat sanitize (`normalizeTarget`), jadi format file motion selalu satu kosakata.

## 📁 Data user (`data/`)

Semua data yang kamu buat hidup di `data/` dan **tidak di-commit** (privasi + aset berlisensi): `config.json` (koneksi LLM, TTS, kelakuan — contoh format di `config.example.json`), `model/` (aset Live2D), `sheets/`, `motions/`. Taruh folder model di `data/model/<nama>/` (isi `.model3.json` + tekstur, atau impor `.zip` lewat UI). Pindah mesin = copy folder `data/` — format file identik, tidak ada konversi; model Cubism 4/5 apa pun diterima.

## 🧪 Test

```bash
bun run test         # SEMUA: 217 unit test (bun test) + 512 guard legacy (11 suite)
bun run test:unit    # hanya unit test TS (parser, DSL/registry/taxonomy, dispatcher server, voice-input)
bun run test:guards  # hanya guard legacy
bun run build && bunx tsc --noEmit   # build + type-check (keduanya bersih)
```

Guard legacy (`test/legacy/`) menguji **fungsi asli yang jalan di aplikasi**, bukan salinan: role-mapping & param-scaling (uji invariansi penggantian nama — jantung aturan model-agnostic), sheet schema v4 (220 assertion, mengekstrak `migrateSheet()` dari `app.js` asli via `vm`), exp3-adoption (endpoint diuji in-process dengan model sintetis yang dihapus otomatis), api-origin. Tidak ada test yang memanggil jaringan. `bun test` men-stub endpoint yang menyentuh LLM ke provider `mock` — suite tidak pernah melakukan panggilan jaringan dan tidak pernah menulis `data/config.json`.

## 📚 Dokumentasi (lokal, mengikat)

| File | Isi |
|---|---|
| [`docs/MODEL-AGNOSTIC-RULES.md`](docs/MODEL-AGNOSTIC-RULES.md) | Aturan model-agnostic — kenapa & bagaimana tetap tidak meng-hardcode |
| [`docs/SHEET-SYSTEM.md`](docs/SHEET-SYSTEM.md) | Sistem sheet, 4 aturan terkunci, adopsi `.exp3`, keputusan agen reaktif |
| [`docs/MOTION-SYSTEM-SPEC.md`](docs/MOTION-SYSTEM-SPEC.md) | Spesifikasi Motion Studio + pipeline gerak (satu pipeline, prioritas, validasi) |
| [`docs/MODES.md`](docs/MODES.md) | Sistem 3 mode — kontrak satu-mode-aktif, konektor VTuber (Twitch/YouTube/mock), agent Assistant, jendela Pet |

## 🔧 Troubleshooting

- **Chat diam total?** Belum `bun run build` — `static/js/bundle.js` tidak ada (di-gitignore), jadi `window.__agent` tidak terpasang. Jalankan build, refresh.
- **Diam 30 menit?** Tab ⚙️ AI → **🎚️ Kelakuan** → **⚡ Hidup** → Simpan. Otak membaca `quietMs` langsung dari `window.__appEvents` (live, tanpa restart).
- **0 emosi?** Console `[exp3] adopted N` — kalau 0, model memang tanpa `.exp3`; bikin preset `emosi` di tab Sheet.
- **Fetch gagal?** Cek `location.origin` — jangan hardcode `127.0.0.1:8310`.
- **Model CJK 404?** `safeJoin` decode `%E7%A5%9E` → `神宫白子` di-handle `src/server/index.ts`.
- **413 saat upload?** Body melebihi cap endpoint (sheet 5 MB, upload 200 MB, import-zip 500 MB).
- **Akses dari HP/LAN?** `HOST=0.0.0.0` — sadari semua orang di jaringan bisa membaca server.
- **Model blank di headless?** Normal — swiftshader tidak render WebGL ke framebuffer; model tetap load (console `[Live2D] Model loaded`).
- **TTS 429 / suara browser terus?** Kuota provider TTS habis (mis. Gemini free tier) — sistem otomatis jatuh ke suara browser; tunggu reset kuota atau isi billing. Detail provider: ⚙️ → Mesin Suara.
- **Suara panjang terpotong/berjeda?** Pipeline per-kalimat menunggu latensi provider (Gemini ±12–16 s/request); segmen berikutnya di-prefetch — pastikan jaringan stabil. Cache server 30 mnt membuat kalimat sama instan.
- **VTuber Twitch feed kosong padahal "Terhubung"?** Sebagian ISP/proxy memblokir TMI chat Twitch — coba VPN/hotspot, atau pakai provider YouTube/mock.
- **Assistant menolak menjalankan perintah?** Itu fitur — `write_file`/`run_shell` menunggu persetujuanmu di panel Assistant (kartu ⚠️).

## ⚠️ Model assets

`data/model/` **tidak di-commit** (binary berlisensi). Letakkan model Cubism 4 atau 5 sendiri di `data/model/<nama>/<file>.model3.json` — runtime mendukung keduanya (moc3 v4.2 dan v5.0/5.3; detail efek rig v5: `docs/STATUS-CUBISM5-EFEK.md`). Catatan kompatibilitas: model v4 tetap kompatibel dengan runtime Cubism 5, tapi jangan buka & re-save di Editor v5 kalau mau balik ke v4.
