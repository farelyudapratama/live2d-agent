# 🎭 Live2D Agent v2

Rewrite **Live2D Cubism 4** dari [`live2d-agent`](../live2d-agent/) — arsitektur modular & TypeScript, runtime **Bun** (zero deps).

> **Model-agnostic:** jalan dengan model Cubism 4 **apa pun** di `data/model/<nama>/`. Tidak ada hardcode nama/id/range. Aturan: `MODEL-AGNOSTIC-RULES.md` di repo v1.
> **Paritas penuh dengan v1** — semua 28 endpoint `server.js` (1945 LOC), seluruh perilaku otak `agent.js` (841 LOC: inferensi gerak dari emosi, jitter, arbitrase motion/gesture, lockAI, timing TTS, quietMs dari config), serta prompt LLM versi lengkap — semua ter-port dan dikunci test. Server Bun zero-dep; client: engine/UI (`static/js/app.js`, byte-identical dengan v1) + **TS sebagai source-of-truth yang benar-benar dieksekusi** (`src/client/*` → `static/js/bundle.js`: motion DSL/registry/runtime + otak agent `window.__agent`). Build via `bun run build`.

## 🚀 Cara Menjalankan

```bash
cd live2d-agent-v2
bun run src/server/index.ts          # default http://127.0.0.1:8310
PORT=9000 bun run src/server/index.ts  # port lain — frontend ikut location.origin
HOST=0.0.0.0 bun run src/server/index.ts  # ekspos ke LAN (default loopback!)
# atau klik start.bat (Windows)
```

`bun run dev` = alias `bun run src/server/index.ts` · `bun run build` = `bun run src/build.ts` → `static/js/bundle.js` (legacy `static/js/app.js` dipertahankan). `PORT` dihormati, `location.origin` dipakai frontend jadi LAN/https jalan tanpa ubah kode.

> **Keamanan:** server memegang apiKey plaintext di `data/config.json`, jadi default bind adalah **loopback `127.0.0.1`** (seperti v1) dan `config.json` **tidak disajikan** lewat HTTP statis (403). Server juga membatasi ukuran body per endpoint (413 bila lebih: sheet 5 MB, upload 200 MB, import-zip 500 MB, lainnya 1 MB) dan menjawab 404 JSON untuk `/api/*` yang tidak dikenal.

> **Migrasi dari v1:** copy `live2d-agent/config.json` → `live2d-agent-v2/data/config.json` (lihat `config.example.json`), `live2d-agent/model/*` → `data/model/`, `live2d-agent/sheets/*` → `data/sheets/`, `live2d-agent/motions/*` → `data/motions/`. Struktur v2 memisah `data/` vs `static/` (v1 campur di root). Model bawaan: `神宫白子` + `lumine` sudah ada di `data/model/`.

## 🎮 Fitur & Status

| Fitur | Status | Catatan |
|-------|--------|---------|
| Viewer Live2D | ✅ | `data/model/<nama>/` apa pun, CJK `神宫白子` OK |
| Sheet per model (schema v4) | ✅ | `GET/POST /api/sheet` + `queueJsonWrite` atomic |
| Preset 4 kategori | ✅ | `emosi`/`properti`/`aksesoris`/`gerak`, user > AI |
| Analisa sheet oleh LLM | ✅ | `POST /api/model/analyze-sheet` (clamp & dedup ketat) |
| Adopsi `.exp3` tak terdaftar | ✅ | `discoverExpressions` + `exp3-adoption` opt-out |
| Injeksi gerak LLM | ✅ | `[EMOTION:] [GESTURE:] [MOTION:] [INTENSITY:] [ACC:] [PROP:] [HEAD:] [EYES:] [MOUTH:] [BODY:]` |
| Pose dari emosi tanpa directive | ✅ | `inferMovementFromEmotion` + jitter ±2.5° per segmen, scaled ke range param model |
| Arbitrase motion/gesture | ✅ | `[MOTION:]` prioritas 80 + intensity; gagal → jatuh ke gesture; tidak pernah keduanya |
| `lockAI()/unlockAI()` | ✅ | fidget & interaksi user dibekukan selama playback segmen |
| Timing segmen ikut TTS | ✅ | segmen berikut mulai saat TTS segmen ini selesai (+180 ms) |
| Agent proaktif | ✅ | `idle/away/return/mood` + panel **🎚️ Kelakuan** — `quietMs` dibaca LIVE dari config (Hidup 15 s / Sedang 60 s berfungsi) |
| Mood via webcam | ✅ | opt-in, lokal `transformers.js` — engine: `static/js/camera-presence.js` |
| Mouse-follow | ✅ | |
| TTS proxy | ✅ | `POST /api/tts` → Gradio |
| Otak LLM (multi-provider + fallback) | ✅ | `openai-compatible/gemini/groq/openai/anthropic/mock` + 13 `ERROR_RULES` `src/shared/llm-client.ts:12` |
| Indikator hidup | ✅ | presence/mood/quiet |
| Kontrol adopsi `.exp3` | ✅ | `GET/POST /api/model/expressions-adoption` |
| Motion Studio (editor keyframe per param) | ✅ | `static/js/motion-editor.js` + `POST /api/motions` (sanitize via `motion-dsl`) |
| Motion Registry + Runtime | ✅ | `motion-dsl/registry/runtime` — 3 sumber (builtin 9 gesture + native .motion3 + user), priority+cooldown+blending |
| Motion dipakai AI | ✅ | `[MOTION:id]` divalidasi |
| ✨ Analisa AI motion | ✅ | `POST /api/motions/analyze` |
| 🪄 Buat motion dari teks | ✅ | `POST /api/motions/generate` |

## 🧠 Arsitektur

```
src/server/index.ts        # Bun.serve (loopback default) — API + static
                           #   safeJoin traversal→403, blokir config.json, 413 body cap, 404 API
src/shared/{types,config,llm-client}.ts
src/client/animation/{easing,motion-dsl,motion-registry,motion-runtime}.ts  # di-bundle -> static/js/bundle.js
src/client/engine/role-mapper.ts
src/client/agent/{directive-parser,brain}.ts   # otak agent -> window.__agent (live)
src/build.ts               # bundle-entry.ts -> static/js/bundle.js (IIFE, sebelum app.js)
static/{index.html,css/app.css,js/app.js,js/bundle.js,js/motion-taxonomy.js}
                           # app.js = engine/UI (byte-identical v1, punya render loop)
static/js/{motion-editor,camera-presence}.js   # editor & webcam (byte-identical v1)
data/{config.json,sheets/,motions/,model/}     # model bawaan: 神宫白子, lumine
```

LLM: `browser → POST /api/chat → llmWithFallback (active first, cooldown, fallback) → provider → reply → parseSegments → animateTextViaDirector (POST /api/animate-text) → MotionRuntime`.

Motion: `Motion Asset → Registry (builtin 9 gesture + native .motion3 + user) → Runtime (priority+blend+watchdog rAF) → Live2D`.

Klien tereksekusi = `bundle.js` (TS: DSL/registry/runtime + `window.__agent`) **+** `app.js` (engine, model loader, render loop, UI) — `bundle.js` dimuat DULUAN secara document-order, lalu `app.js` mengonsumsi `window.MotionDSL/MotionRegistry/MotionRuntime/__agent`.

## 🧪 Test

```bash
bun test                  # 93 pass — parser, DSL/registry, paritas server, keamanan static
bun run src/build.ts      # build static/js/bundle.js dari src/client/*
# v1: npm test (1234 pass, 26 suite) — logic sama
```

## 📚 Dokumen v1 (tetap berlaku)

`docs/MODEL-AGNOSTIC-RULES.md`, `SPECIFICATION — Motion Studio & AI Motion System.md`, `CRITICAL UI & FLOW CONSTRAINTS.md`, `HANDOFF-SHEET-SYSTEM.md`, `PLAN-MOTION-STUDIO.md` — lihat `../live2d-agent/docs/`.

## 🔧 Troubleshooting

- **Diam 30 menit?** Tab ⚙️ AI → **🎚️ Kelakuan** → **⚡ Hidup** → Simpan. Otak membaca `quietMs` langsung dari `window.__appEvents` (live, tanpa restart).
- **0 emosi?** Console `[exp3] adopted N` — kalau 0, model memang tanpa `.exp3`, bikin preset `emosi` di Sheet.
- **Fetch gagal?** Cek `location.origin` — jangan hardcode `127.0.0.1:8310` (`bun test` tidak pakai server).
- **Model CJK 404?** `safeJoin` decode `%E7%A5%9E` → `神宫白子` di-handle `src/server/index.ts`.
- **413 saat upload?** Body melebihi cap endpoint (sheet 5 MB, upload model 200 MB, import-zip 500 MB).
- **Akses dari HP/LAN?** Jalankan dengan `HOST=0.0.0.0` — sadari semua orang di jaringan bisa baca server (dan config berisi apiKey tidak pernah dikirim statis).
