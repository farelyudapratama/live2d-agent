# SPECIFICATION — Motion Studio & AI Motion System

> Spesifikasi mengikat sistem motion di repo ini. Sistemnya sudah terbangun
> penuh (7 fase selesai) — dokumen ini menjelaskan makna setiap keputusan dan
> pagar yang tidak boleh dilanggar saat mengubah sistem motion.

## 0. Peta implementasi

```text
src/client/animation/motion-dsl.ts        Format Motion Asset + evaluator keyframe + sanitize
src/client/animation/motion-registry.ts   Registry 3 sumber gerakan
src/client/animation/motion-runtime.ts    Satu-satunya pemutar animasi (scheduler + blending)
src/client/engine/motion-taxonomy.ts      Klasifikasi klip .motion3.json (dipakai server & bundle)
src/client/agent/brain.ts                 AI Motion Director (prompt, directive, arbitrase)
static/js/motion-editor.js                UI Motion Studio (timeline, metadata, preview)
static/js/app.js                          Bridge runtime ↔ render loop ↔ state.aiPose
POST /api/motions, /api/motions/analyze, /api/motions/generate   (src/server/index.ts)
```

Semua di-bundle/di-bridge lewat `window.MotionDSL / MotionRegistry /
MotionRuntime` + `window.__agent` (lihat `src/client/bundle-entry.ts`).

# 1. Main Goal

User bisa membuat/mengedit motion secara visual, lalu motion itu tersedia untuk
LLM. Arsitektur akhir:

```text
USER → CHAT/LLM → AI MOTION DIRECTOR → MOTION REGISTRY → SCHEDULER → RUNTIME → LIVE2D MODEL
```

LLM TIDAK boleh memanipulasi parameter ID Live2D secara langsung — hanya
memilih semantic motion ID + properti tingkat tinggi. Runtime yang
menterjemahkan tindakan semantik menjadi animasi model.

# 2. Core Design Principle: Motion Asset

Motion Asset = definisi animasi semantik yang independent dari model.
Bisa berupa: keyframe buatan user, `.motion3.json` native, gesture prosedural,
atau hasil AI. Semuanya tampak sama bagi LLM:

```text
motion ID · description · tags · emotion compatibility · duration · intensity range · availability
```

# 3. Jangan expose parameter mentah ke LLM

❌ `{"ParamAngleX": -12, ...}` — ✅ `{"type":"motion","id":"think","intensity":0.7}`

Layer semantik memakai nama role (`angleX angleY eyeX eyeY bodyX bodyY bodyZ
mouthForm`); resolusi role → parameter ID dilakukan sistem role-mapping model
(`static/js/app.js`, lihat `MODEL-AGNOSTIC-RULES.md`). Jangan pernah berasumsi
dua model memakai parameter ID yang sama.

# 4–5. UI Editor

Motion Studio = tab 🎬 (`static/js/motion-editor.js`): library + preview Live2D
realtime + timeline keyframe. Preview harus realtime: geser slider / ketik
angka / scrub playhead → model langsung berubah. Dua tingkat akses:

- **Semantic mode** (default): Head (turn X/Y, tilt Z), Eyes (look X/Y), Body
  (lean X/Y, rotation), Face (smile, mouth open, eye openness, brow bila ada),
  Energy (bounce, amplitude).
- **Advanced mode** (opsional, tidak wajib): memperlihatkan parameter rig yang
  ter-resolve. Implementasi melangkah lebih jauh: timeline bekerja pada
  **parameter mentah rig** (satu track per parameter, seperti Cubism Editor),
  dengan mode semantik 8 field tetap bisa dibuka (migrasi via
  `rolesToParamTracks` + peta role model aktif, nilai diproyeksikan ke range
  asli parameter).

# 6. Timeline

Operasi wajib: add/move/delete/duplicate keyframe, edit value & timestamp,
scrub, play/pause/stop/loop, change duration. Interpolasi smooth (linear,
ease-in, ease-out, ease-in-out) — `src/client/animation/easing.ts`. Tidak boleh
ada parameter snap mendadak kecuali user memilih stepped.

# 7. Motion File Format

```text
data/motions/<model-key>/<id>.motion.json
```

Format inti: `version, id, name, description, tags[], duration, loop,
intensity{min,max,default}, emotionCompatibility{...}, tracks[{target,
keys[{t,v,easing?}]}]`. Extensible. Field `sourceModelId` menandai motion
berbasis parameter mentah **terikat ke model asalnya**: dibuka di model lain,
parameter yang tidak ada dilewati dengan aman (track abu-abu "tidak ada di
model ini") — tidak error, tidak merusak data.

# 8. Motion Registry

```js
MotionRegistry.createRegistry()  // static/js/bundle.js → window.MotionRegistry
register(asset) · get(id) · has(id) · list() · remove(id, source) · search({tags, emotion})
```

Registry menggabungkan TIGA sumber tanpa menyalin datanya:

1. **builtin** — 9 gesture prosedural (`registerGestureLibrary`)
2. **native** — klip `.motion3.json` milik model (priority 90, via `registerNativeGroups`)
3. **user** — Motion Asset buatan Motion Studio (`replaceUserMotions`)

Setiap entri: `id, name, description, source, tags, duration,
emotionCompatibility, intensityRange, cooldown, priority, capabilities`.

# 9–10. Native & Gesture Integration

Taxonomy (`src/client/engine/motion-taxonomy.ts`) tetap mekanisme otoritatif
penemuan/klasifikasi klip native; native clips masuk registry sebagai entri
`source:"native"`. Gesture builtin tidak diduplikasi — di-expose lewat registry
sebagai Motion Asset `source:"builtin"`. Kalau preset user punya nama semantik
yang sama, berlaku precedence sheet (`user` > `ai`; lihat `SHEET-SYSTEM.md`
aturan #3) — tidak pernah timpan diam-diam.

# 11. Motion Runtime

```js
MotionRuntime.createRuntime(registry, bridge)   // window.MotionRuntime
play(id, {intensity, blendIn, blendOut, fitToMs}) · stop(id) · stopAll() · isPlaying(id) · getActive()
```

Satu pintu playback, MULTI-LAYER: N motion boleh berjalan paralel; tiap frame
runtime menghitung gabungan semua layer dan menerapkannya dalam SATU
`applyPoseDelta` + `applyParamDrive` (bridge app.js unwind-then-apply, jadi
tidak ada dua penulis per frame). Bagian lain aplikasi tidak boleh memanipulasi
state motion secara langsung — app.js men-bridge hasil evaluasi runtime ke
`state.aiPose` tiap frame (8 POSE_FIELDS), plus delegasi `motion_<group>` untuk
klip native.

# 12. Scheduler / Prioritas

```text
100  manual user control          60  gesture          20  idle/fidget
 90  native motion clip           40  emotion          10  breathing
 80  explicit LLM motion
```

Multi-layer (ownership per field): layer baru MENGGANTIKAN semua layer
prioritas <= miliknya (same band & di bawah — paritas cut perilaku lama) dan
BERJALAN BERSAMA layer prioritas lebih tinggi. Field/param hanya ditulis layer
prioritas tertinggi yang menganimasikannya; klaim ownership tetap berlaku walau
nilai sedang 0 (track yang melintasi nol tidak melepas kepemilikan). Cap 4
layer: play yang lebih rendah ditolak saat penuh — band sama tetap bisa
menggantikan. Konsekuensi yang diinginkan: gesture kini menyusun DI BAWAH
`[MOTION:id]` (brain memainkan keduanya; field benturan otomatis ditekan,
sisa field seperti mata/badan tetap bergerak). Native clip tidak menyentuh
layer DSL — app.js punya guard `clipUntil` sendiri selama klip main. Cooldown
lewat registry (`canPlay`/`markPlayed`; dari LLM dihormati, manual bypass).
Watchdog 250 ms di samping rAF mencegah motion yatim mengunci parameter.

# 13–14. Blending & Intensity

Transisi smooth (`blendIn` default 120 ms, `blendOut` 250 ms + envelope
amplitude) — jangan pernah `idle → motion → idle` tanpa blend. Parameter-drive
blending menginterpolasi dari `paramBase`. Intensity menskalakan motion
semantik (`[INTENSITY:]` clamp 0.1..1), bukan mengalikan semua parameter
 secara buta; scaling per-track dipakai bila perlu.

Stretch (`fitToMs`, dihitung `estimateSpeechMs` di brain dari panjang teks
segmen): playback `[MOTION:id]` dilar agar mengisi seluruh durasi bicara TTS —
pelambatan dibatasi 2× (`STRETCH_MAX`), sisanya menahan nilai keyframe
terakhir sampai fade. Motion tidak pernah dipercepat, loop tidak di-stretch
(sudah mengisi waktu sendiri). Blend-out (fade) boleh disela playback
prioritas lebih rendah — fade dianggap bukan "masih main"; playback utama
tetap dilindungi aturan prioritas.

# 15. Metadata Editor

Setiap motion punya panel metadata: Name, ID, Description, Tags, compatible
emotions (senang/normal/malu/sedih/…), intensity min/default/max, cooldown,
priority, loop, AI enabled.

# 16. AI Analyze Motion

`POST /api/motions/analyze` menerima representasi semantik (duration, tracks
dengan range + jumlah keyframe — `summaryForLLM`), BUKAN state internal
aplikasi. Return: description, tags, emotionCompatibility. **User harus
approve** sebelum disimpan.

# 17. AI Motion Generation

`POST /api/motions/generate` — user minta gerak dengan teks ("Buat gerakan
malu, kepala menunduk lalu melihat ke samping") → draft DSL semantik →
Preview → approval → Save → Registry → tersedia untuk LLM. Draft disanitasi
server (sanitize via `motion-dsl`, clamp bounds, id dinormalisasi).

# 18–19. LLM Integration & Catalog

Format lama (`{text, emotion, gesture, intensity}`) dan format baru
(`actions[]`) dinormalisasi ke representasi internal yang sama — jangan
pernah mematahkan format lama. LLM menerima catalog ringkas dari registry
(`catalogForLLM`, slice terbatas): id, description, tags, compatibleEmotions,
plus catatan INTENSITY. Aturan untuk LLM:

```text
Hanya pakai motion ID yang ada di registry. Jangan pernah mengarang ID.
Pilih motion yang semantiknya cocok. Jangan pakai motion yang bertentangan
dengan emosi. Hormati cooldown dan availability.
```

# 20. LLM Tidak Punya Kebebasan Tanpa Batas

ID motion yang tidak ada → **ditolak server, dibuang runtime, jatuh ke gesture
biasa**. Validasi: motion exists, enabled, model support, intensity dalam
range, duration valid, target valid, nilai keyframe dalam batas aman
(`sanitizeMotionAsset`). Cegah NaN/Infinity/timestamp invalid/duration
negatif/target asing.

# 21. Context-aware Selection

Motion Director (LLM) mempertimbangkan konteks percakapan, emosi aktif,
motion sebelumnya, cooldown, kemampuan model. Contoh: "Aku pergi dulu." →
`sedih/normal` + `wave_goodbye`; "HAHAHAHA" → `senang` + `laugh_bounce`;
"Tunggu, aku mikir." → `normal` + `think`. **LLM = director semantik;
runtime = executor deterministik.**

# 22. Idle System

Micro-gesture/idle tetap ada, sebagai layer motion prioritas TERENDAH. Idle
otomatis mundur saat motion prioritas lebih tinggi memegang parameter
relevan (`lockAI()` membekukan fidget & interaksi selama playback segmen).

# 23. Model Capability Awareness

Setiap asset dievaluasi terhadap kemampuan model (`fieldCapability`,
`state.modelParams`). Model tanpa parameter body → jalankan track yang ada,
skip sisanya. **Degrade gracefully, tidak pernah gagal.**

# 24–25. UX & Undo/Redo

Editor terasa: cepat, visual, forgiving, non-destructive, preview mudah.
Hindari: modal berlebihan, raw JSON sebagai UI utama, ratusan parameter
Cubism tampil default. Undo/redo untuk edit timeline; persist hanya saat
save eksplisit (atau autosave terkendali) — jangan tulis disk tiap klik.

# 26. Persistence

```text
data/motions/<model-key>/<motion-id>.motion.json
```

Jangan timpan motion user yang ada diam-diam — konflik ID → tanya user atau
generate ID aman (server: 409 duplicate). Data versi lama kompatibel: copy
`motions/` dari arsip → `data/motions/`.

# 27. API

```text
GET    /api/motions?model=<key>        GET    /api/motions/<id>
POST   /api/motions                    PUT    /api/motions/<id>
DELETE /api/motions/<id>
POST   /api/motions/analyze            POST   /api/motions/generate
```

API key tetap hanya di server — jangan pindah ke browser. (Semua endpoint di
`src/server/index.ts`.)

# 28. Security / Validation

Tidak pernah percaya ID motion dari LLM. Server dan runtime sama-sama
memvalidasi; nilai di-clamp; target tak dikenal ditolak.

# 29. Testing

Minimal: registry (register/get/remove/search/duplicate), parser (valid,
invalid, missing fields, keyframe invalid, target asing), runtime
(play/stop/blend/intensity/cooldown/priority/ownership), LLM (motion valid,
ID asing, intensity invalid, format lama + baru), capability (full model,
head-only, tanpa mata, tanpa body). Status: `bun run test` — unit TS (directive parser,
DSL, registry, taxonomy, dispatcher server, voice-input) + guard legacy
`test/legacy/` (role-mapping, param-scaling, sheet schema, exp3-adoption,
api-origin). Guard runtime motion belum ada — tulis bersamaan saat modul
runtime disentuh.

# 30. Implementation Strategy (status)

Fase 1 (core tanpa UI) — ✅. Fase 2 (sambungkan gesture/taxonomy/native) — ✅.
Fase 3 (Motion Studio UI) — ✅. Fase 4 (metadata editor) — ✅.
Fase 5 (integrasi LLM, dua format) — ✅. Fase 6 (AI analyze) — ✅.
Fase 7 (AI generation) — ✅ (`/api/motions/generate`).

# 31. Architectural Rule

Tepat SATU pipeline konseptual eksekusi motion:

```text
Motion Asset → Registry → Scheduler → Runtime → Live2D
```

Jangan membuat engine motion kedua. `app.js`, agent, gesture system, editor,
idle system — semuanya lewat Motion Runtime, bukan menulis parameter sendiri.

# 32. Quality Bar

Berhasil bila: user bisa buat motion visual → edit keyframe → preview → save
→ reload → beri metadata → lihat di registry → dipakai dari chat. LLM bisa
menemukan motion, memilih yang tepat, mengatur intensity, menggabungkan
dengan emosi, dan TIDAK PERNAH mengarang ID. Runtime bisa blend, mencegah
penulis parameter bertabrakan, hormati prioritas & cooldown, degrade sesuai
kemampuan model. Aplikasi lama tetap jalan utuh (gestures, native motions,
sheets, format LLM lama).

# 33. Final Principle

Tujuan Motion Studio bukan sekadar timeline animasi:

> **Mengubah animasi menjadi kemampuan semantik yang bisa dipahami dan
> dipakai AI agent.**

User membuat `shy_look_away` dengan description + tags +
emotionCompatibility → Registry → LLM melihatnya → user bilang hal
memalukan → LLM memilih `emotion=malu, motion=shy_look_away, intensity=0.8`
→ Scheduler → Runtime → karakter Live2D melakukannya.

Optimalkan untuk: **kejelasan semantik + eksekusi deterministik + animasi
smooth + extensibility + kompatibilitas dengan project** — bukan jumlah fitur.
