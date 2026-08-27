# RENCANA BESOK — "Terasa Hidup"

Target akhir hari: karakter **proaktif**, **gerak natural dari injeksi LLM**, dan
**UI interaktif**. Dokumen ini urutan kerja + alasannya, bukan daftar keinginan.

Kalau kode dan dokumen ini beda, **kode yang benar** — perbaiki dokumennya.

---

## 0. Dua temuan yang harus dibaca dulu

Keduanya ditemukan saat verifikasi hari ini dan **mengubah prioritas**. Tanpa
memperbaiki dua ini, semua kerja lain di bawah tidak akan terasa hidup.

### Temuan A — Proaktivitas saat ini praktis MATI karena config, bukan bug kode

`config.json` sekarang:

```json
"events": { "idleMs": 1800000, "idleRepeatMs": 1800000, "quietMs": 1800000 }
```

Artinya: **30 menit masa tenang** sejak app nyala (`inQuietPeriod()` di
`agent.js:561` memblokir SEMUA `reactEvent`), lalu idle baru bicara setelah
**30 menit** diam, dan ulangnya tiap **30 menit**. Jadi dalam sesi uji normal
(5–10 menit) karakter memang **tidak akan pernah** bereaksi sendiri. Mesinnya
sudah lengkap dan jalan — angkanya saja yang membuatnya diam.

Ini **data milik user** (lihat catatan di akhir HANDOFF), jadi jangan diam-diam
diubah. Yang benar: bikin UI-nya (lihat §3) supaya user bisa menyetel sendiri,
dan sediakan **profil preset** ("Hidup / Sedang / Tenang") biar tidak perlu
paham milidetik. Untuk sesi uji besok, pakai nilai sementara — mis. `quietMs`
15000, `idleMs` 45000, `idleRepeatMs` 90000 — **dengan izin user**, jangan
di-commit sebagai default diam-diam.

### Temuan B — lumine punya 27 file `.exp3` di disk tapi `model3.json` mendaftarkan NOL

```
find model -name "*.exp3.json"           → 27 file
lumine.model3.json  FileReferences.Expressions → 0   ← kosong
面饼0.model3.json    FileReferences.Expressions → 8   ← terdaftar
```

Inilah sebab sebenarnya `getCapabilityProfile()` melaporkan **0 emosi** untuk
lumine, dan kenapa `supportedEmotions` kosong di sheet. File `exp_angry`,
`exp_sad`, `exp_blush`, `exp_tear`, `exp_heart`, `exp_sparkling` dll **ada di
folder `mothion/`** tapi runtime tidak pernah tahu karena `model3.json` tidak
mereferensikannya. Jadi bukan model tanpa ekspresi — model dengan manifest tidak
lengkap.

Konsekuensi: sebelum ini dibereskan, LLM tidak punya satu pun emosi untuk
di-inject pada model default, dan seluruh pekerjaan "gerak natural" tidak akan
kelihatan.

Juga: `motionGroups` **kosong di kedua model** (`Motions: []`), dan hanya ada
1 file `.motion3.json` di seluruh repo. Jadi `[GESTURE:...]` sepenuhnya
bergantung pada 9 gesture builtin di `GESTURE_LIBRARY` (`nod, shake,
tilt_curious, lean_excited, recoil_surprised, look_away_shy, laugh_bounce,
think, wave_hi`). Itu tidak apa-apa — memang dirancang model-agnostic — tapi
jangan berharap kekayaan gerak datang dari aset model.

---

## 1. Langkah 1 — Sambungkan `properti` ke LLM (kecil, tapi menutup fase 4)

Prasyaratnya sudah selesai hari ini: `applyExpression()` sekarang memeriksa
preset sebelum jatuh ke `.exp3`. Yang belum: profil kemampuan **tidak pernah
memberi tahu LLM** bahwa preset `properti` ada, jadi LLM tidak akan pernah
mengeluarkan `[PROP:...]`.

Komentar di `js/app.js:4510` masih menyatakan pengecualian ini sebagai sengaja —
**alasannya sudah tidak berlaku**, jadi komentarnya wajib diperbarui bersama
kodenya, jangan ditinggal menyesatkan sesi berikutnya.

- Tambahkan field baru di return `getCapabilityProfile()`, mis. `properties:
  presetNames('properti')`. **Jangan** digabung ke `nativeExpressions` —
  campuran itu menghilangkan beda provenance user vs rigger.
- Hanya preset `.user`. Saran `.ai` tetap tidak boleh masuk profil (aturan
  user > ai; entri `.ai` adalah usulan sampai user menekan "Pakai").
- `agent.js` bagian `=== DAFTAR EXPRESSION / PROPERTI BAWAAN ===` (baris ~92)
  sekarang cuma membaca `nativeExpressions`; tambahkan daftar properti user.
- Jalur eksekusi `[PROP:]` → `currentActions.property` → `agent.setExpression()`
  **sudah ada** (`agent.js:359`), tidak perlu diubah.
- Test: perluas suite fase 3 — properti user muncul di profil, saran `.ai`
  TIDAK muncul, dan nama properti yang tidak ada tidak merusak segmen lain.

Setelah ini: 4/4 kategori preset punya jalur LLM (`emosi` via `supportedEmotions`,
`gerak` via `gestures`, `aksesoris` via `accessories`, `properti` via field baru).

## 2. Langkah 2 — Bikin model default punya bahan (menindaklanjuti Temuan B)

Tanpa ini Langkah 1 tidak akan terlihat efeknya.

- **Pemindai `.exp3` yatim.** Saat inspeksi, pindai folder model untuk
  `*.exp3.json` yang **tidak** terdaftar di `model3.json`, tawarkan ke user
  sebagai daftar centang ("ditemukan 27 ekspresi tidak terdaftar — pakai?").
  Jangan auto-load diam-diam: file di folder model belum tentu dimaksudkan
  aktif, dan menebak lalu diam adalah pelanggaran aturan model-agnostic.
- Yang dipilih user masuk sebagai preset `properti`/`emosi` user (bukan `.ai`),
  atau di-register ke runtime expression manager — putuskan besok setelah
  melihat bagaimana `pixi-live2d-display` menerima ekspresi tambahan pasca-load.
- **Fallback tetap wajib:** model yang benar-benar tidak punya `.exp3` harus
  tetap dapat set emosi dari preset sintetis berbasis parameter (jalur yang
  sudah ada). Pemindai ini bonus, bukan syarat.
- Test: model dengan manifest kosong + folder berisi `.exp3` → terdeteksi;
  model tanpa file apa pun → nol deteksi, tanpa error.

## 3. Langkah 3 — UI interaktif (di sinilah "terasa hidup" jadi bisa dirasakan user)

Tiga hal, urut dari yang paling berdampak:

**3a. Panel "Kelakuan" (behaviour) — menyelesaikan Temuan A.**
Tab baru atau bagian di tab AI: slider/opsi untuk `quietMs`, `idleMs`,
`idleRepeatMs`, toggle `idleSpeak`/`awaySpeak`/`returnSpeak`. Sajikan sebagai
**profil** (Hidup / Sedang / Tenang) + mode lanjutan untuk angka mentah.
Tampilkan hitung mundur/status ("masa tenang: sisa 12 menit") — sekarang
satu-satunya cara tahu kenapa karakter diam adalah membaca console
(`[agent] masa tenang, skip event`). Itu bug pengalaman, bukan bug logika.

**3b. Indikator keadaan hidup.** Presence (kamera/tab), mood terdeteksi +
sumbernya (`camera` vs `text`), dan kapan event proaktif terakhir terjadi.
`window.__agent._reactiveState()` sudah mengembalikan semuanya
(`agent.js:756`) — tinggal dirender, tidak perlu logika baru.

**3c. Panel sheet: jadikan preset bisa dicoba.** Tombol pratinjau per preset,
tombol "tangkap pose sekarang", dan badge sumber (user 👤 / ai 🤖) yang jelas.
Ini yang mengubah sheet dari file jadi alat.

## 4. Langkah 4 — Gerak natural (setelah 1–3 jalan)

Jangan dikerjakan sebelum Langkah 2, karena tanpa emosi/ekspresi yang hidup
perbaikan halus di sini tidak akan terasa.

- **Verifikasi ujung-ke-ujung** yang belum pernah dilakukan: kirim pesan asli,
  lalu buktikan dari log bahwa directive LLM benar-benar sampai ke gerakan —
  `[EMOTION:]`, `[GESTURE:]`, `[ACC:]`, `[PROP:]` masing-masing tereksekusi.
  Hari ini yang terbukti baru `[PROP:]` lewat pemanggilan manual.
- **Multi-segmen**: prompt sudah mewajibkan pecah per klausa. Cek apakah
  segmen benar-benar bergantian saat bicara, bukan berubah sekali di akhir.
- **Komposisi gesture di atas pose**: `playGesture()` sengaja dijalankan setelah
  `setAIPose()` supaya deltanya menumpuk. Pastikan tidak saling menimpa.
- `EMOTION_GESTURE_FALLBACK` (`agent.js:256`) sudah memberi gesture otomatis
  saat LLM lupa. Verifikasi ini aktif, karena inilah jaring pengaman "tidak
  pernah diam kaku".

## 5. Urutan yang wajib dipatuhi

```
Temuan A (config/UI kelakuan) ──┐
Temuan B (bahan ekspresi)     ──┼──> baru Langkah 4 (gerak natural) berarti
Langkah 1 (properti → LLM)    ──┘
```

Alasannya sama seperti aturan "endpoint tidak boleh mendahului UI" di HANDOFF:
memperhalus gerak sebelum ada emosi untuk digerakkan, atau sebelum user bisa
menyetel keproaktifan, menghasilkan pekerjaan yang tidak bisa dilihat maupun
dinilai.

## 6. Definisi selesai (bisa diuji, bukan perasaan)

1. Buka app, diam < 1 menit → karakter mulai bicara sendiri **tanpa** mengubah
   file config secara manual.
2. Kirim satu pesan → log menunjukkan ≥ 2 segmen dengan emosi/gesture berbeda.
3. Keempat directive terbukti tereksekusi di log, masing-masing minimal sekali.
4. Model default punya > 0 emosi di `getCapabilityProfile()`.
5. UI menampilkan presence, mood, dan status masa tenang.
6. Suite penuh tetap **≥ 768 passed, 0 failed**; setiap perilaku baru menambah
   test, bukan cuma menambah kode.

## 7. Jangan diulang (jebakan yang sudah pernah kena)

- Jangan pakai negative-lookahead setelah quantifier variabel (`=\s*(?!\[\])`)
  untuk assertion "tidak pernah ditulis" — regex bisa backtrack sampai lolos.
  Enumerasi tiap kemunculan lalu periksa satu-satu.
- Test yang mengunci **bentuk implementasi** (mis. `await fn()` sequential) akan
  memerah saat implementasinya sah berubah. Kunci **perilaku**.
- `clearTimeout` pada handle `setInterval` adalah no-op — bug ini sudah pernah
  membuat idle menembak selamanya. Batalkan dengan primitif yang benar.
- Angka `min`/`max`/`def` hanya dari Cubism Core. LLM tidak pernah boleh
  mengirim angka range, dan `steps` gerak dari LLM ditolak.
- `config.json` milik user: minta izin sebelum menyentuh. Backup hari ini ada di
  `config.json.bak`.

## 8. Status hari ini (titik awal besok)

- Fase 0–4 **selesai**, termasuk `POST /api/model/analyze-sheet` dengan validasi
  ketat, dan `applyExpression()` yang memeriksa preset lebih dulu.
- Identitas karakter **model-agnostic**: diturunkan dari `config.displayName` →
  nama folder model → `'Live2D Agent'`. Tidak ada nama karakter di-hardcode.
- `config.json` bersih: koneksi rusak dihapus, `systemPrompt` netral.
- **768 passed, 0 failed** di 10 suite. Nol JS error di browser.
- Belum diverifikasi ujung-ke-ujung: injeksi LLM → gerak nyata (§4).
