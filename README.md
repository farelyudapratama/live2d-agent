# 🎭 Live2D Agent — 神宫白子 (Jingū Shirako)

Agent maskot anime **Live2D Cubism 4** yang bisa ngomong (TTS browser),
gerak ngikutin mouse, punya otak LLM (lewat proxy server), dan diatur
dari panel web. Tujuannya:桌面 pet/VTuber-style assistant lokal.

> **Status:** WIP — lihat *Progress* di bawah. Engine render: **PixiJS v6.5.10**
> + `pixi-live2d-display@0.4.0` + **Live2D Cubism Core 4** (bundled offline).

---

## 🚀 Cara Menjalankan

```bash
cd live2d-agent
node server.js            # server static + LLM proxy di http://127.0.0.1:8310
# atau: python server.py
```

Buka `http://127.0.0.1:8310`. Model diharapkan ada di `model/<nama>/<file>.model3.json`
(lihat *Model assets* di bawah — **gak di-commit** karena lisensi).

---

## 🎮 Fitur & Status

| Fitur | Status | Catatan |
|-------|--------|---------|
| Viewer Live2D (load model, render) | ✅ Done | model 神宫白子 |
| Ekspresi wajah (synthetic dari param) | ✅ Done | senang/sedih/marah/malu/normal |
| Preset emosi user (kustom, localStorage) | ✅ Done | tombol ＋ Emosi, per-model |
| Aksesoris / .exp3 model | ✅ Done | toggle celemek, kacamata, dll |
| Mouse-follow (mata + kepala + badan) | ✅ Done | lihat *Changelog 2026-08-22* |
| TTS browser + lip-sync (osilasi) | ✅ Done | verified maxMouth≈0.69 |
| Otak LLM (proxy `/api/chat`) | 🟡 Done dasar | mock verified; perlu test key asli |
| Panel AI Connections (9router-style) | 🟡 Frontend done | backend done, belum live-test |
| Zoom / full-body view | 🟡 Done | tombol full-body ada |
| STT mic (ngobrol 2 arah) | ⬜ Belum | rencana |
| Lip-sync presisi (dari audio) | ⬜ Belum | masih timer-osilasi |
| Preset emosi user (kustom) | ⬜ Belum | rencana |

### Interaksi
- **Gerak mouse** → mata + kepala + badan ikut (badan condong halus, 25% gerak kepala)
- **Drag** → geser posisi model
- **Scroll** → zoom in/out (zoom-out reveal full body)
- **Double-click** → reset posisi & framing

---

## 🧠 Arsitektur

```
index.html          UI (chat bubble, emotion buttons, AI Connections panel)
css/app.css          Dark glassmorphism theme
agent.js             Browser-side agent glue (memory, panggil /api/chat, emosi)
js/app.js            Engine inti: render, mouse-follow, TTS, lip-sync, ekspresi
js/live2dcubismcore.min.js   Live2D Cubism Core 4 runtime
js/pixi.6.5.10.min.js        PixiJS v6
js/pixi-live2d-0.4.0.js      pixi-live2d-display SDK bridge
server.js            Static server + LLM proxy (multi-provider, 9router-style)
config.json          API connections (gitignored)
```

**LLM proxy:** browser → `POST /api/chat` → `server.js` → endpoint OpenAI-compatible
user → balik teks → `agent.js` feed ke `speak()`. API key **hanya di server**,
tidak ke browser.

### Sistem Emosi (Preset)
Ada **3 lapis** emosi, semua di-tab EMOSI:
1. **DEFAULT TEMPLATES** (selalu ada, model-agnostic): `senang / sedih / malu / kaget / normal`.
   Difilter otomatis ke param yang model ini punya. Tujuannya: model dengan
   **< 2 emosi bawaan punya set emosi lengkap** dari sistem.
2. **USER PRESETS** (kustom): tombol **＋ Emosi** buka modal editor — atur
   param wajah (slider −1..1) → simpan. Tersimpan di `localStorage` **per-model**
   (`live2d_emotions_<namaModel>`), jadi tiap model punya preset sendiri.
   Klik = pakai, double-click = edit, 🗑 = hapus.
3. **EMOSI BAWAAN MODEL** (`.exp3`): kalau model punya exp3 sendiri, tetap
   ditampilkan di bawah separator "— exp3 bawaan model —".

Public API: `window.__live2dAgent.saveUserEmotion(name, {ParamX:val})` /
`.deleteUserEmotion(name)` (bisa dipanggil agent/LLM).

---

## 📁 Struktur

```
live2d-agent/
├── index.html
├── css/app.css
├── agent.js                 ← browser agent glue
├── js/
│   ├── app.js               ← engine inti
│   ├── live2dcubismcore.min.js
│   ├── pixi.6.5.10.min.js
│   └── pixi-live2d-0.4.0.js
├── model/                   ← (gitignored, ~76MB) model Live2D
├── server.js / server.py    ← server
├── config.json              ← (gitignored) API connections
└── README.md
```

---

## 📝 Changelog

### 2026-08-22 (2)
- **Sistem preset emosi 3 lapis:**
  - DEFAULT TEMPLATES (senang/sedih/malu/kaget/normal) selalu ada & difilter
    ke param model — model dengan < 2 emosi bawaan tetap dapet set lengkap.
  - USER PRESETS: tombol ＋ Emosi → modal editor (slider param wajah) → simpan
    ke localStorage per-model (`live2d_emotions_<namaModel>`). Edit (dbl-click),
    hapus (🗑). Bisa dipanggil via `window.__live2dAgent.saveUserEmotion`.
  - Emosi bawaan model (.exp3) tetap ditampilkan terpisah.
- Fix saveUserEmotion: trust input user walau deteksi param gagal (size 0).

### 2026-08-22 (1)
- **Fix mouse-follow terbalik:** tanda Y kepala dibalik (`tay = dy * -55`)
  supaya kepala nengok ke arah SAMA dengan mata (sebelumnya mouse ke bawah
  = kepala ke atas).
- **Fix gerak "ketahan":** `lookFrame` dihitung segar tiap mousemove (sebelumnya
  di-cache → stale pas zoom/resize). Ease factor `0.18 → 0.28`, clamp kepala
  `-35 → -42°`.
- **Badan ikut gerak:** model punya `ParamBodyAngleX` asli → badan condong halus
  ngikutin kursor (25% gerak kepala) biar gerakan luwes, bukan kepala doang.

---

## 🔧 Troubleshooting
- **Model blank di headless?** Normal — swiftshader headless gak render WebGL
  ke framebuffer; model tetap load (cek console `[Live2D] Model loaded`).
- **Server background gagal "stdin is not a tty"?** Jalankan
  `node server.js < /dev/null` atau `start /min node server.js`.

---

## ⚠️ Model assets
Folder `model/` **tidak di-commit** (binary berlisensi ~76MB). Letakkan model
Cubism 4 sendiri di `model/<nama>/<file>.model3.json`. Model v4 kompatibel
dengan runtime Cubism 5 (jangan buka & re-save di Editor v5 kalau mau balik v4).

Built with 💜 untuk 神宫白子
