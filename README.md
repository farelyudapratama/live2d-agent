# 🎭 Live2D Agent v2

Rewrite **Live2D Cubism 4** dari [`live2d-agent`](../live2d-agent/) — arsitektur modular & TypeScript, runtime **Bun** (zero deps).

> **Model-agnostic:** jalan dengan model Cubism 4 **apa pun** di `data/model/<nama>/`. Tidak ada hardcode nama/id/range. Aturan: `MODEL-AGNOSTIC-RULES.md` di repo v1.
> **Parity 100%** dengan `server.js` v1 (1945 LOC) — semua endpoint LLM/sheet/motion/model sudah di-port. Client hybrid: `static/js/{app.js,agent.js}` legacy tetap dipakai (0 regresi UI) + `src/` TS sebagai source-of-truth untuk iterasi selanjutnya.

## 🚀 Cara Menjalankan

```bash
cd live2d-agent-v2
bun run src/server/index.ts          # default http://127.0.0.1:8310
PORT=9000 bun run src/server/index.ts  # port lain — frontend ikut location.origin
# atau klik start.bat (Windows)
```

`bun run dev` = alias `bun run src/server/index.ts` · `bun run build` = `bun run src/build.ts` → `static/js/bundle.js` (legacy `static/js/app.js` dipertahankan). `PORT` dihormati, `location.origin` dipakai frontend jadi LAN/https jalan tanpa ubah kode.

> **Migrasi dari v1:** copy `live2d-agent/config.json` → `live2d-agent-v2/data/config.json`, `live2d-agent/model/*` → `data/model/`, `live2d-agent/sheets/*` → `data/sheets/`, `live2d-agent/motions/*` → `data/motions/`. Struktur v2 memisah `data/` vs `static/` (v1 campur di root).

## 🎮 Fitur & Status

| Fitur | Status | Catatan |
|-------|--------|---------|
| Viewer Live2D | ✅ | `data/model/<nama>/` apa pun, CJK `神宫白子` OK |
| Sheet per model (schema v4) | ✅ | `GET/POST /api/sheet` + `queueJsonWrite` atomic |
| Preset 4 kategori | ✅ | `emosi`/`properti`/`aksesoris`/`gerak`, user > AI |
| Analisa sheet oleh LLM | ✅ | `POST /api/model/analyze-sheet` (clamp & dedup ketat) |
| Adopsi `.exp3` tak terdaftar | ✅ | `discoverExpressions` + `exp3-adoption` opt-out |
| Injeksi gerak LLM | ✅ | `[EMOTION:] [GESTURE:] [MOTION:] [INTENSITY:] [ACC:] [PROP:] [HEAD:] [EYES:] [MOUTH:] [BODY:]` |
| Agent proaktif | ✅ | `idle/away/return/mood` + panel **🎚️ Kelakuan** (Hidup/Sedang/Tenang) |
| Mood via webcam | ✅ | opt-in, lokal `transformers.js`, `src/client/modules/camera-presence.ts` |
| Mouse-follow | ✅ | |
| TTS proxy | ✅ | `POST /api/tts` → Gradio |
| Otak LLM (multi-provider + fallback) | ✅ | `openai-compatible/gemini/groq/openai/anthropic/mock` + 13 `ERROR_RULES` `src/shared/llm-client.ts:19` |
| Indikator hidup | ✅ | presence/mood/quiet |
| Kontrol adopsi `.exp3` | ✅ | `GET/POST /api/model/expressions-adoption` |
| Motion Studio (editor keyframe per param) | ✅ | `static/js/motion-editor.js` + `POST /api/motions` (sanitize via `motion-dsl`) |
| Motion Registry + Runtime | ✅ | `motion-dsl/registry/runtime` — 3 sumber (builtin/native/user), priority+cooldown+blending |
| Motion dipakai AI | ✅ | `[MOTION:id]` divalidasi |
| ✨ Analisa AI motion | ✅ | `POST /api/motions/analyze` |
| 🪄 Buat motion dari teks | ✅ | `POST /api/motions/generate` |

## 🧠 Arsitektur

```
src/server/index.ts        # Bun.serve — API + static (CJK safeJoin, queueJsonWrite)
src/shared/{types,config,llm-client}.ts
src/client/animation/{easing,motion-dsl,registry,runtime,layer}.ts
src/client/engine/role-mapper.ts
src/client/agent/{directive-parser,brain}.ts  # two-pass director, capability profile
src/client/modules/{chat-ui,camera-presence}.ts
static/{index.html,css/app.css,js/app.js,js/agent.js,js/motion-*.js} # legacy parity (0 regresi)
data/{config.json,sheets/,motions/,model/}
```

LLM: `browser → POST /api/chat → llmWithFallback (active first, cooldown, fallback) → provider → reply → parseSegments → animateTextViaDirector (POST /api/animate-text) → MotionRuntime`.

Motion: `Motion Asset → Registry (builtin 9 gesture + native .motion3 + user) → Runtime (priority+blend+watchdog rAF) → Live2D`.

## 🧪 Test

```bash
bun test                  # 45 pass (motion-dsl, registry, directive-parser)
bun run src/build.ts      # build bundle.js
# v1: npm test (1234 pass, 26 suite) — logic sama, test v2 diperluas bertahap
```

## 📚 Dokumen v1 (tetap berlaku)

`docs/MODEL-AGNOSTIC-RULES.md`, `SPECIFICATION — Motion Studio & AI Motion System.md`, `CRITICAL UI & FLOW CONSTRAINTS.md`, `HANDOFF-SHEET-SYSTEM.md`, `PLAN-MOTION-STUDIO.md` — lihat `../live2d-agent/docs/`.

## 🔧 Troubleshooting

- **Diam 30 menit?** Tab ⚙️ AI → **🎚️ Kelakuan** → **⚡ Hidup** → Simpan. Cek `data/config.json` `events.quietMs/idleMs`.
- **0 emosi?** Console `[exp3] adopted N` — kalau 0, model memang tanpa `.exp3`, bikin preset `emosi` di Sheet.
- **Fetch gagal?** Cek `location.origin` — jangan hardcode `127.0.0.1:8310` (`bun test` tidak pakai server).
- **Model CJK 404?** `safeJoin` decode `%E7%A5%9E` → `神宫白子` sudah di-handle di `src/server/index.ts`.
