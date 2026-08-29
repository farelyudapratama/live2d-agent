# 🎭 Live2D Agent

Agent maskot **Live2D Cubism 4** yang bisa ngomong (TTS), gerak ngikutin mouse,
punya otak LLM (lewat proxy server), **bereaksi sendiri** saat user diam/pergi,
dan diatur dari panel web. Tujuannya: desktop pet / VTuber-style assistant lokal.

> **Model-agnostic:** jalan dengan model Cubism 4 **apa pun** yang kamu taruh di
> `model/`. Tidak ada nama karakter, id parameter, atau angka range yang
> di-hardcode. Aturan lengkap: `docs/MODEL-AGNOSTIC-RULES.md`.

> **Status:** WIP. Engine render: **PixiJS v6.5.10** +
> `pixi-live2d-display@0.4.0` + **Live2D Cubism Core 4** (bundled offline).
> Rencana kerja aktif: `docs/PLAN-BESOK-ALIVE.md` (semua langkah "Terasa
> Hidup" **sudah selesai** — lihat catatan di bawah).

---

## 🚀 Cara Menjalankan

```bash
cd live2d-agent
node server.js            # server static + LLM proxy, default http://127.0.0.1:8310
PORT=9000 node server.js  # port lain juga jalan — frontend ikut sendiri
```

Atau cukup klik **`start.bat`** (Windows) — dia menjalankan `node server.js`,
lalu buka URL yang dicetak. Buka URL yang dicetak. Model diharapkan ada di
`model/<nama>/<file>.model3.json` (lihat *Model assets* di bawah — **gak
di-commit** karena lisensi).

> `server.py` adalah server static lama tanpa proxy LLM/sheet. Untuk fitur agent
> pakai `server.js`.

**Setelah mengubah `server.js` / `js/app.js` / `agent.js`, restart server**
(Node tidak hot-reload — tutup jendela CMD lalu klik `start.bat` lagi).

---

## 🎮 Fitur & Status

| Fitur | Status | Catatan |
|-------|--------|---------|
| Viewer Live2D (load model, render) | ✅ | model apa pun di `model/` |
| Sheet per model (schema v4) | ✅ | inspeksi Cubism + label user + saran AI |
| Preset 4 kategori | ✅ | `emosi` / `properti` / `aksesoris` / `gerak` |
| Analisa sheet oleh LLM | ✅ | `POST /api/model/analyze-sheet`, output divalidasi ketat |
| Adopsi `.exp3` tak terdaftar | ✅ | ekspresi di disk tapi lupa didaftarkan di `model3.json` tetap kepakai |
| Injeksi gerak dari LLM | ✅ | directive `[EMOTION:] [GESTURE:] [ACC:] [PROP:] [HEAD:] [EYES:] [MOUTH:] [BODY:]` — `[PROP:]` & `[ACC:]` sudah tersambung ke LLM |
| Agent proaktif (idle/away/return/mood) | ✅ | panel **Kelakuan** + profil Hidup/Sedang/Tenang; mesin sudah lengkap |
| Deteksi mood via webcam | ✅ | opt-in, inferensi lokal, frame tidak di-upload |
| Mouse-follow (mata + kepala + badan) | ✅ | |
| TTS + lip-sync (osilasi) | ✅ | |
| Otak LLM (proxy `/api/chat`) | ✅ | multi-provider + fallback |
| Indikator keadaan hidup | ✅ | presence / mood + sumber / sisa masa tenang, real-time di UI |
| Kontrol adopsi `.exp3` (opt-out per file) | ✅ | tab Sheet → 🧬 Ekspresi Teradopsi |
| Motion Studio (editor keyframe per parameter) | ✅ | tab 🎬 Motion — timeline gaya Cubism Editor, **semua** parameter rig |
| Preview realtime saat mengedit | ✅ | geser slider / ketik angka / scrub playhead → model langsung berubah |
| Motion Registry + Runtime | ✅ | satu pipeline: gesture bawaan + motion model + motion buatan user |
| Motion buatan user dipakai AI | ✅ | directive `[MOTION:id]` + `[INTENSITY:]`, id divalidasi runtime & server |
| ✨ Analisa AI untuk motion | ✅ | `POST /api/motions/analyze` → deskripsi/tag/kecocokan emosi, butuh persetujuan user |
| 🪄 Buat motion dari teks | ✅ | `POST /api/motions/generate` → draft, di-preview lalu disetujui |
| STT mic (ngobrol 2 arah) | ⬜ | rencana |
| Lip-sync presisi (dari audio) | ⬜ | masih timer-osilasi |

### Interaksi
- **Gerak mouse** → mata + kepala + badan ikut
- **Drag** → geser posisi model
- **Scroll** → zoom in/out (zoom-out reveal full body)
- **Double-click** → reset posisi & framing

---

## 🧠 Arsitektur

```
index.html            UI (chat, tab Model/Sheet/Motion/AI, kontrol)
css/app.css           Dark glassmorphism theme
agent.js              Otak: system prompt, parse directive LLM, reactEvent, mood
js/app.js             Engine: render, role mapping, sheet, preset, TTS, lip-sync
js/camera-presence.js Webcam presence + mood (transformers.js, lokal)
js/motion-taxonomy.js Klasifikasi klip .motion3.json
js/motion-dsl.js      Format & validasi Motion Asset + evaluator keyframe
js/motion-registry.js Daftar semua gerakan (bawaan + model + buatan user)
js/motion-runtime.js  Satu-satunya pemutar animasi (scheduler + blending)
js/motion-editor.js   UI Motion Studio (timeline, metadata, preview)
server.js             Static server + LLM proxy + penyimpanan sheet & motion
config.json           Koneksi API + events + camera (gitignored)
sheets/<key>.json     Cache sheet per model
motions/<key>/*.json  Motion Asset buatan user (gitignored)
```

**LLM proxy:** browser → `POST /api/chat` → `server.js` → endpoint
OpenAI-compatible → balik teks → `agent.js` pecah jadi segmen + directive →
gerak + TTS. API key **hanya di server**, tidak pernah ke browser.

Frontend menurunkan origin backend dari `location.origin`, jadi `PORT=…`, akses
dari LAN, dan https semuanya jalan tanpa mengubah kode.

### Sistem gerak (Motion)
Satu pipeline untuk semua animasi:

```
Motion Asset → Motion Registry → Motion Runtime (scheduler + blending) → Live2D
```

Registry menggabungkan tiga sumber tanpa menyalin datanya: **9 gesture bawaan**
aplikasi, **motion `.motion3.json` milik model**, dan **Motion Asset buatan user**
dari Motion Studio. LLM hanya boleh MEMILIH id yang ada di registry — id asing
ditolak runtime dan dibersihkan server, lalu jatuh ke gesture biasa.

**Motion Studio bekerja pada parameter mentah rig** (seperti timeline Cubism
Editor), bukan pada beberapa field abstrak: satu track per parameter, keyframe
sendiri-sendiri, easing per key. Semua parameter yang dimiliki model bisa
dianimasikan — kepala, badan, rambut, alis, tangan, aksesoris — sejauh rigger
sudah membuat parameternya. Rigging sendiri tetap dikerjakan di Cubism Editor;
aplikasi ini hanya membaca daftar parameter dan memanipulasi nilainya.

Karena menyebut id parameter, motion buatan user **terikat ke model asalnya**
(`sourceModelId`). Dibuka di model lain, parameter yang tidak ada dilewati dengan
aman dan ditandai di UI (track abu-abu, "tidak ada di model ini") — tidak error,
tidak merusak data.

Motion lama berformat 8 field semantik tetap bisa dibuka: saat dimuat, field
diterjemahkan ke parameter rig memakai peta peran model yang sedang aktif, dengan
nilai diproyeksikan ke range asli parameter (delta 15° pada rig 0..1 menjadi 0.75,
bukan 15).

Spesifikasi + pagar yang tidak boleh dilanggar:
`docs/SPECIFICATION — Motion Studio & AI Motion System.md`,
`docs/CRITICAL UI & FLOW CONSTRAINTS.md`, rencana: `docs/PLAN-MOTION-STUDIO.md`.

### Sistem preset (sheet)
Empat kategori — `emosi`, `properti`, `aksesoris`, `gerak` — disimpan per model
di `localStorage` **dan** `sheets/<key>.json`. Tiga sumber dengan kepercayaan
berbeda: inspeksi Cubism (angka), user (`.user`, otoritatif), LLM (`.ai`, saran
yang butuh persetujuan). **`user` selalu menang atas `ai`.**

Detail lengkap + aturan yang tidak boleh dibalik: `docs/HANDOFF-SHEET-SYSTEM.md`.

---

## 🧪 Test

```bash
npm test                 # jalankan semua suite (cross-platform, via test/run-all.js)
# atau manual:
for f in test/test-*.js; do node "$f"; done
```

Baseline: **1234 passed, 0 failed** di 26 suite aktif (`test-taxonomy-ichika.js`
skip — butuh aset model Ichika yang tidak ada di repo). `test/run-all.js`
menjumlahkan tiap suite dan mengembalikan exit non-zero bila ada kegagalan,
cocok untuk CI.

Kalau mau ringkasan, grep `[0-9]+ passed, [0-9]+ failed`; jangan ambil baris
terakhir tiap suite — beberapa suite mencetak keterangan (atau baris kosong)
setelah ringkasannya, sehingga terlihat gagal padahal bersih.

---

## 📚 Dokumentasi

| File | Isi |
|---|---|
| `docs/PLAN-BESOK-ALIVE.md` | Rencana kerja aktif: proaktif, gerak natural, UI |
| `docs/HANDOFF-SHEET-SYSTEM.md` | Sistem sheet, API, aturan terkunci, utang teknis |
| `docs/MODEL-AGNOSTIC-RULES.md` | Kenapa & bagaimana tetap model-agnostic |
| `docs/SPECIFICATION — Motion Studio & AI Motion System.md` | Spesifikasi Motion Studio + pipeline gerak |
| `docs/CRITICAL UI & FLOW CONSTRAINTS.md` | Pagar: apa yang TIDAK boleh diubah saat menambah fitur |
| `docs/PLAN-MOTION-STUDIO.md` | Rencana implementasi Motion Studio (7 fase, sudah selesai) |

---

## 🔧 Troubleshooting
- **Karakter tidak pernah bicara sendiri?** Buka tab ⚙️ AI → **🎚️ Kelakuan
  (Proaktivitas)**, pilih profil **⚡ Hidup** lalu **💾 Simpan Kelakuan** — dia
  akan mulai bicara ~15 dtk. Atau cek `events.quietMs` / `idleMs` di
  `config.json` (default 30 menit). Indikator **⏳ masa tenang** di bawah chat
  menunjukkan sisa waktu; console mencetak `[agent] masa tenang, skip event`.
- **0 emosi terdeteksi?** Ekspresi yang ada di disk tapi tidak terdaftar di
  `model3.json` sekarang diadopsi otomatis; console mencetak
  `[exp3] adopted N undeclared expression file(s)`. Kalau tetap 0, berarti model
  itu memang tidak punya file `.exp3.json` — emosi harus dibuat sebagai preset
  `emosi` berbasis parameter di tab Sheet.
- **Semua fetch gagal padahal halaman kebuka?** Dulu penyebabnya port
  di-hardcode; sekarang origin diturunkan dari `location.origin`. Kalau kambuh,
  cek apakah ada literal `127.0.0.1:8310` yang menyusup balik
  (`node test/test-api-origin.js`).
- **Model blank di headless?** Normal — swiftshader headless gak render WebGL ke
  framebuffer; model tetap load (cek console `[Live2D] Model loaded`).

---

## ⚠️ Model assets
Folder `model/` **tidak di-commit** (binary berlisensi). Letakkan model Cubism 4
sendiri di `model/<nama>/<file>.model3.json`. Model v4 kompatibel dengan runtime
Cubism 5 (jangan buka & re-save di Editor v5 kalau mau balik v4).
