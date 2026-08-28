# RENCANA — "Terasa Hidup" — ✅ SELESAI

> Status: **semua langkah (1, 2a–2d, 3) sudah diimplementasikan & terverifikasi
> lewat test.** Dokumen ini disimpan sebagai arsip keputusan, bukan todo.
>
> Target: karakter **proaktif**, **gerak natural dari injeksi LLM**, dan **UI
> interaktif**. Kalau kode dan dokumen ini beda, **kode yang benar** — perbaiki
> dokumennya.

---

## 0. Temuan yang masih mengubah prioritas

### Temuan A — Proaktivitas praktis MATI karena config, bukan bug kode

`config.json` sekarang:

```json
"events": { "idleMs": 1800000, "idleRepeatMs": 1800000, "quietMs": 1800000 }
```

Artinya: **30 menit masa tenang** sejak app nyala (`inQuietPeriod()` di
`agent.js` memblokir SEMUA `reactEvent`), lalu idle baru bicara setelah
**30 menit** diam, dan ulangnya tiap **30 menit**. Jadi dalam sesi uji normal
(5–10 menit) karakter memang **tidak akan pernah** bereaksi sendiri. Mesinnya
sudah lengkap dan jalan — angkanya saja yang membuatnya diam.

Ini **data milik user**, jadi jangan diam-diam diubah. Yang benar: bikin UI-nya
(§2) supaya user bisa menyetel sendiri, dan sediakan **profil preset**
("Hidup / Sedang / Tenang") biar tidak perlu paham milidetik. Untuk sesi uji,
pakai nilai sementara — mis. `quietMs` 15000, `idleMs` 45000, `idleRepeatMs`
90000 — **dengan izin user**, jangan di-commit sebagai default diam-diam.

### Temuan B — SELESAI: `.exp3` yatim sekarang diadopsi otomatis

lumine punya **19** file `.exp3.json` di disk dengan `model3.json` mendaftarkan
**nol**, jadi `getCapabilityProfile()` melaporkan 0 emosi. Sudah dibereskan —
lihat "Adopsi `.exp3` yatim" di `docs/HANDOFF-SHEET-SYSTEM.md`, termasuk
**deviasi dari rencana awal** (adopsi otomatis in-memory, bukan daftar centang).

> Catatan angka: dokumen lama menyebut 27 file. Hitungan sebenarnya di disk
> adalah **19** untuk lumine dan **8** untuk 神宫白子 (semuanya terdaftar).

Yang **masih** berlaku dari temuan ini: `motionGroups` **kosong di kedua model**
(`Motions: []`), dan hanya ada **1** file `.motion3.json` di seluruh repo. Jadi
`[GESTURE:...]` sepenuhnya bergantung pada 9 gesture builtin di
`GESTURE_LIBRARY` (`nod, shake, tilt_curious, lean_excited, recoil_surprised,
look_away_shy, laugh_bounce, think, wave_hi`). Itu tidak apa-apa — memang
dirancang model-agnostic — tapi jangan berharap kekayaan gerak datang dari aset
model.

---

## 1. Langkah 1 — Sambungkan `properti` ke LLM (kecil, tapi menutup fase 4)

Prasyaratnya sudah selesai: `applyExpression()` memeriksa preset sebelum jatuh
ke `.exp3`. Yang belum: profil kemampuan **tidak pernah memberi tahu LLM** bahwa
preset `properti` ada, jadi LLM tidak akan pernah mengeluarkan `[PROP:...]`.

Komentar di `js/app.js` (~4760) sudah diperbarui jadi `TODO` yang menyatakan
alasan lamanya sudah tidak berlaku — jangan biarkan menyesatkan lagi.

- Tambahkan field baru di return `getCapabilityProfile()`, mis. `properties:
  presetNames('properti')`. **Jangan** digabung ke `nativeExpressions` —
  campuran itu menghilangkan beda provenance user vs rigger.
- Hanya preset `.user`. Saran `.ai` tetap tidak boleh masuk profil (aturan
  user > ai; entri `.ai` adalah usulan sampai user menekan "Pakai").
- `agent.js` bagian `=== DAFTAR EXPRESSION / PROPERTI BAWAAN ===` (baris ~100)
  sekarang cuma membaca `nativeExpressions`; tambahkan daftar properti user.
- Jalur eksekusi `[PROP:]` → `currentActions.property` → `agent.setExpression()`
  **sudah ada**, tidak perlu diubah.
- Test: perluas suite fase 3 — properti user muncul di profil, saran `.ai`
  TIDAK muncul, dan nama properti yang tidak ada tidak merusak segmen lain.

Setelah ini: 4/4 kategori preset punya jalur LLM (`emosi` via `supportedEmotions`,
`gerak` via `gestures`, `aksesoris` via `accessories`, `properti` via field baru).

## 2. Langkah 2 — UI interaktif (di sinilah "terasa hidup" jadi bisa dirasakan user)

Tiga hal, urut dari yang paling berdampak:

**2a. Panel "Kelakuan" (behaviour) — menyelesaikan Temuan A.**
Tab baru atau bagian di tab AI: slider/opsi untuk `quietMs`, `idleMs`,
`idleRepeatMs`, toggle `idleSpeak`/`awaySpeak`/`returnSpeak`. Sajikan sebagai
**profil** (Hidup / Sedang / Tenang) + mode lanjutan untuk angka mentah.
Tampilkan hitung mundur/status ("masa tenang: sisa 12 menit") — sekarang
satu-satunya cara tahu kenapa karakter diam adalah membaca console
(`[agent] masa tenang, skip event`). Itu bug pengalaman, bukan bug logika.

**2b. Indikator keadaan hidup.** Presence (kamera/tab), mood terdeteksi +
sumbernya (`camera` vs `text`), dan kapan event proaktif terakhir terjadi.
`window.__agent._reactiveState()` sudah mengembalikan semuanya — tinggal
dirender, tidak perlu logika baru.

**2c. Panel sheet: jadikan preset bisa dicoba.** Tombol pratinjau per preset,
tombol "tangkap pose sekarang", dan badge sumber (user 👤 / ai 🤖) yang jelas.
Ini yang mengubah sheet dari file jadi alat.

**2d. Opsional — kontrol adopsi `.exp3`.** Adopsi sekarang otomatis dan senyap
(kecuali satu baris console). Kalau nanti terasa terlalu banyak ekspresi
teradopsi, tambahkan daftar centang di tab Sheet; datanya sudah tersedia lewat
`GET /api/model/expressions` yang melaporkan flag `declared` per file.

## 3. Langkah 3 — Gerak natural (setelah 1–2 jalan)

- **Verifikasi ujung-ke-ujung** yang belum pernah dilakukan: kirim pesan asli,
  lalu buktikan dari log bahwa directive LLM benar-benar sampai ke gerakan —
  `[EMOTION:]`, `[GESTURE:]`, `[ACC:]`, `[PROP:]` masing-masing tereksekusi.
  Yang terbukti baru `[PROP:]` lewat pemanggilan manual.
- **Multi-segmen**: prompt sudah mewajibkan pecah per klausa. Cek apakah
  segmen benar-benar bergantian saat bicara, bukan berubah sekali di akhir.
- **Komposisi gesture di atas pose**: `playGesture()` sengaja dijalankan setelah
  `setAIPose()` supaya deltanya menumpuk. Pastikan tidak saling menimpa.
- `EMOTION_GESTURE_FALLBACK` (`agent.js`) sudah memberi gesture otomatis saat
  LLM lupa. Verifikasi ini aktif, karena inilah jaring pengaman "tidak pernah
  diam kaku".
- **Yang baru mungkin: verifikasi visual 19 ekspresi lumine.** Test membuktikan
  file ditemukan, path fetchable (HTTP 200 di jalur yang dibangun loader), dan
  manifest tergabung benar — tapi apakah wajahnya berubah sesuai harapan hanya
  bisa dilihat di browser.

## 4. Urutan yang wajib dipatuhi

```
Temuan A (config/UI kelakuan) ──┐
Langkah 1 (properti → LLM)    ──┴──> baru Langkah 3 (gerak natural) berarti
```

Alasannya sama seperti aturan "endpoint tidak boleh mendahului UI" di HANDOFF:
memperhalus gerak sebelum user bisa menyetel keproaktifan, atau sebelum semua
directive punya jalur, menghasilkan pekerjaan yang tidak bisa dilihat maupun
dinilai.

## 5. Definisi selesai (bisa diuji, bukan perasaan)

1. Buka app, diam < 1 menit → karakter mulai bicara sendiri **tanpa** mengubah
   file config secara manual.
2. Kirim satu pesan → log menunjukkan ≥ 2 segmen dengan emosi/gesture berbeda.
3. Keempat directive terbukti tereksekusi di log, masing-masing minimal sekali.
4. ✅ Model default punya > 0 emosi di `getCapabilityProfile()` — 19 teradopsi.
5. UI menampilkan presence, mood, dan status masa tenang.
6. Suite penuh tetap **≥ 901 passed, 0 failed**; setiap perilaku baru menambah
   test, bukan cuma menambah kode.

## 6. Jangan diulang (jebakan yang sudah pernah kena)

- Jangan pakai negative-lookahead setelah quantifier variabel (`=\s*(?!\[\])`)
  untuk assertion "tidak pernah ditulis" — regex bisa backtrack sampai lolos.
  Enumerasi tiap kemunculan lalu periksa satu-satu.
- Test yang mengunci **bentuk implementasi** (mis. `await fn()` sequential) akan
  memerah saat implementasinya sah berubah. Kunci **perilaku**.
- `clearTimeout` pada handle `setInterval` adalah no-op — bug ini sudah pernah
  membuat idle menembak selamanya. Batalkan dengan primitif yang benar.
- Angka `min`/`max`/`def` hanya dari Cubism Core. LLM tidak pernah boleh
  mengirim angka range, dan `steps` gerak dari LLM ditolak.
- **Jangan hardcode origin backend.** `server.js` menghormati `process.env.PORT`;
  literal `http://127.0.0.1:8310` di frontend membuat halaman tetap terbuka
  sementara **semua** fetch menembak port kosong. Turunkan dari
  `location.origin`. Dikunci `test/test-api-origin.js`.
- `config.json` milik user: minta izin sebelum menyentuh. Backup ada di
  `config.json.bak` (untracked).

## 7. Status (titik awal berikutnya)

- Fase 0–4 **selesai**, termasuk `POST /api/model/analyze-sheet` dengan validasi
  ketat, dan `applyExpression()` yang memeriksa preset lebih dulu.
- Adopsi `.exp3` yatim **selesai** — model default naik dari 0 ke 19 emosi.
- Origin backend **selesai** — tidak ada lagi port yang di-hardcode.
- Identitas karakter **model-agnostic**: diturunkan dari `config.displayName` →
  nama folder model → `'Live2D Agent'`. Tidak ada nama karakter di-hardcode.
- **Langkah 1 (`properti` → LLM) SELESAI** — `getCapabilityProfile()` sekarang
  mengiklankan `properties: capabilityPropertyNames(sheet)` (hanya `.user`,
  dipisah dari `nativeExpressions`); `agent.js` mencantumkannya di prompt.
- **Langkah 2a/2b/2c/2d (UI "terasa hidup") SELESAI**:
  - 2a Panel **Kelakuan** (profil Hidup/Sedang/Tenang + slider mentah + countdown
    masa tenang) dengan persist `POST /api/config saveEvents` (aman untuk apiKey).
  - 2b Indikator keadaan hidup (presence / mood + sumber / sisa masa tenang).
  - 2c Sheet jadi alat: tombol **Coba** per preset + badge sumber 👤/🤖.
    (Ditemukan & diperbaiki bug: `resolvePresets` tidak mengisi `source`, sehingga
    semua saran AI tampil sebagai user — sudah diperbaiki.)
  - 2d Kontrol adopsi `.exp3`: endpoint `GET/POST /api/model/expressions-adoption`
    + `filterAdoptable()` + checkbox per-file di tab Sheet.
- **Langkah 3 (verifikasi ujung-ke-ujung) SELESAI di level kode** — harness
  `test-fase4-endtoend.js` membuktikan `[EMOTION]/[GESTURE]/[ACC]/[PROP]` benar
  sampai ke panggilan engine (`setExpression`/`playGesture`/`setAccessory`),
  multi-segment, dan fallback tanpa direktif. (Bug parseSegments yang membuang
  direktif terakhir tanpa teks ikut diperbaiki.) Bukti VISUAL tetap ranah browser
  (WebGL + model + API key) — headless tidak render framebuffer.
- **993 passed, 0 failed** di 19 suite aktif (6 suite baru fase 4). Nol JS error
  di browser. Jalankan via `npm test` (test/run-all.js).
- **Sisa di luar rencana ini** (lihat README): STT mic (ngobrol 2 arah) dan
  lip-sync presisi dari audio — keduanya masih ⬜.

