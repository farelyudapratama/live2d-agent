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
index.html            UI (chat, tab Model/Sheet/AI, kontrol)
css/app.css           Dark glassmorphism theme
agent.js              Otak: system prompt, parse directive LLM, reactEvent, mood
js/app.js             Engine: render, role mapping, sheet, preset, TTS, lip-sync
js/camera-presence.js Webcam presence + mood (transformers.js, lokal)
js/motion-taxonomy.js Klasifikasi klip .motion3.json
server.js             Static server + LLM proxy + penyimpanan sheet
config.json           Koneksi API + events + camera (gitignored)
sheets/<key>.json     Cache sheet per model
```

**LLM proxy:** browser → `POST /api/chat` → `server.js` → endpoint
OpenAI-compatible → balik teks → `agent.js` pecah jadi segmen + directive →
gerak + TTS. API key **hanya di server**, tidak pernah ke browser.

Frontend menurunkan origin backend dari `location.origin`, jadi `PORT=…`, akses
dari LAN, dan https semuanya jalan tanpa mengubah kode.

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

Baseline: **993 passed, 0 failed** di 19 suite aktif (`test-taxonomy-ichika.js`
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
