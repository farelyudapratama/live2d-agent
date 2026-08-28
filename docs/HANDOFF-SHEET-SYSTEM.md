# Handoff — Sheet System per Model (Fase 0–4)

Dokumen hidup. Tujuannya: siapa pun (termasuk sesi berikutnya) bisa lanjut kerja
tanpa membaca ulang percakapan panjang. Kalau kode dan dokumen ini beda, **kode
yang benar** — perbaiki dokumennya.

> Rencana kerja berikutnya ada di **`docs/PLAN-BESOK-ALIVE.md`** (proaktif,
> gerak natural, UI interaktif). Dokumen ini fokus pada sistem sheet dan
> aturan-aturannya.

## Kenapa ada sistem sheet

Model Live2D tidak punya metadata semantik. `Param92` bisa berarti blush di satu
rig dan ekor di rig lain. Sheet adalah satu-satunya tempat aplikasi menyimpan
"apa arti parameter ini pada model INI", diisi dari tiga sumber dengan
kepercayaan berbeda:

| Sumber | Isi | Boleh menimpa? |
|---|---|---|
| Inspeksi Cubism (`inspectModel()`) | id, min, max, def, parts, motionGroups | angka = kebenaran, selalu ditimpa saat re-inspeksi |
| LLM (`.ai`) | label grup + usulan preset | **tidak pernah** menimpa `.user` |
| User (`.user`) | catatan, label grup, preset | otoritatif, wajib selamat dari re-inspeksi |

## Aturan yang tidak boleh "diperbaiki" balik

Empat aturan di bawah ini sudah beberapa kali dibalik oleh perubahan yang
kelihatan seperti pembersihan. Semuanya punya alasan, bukan selera.

1. **`user` > `ai`, mutlak.** Berlaku untuk `paramGroups` maupun `presets`.
   Turunan langsung dari `USER_AUTHORED_FIELDS` (`js/app.js`): re-inspeksi tidak
   boleh menghapus tulisan user. Entri `.ai` yang namanya bentrok dengan milik
   user **tidak** menimpa — ditampilkan sebagai saran terpisah berbadge 🤖
   sampai user menekan "Pakai". Lihat `resolvePresets()` dan `findPreset()`.

2. **`paramGroups` dan `presets` tetap DUA struktur.** `paramGroups` =
   kategorisasi (1 param → 1 label, untuk menyusun tampilan slider mentah).
   `presets` = aksi (1 nama → kombinasi banyak param+value/steps, untuk tombol).
   Label kategori tidak membawa nilai; preset tidak memberi tahu slider harus
   ditaruh di tab mana. Keduanya perlu. Jangan digabung.

3. **Namespace gerak: tabrakan dicegah saat SIMPAN, bukan saat lookup.**
   `playGesture()` resolve dengan urutan: motion native model → preset `gerak`
   user → `GESTURE_LIBRARY` builtin. Motion native adalah data intrinsik model,
   sekelas `.exp3` — bukan "saran AI" yang boleh dikalahkan preset. Jadi preset
   `gerak` **ditolak** kalau namanya sudah dipakai (`checkGerakName()`), dengan
   usulan nama alternatif (`suggestGerakName()`). Sheet lama yang sudah bentrok
   di disk diperbaiki sekali saat migrasi oleh `deshadowGerakPresets()`, rename
   + catat `renamedFrom` supaya UI bisa menjelaskan, bukan hapus.

4. **Angka hanya dari engine.** `min`/`max`/`def` datang dari Cubism Core saja.
   LLM tidak pernah boleh mengirim angka range, dan `steps` gerak buatan LLM
   ditolak — LLM hanya boleh MEMILIH nama yang benar-benar ada di
   `GESTURE_LIBRARY`/`motionGroups`. Semua value preset di-clamp ke range
   terukur saat apply (`applyPreset()`), jadi file sheet pun tidak dipercaya.

## Skema sheet v4

Migrasi non-destruktif v0→v4 di `migrateSheet()` (`js/app.js`).

```
v0  legacy tanpa versi
v1  + schemaVersion, userNote
v2  + config{}          (blink, idle, framing, TTS pitch/rate/lang per model)
v3  + rangeSource       (sheet pra-v3 mengaku "measured" padahal tebakan)
v4  + params[].userNote, paramGroups{user,ai}, presets{user,ai}
```

Preset punya 4 kategori: `emosi`, `properti`, `aksesoris`, `gerak`.
Batas struktural steps gerak: `STEP_MS_MIN` 40, `STEP_MS_MAX` 3000,
`STEP_COUNT_MAX` 12, `STEP_TOTAL_MS_MAX` 8000. Field delta hanya 8 nama semantik
(`ax ay bodyX bodyY bodyZ ex ey mouthForm`) — paramId mentah sengaja di-DROP
supaya preset gerak tetap model-agnostic.

Penyimpanan: `localStorage['live2d_sheet_' + currentModelKey()]` **dan**
`sheets/<key>.json` di server (atomic + serialized write via `queueJsonWrite`).
`currentModelKey()` diturunkan dari model PATH, dan sanitizernya identik dengan
`sanitizeKey()` di `server.js` — jangan ubah salah satu tanpa yang lain.

## API sheet (dipakai UI, diekspos di `window.__live2dAgent.sheet`)

| Fungsi | Guna |
|---|---|
| `saveUserPreset(preset)` | satu pintu simpan: validasi nama → upsert `presets.user` → localStorage + `POST /api/sheet` → invalidate cache capability |
| `resolvePresets(sheet, category)` | daftar preset untuk ditampilkan; entri `.ai` ditandai `suggestion: true` |
| `resolveParamGroup(sheet, id, heuristik)` | `user ?? ai ?? heuristik` |
| `checkGerakName(name, sheet)` | `{ok, code, conflictWith, message, suggestion}` — return objek, bukan throw, karena pemanggilnya field UI |
| `suggestGerakName(name, sheet)` | nama alternatif yang aman |
| `applyPreset(nameOrPreset, category)` | apply nilai (params via `setParameterValue`, parts via `setPartOpacity` — beda call, tidak bisa satu map) |
| `findPreset(name, category)` | lookup untuk `[ACC:]` / `playGesture()` sebelum fallback |
| `loadCharacterSheet()` | baca + migrasi dari localStorage |
| `deleteUserPreset(category, name)` | hapus satu preset user |
| `applyAISuggestion(category, name)` | promosikan satu entri `.ai` → `.user` (butuh klik user) |
| `triggerAIParamClassification()` | tulis `paramGroups.ai`, tidak menimpa heuristik |

## Status fase

- [x] **Fase 0 — hardening.** Validasi output LLM, clamp min/max, sanitasi HTML,
      batas payload + timeout, atomic write. Terkunci `test-fase0-hardening.js`.
- [x] **Fase 1 — schema v4 + userNote.** `test-fase1-sheet-schema.js` (217 test),
      `test-fase1-usernote-ui.js`.
- [x] **Fase 2 — logic preset/paramGroups.** Anti-shadowing, precedence,
      integrasi capability profile, proyeksi `emosi` → `supportedEmotions`.
- [x] **Fase 3 — UI sheet editor.** Tab 📋 Sheet: ringkasan sheet, daftar preset
      per kategori dengan badge sumber, editor preset, tombol Analisa AI.
      Terkunci `test-fase2-sheet-ui.js`.
- [x] **Fase 4 — endpoint analisa sheet.** `POST /api/model/analyze-sheet` lewat
      `llmWithFallback()` yang sudah ada. Terkunci `test-fase3-analyze-endpoint.js`.
      Diverifikasi lewat HTTP asli dengan LLM aktif: nol kebocoran
      `min`/`max`/`def`/`steps`, dedupe terhadap `existingNames` bekerja,
      params kosong → 200 + warning (bukan 500).
- [x] **`applyExpression()` cek preset dulu.** Preset `properti` sekarang punya
      jalur eksekusi; lookup preset mendahului `.exp3` native.
- [x] **Nama karakter model-agnostic.** Diturunkan dari `config.displayName` →
      nama folder model → `'Live2D Agent'`. Tidak ada literal di `index.html`.
- [x] **Adopsi `.exp3` yatim.** Model yang mengirim file `.exp3.json` tanpa
      mendaftarkannya di `model3.json` sekarang tetap dapat ekspresinya. Lihat
      bagian "Adopsi `.exp3` yatim" di bawah. Terkunci `test-exp3-adoption.js`.
- [x] **Origin backend diturunkan, bukan literal.** Terkunci `test-api-origin.js`.
- [ ] **Sisa: `properti` belum sampai ke LLM.** `applyExpression()` sudah bisa
      me-resolve preset `properti`, tapi `getCapabilityProfile()` belum
      mendaftarkannya ke LLM, jadi LLM tidak pernah mengeluarkan `[PROP:]`.
      Lihat `docs/PLAN-BESOK-ALIVE.md` §1.

## Adopsi `.exp3` yatim

Masalahnya di bundle `pixi-live2d-display@0.4.0`:

```js
init(t){super.init(t),this.settings.expressions&&(this.expressionManager=new Ge(...))}
```

ExpressionManager **hanya** dibuat kalau `settings.expressions` truthy. lumine
punya 19 file `.exp3.json` di disk dan `model3.json`-nya mendaftarkan **nol**,
jadi manager-nya tidak pernah lahir dan 19 aset itu mati **tanpa satu pun
error** — persis kelas kegagalan senyap yang jadi alasan
`docs/MODEL-AGNOSTIC-RULES.md` ada.

Dua bagian:

| Bagian | Apa |
|---|---|
| `GET /api/model/expressions?name=X` | Menyusuri folder model, melaporkan setiap `.exp3` dengan `File` **relatif terhadap direktori `model3.json`** (itu yang di-resolve loader, bukan relatif folder model), plus flag `declared` per file dan `orphanCount` |
| `buildModelSettings()` (`js/app.js`) | Menggabungkan hanya yang **belum** terdaftar ke salinan **in-memory** manifest, lalu menyerahkan objek itu ke `Live2DModel.from()` alih-alih string URL |

**Deviasi dari rencana awal.** `PLAN-BESOK-ALIVE.md` §2 dulu meminta daftar
centang ("ditemukan N ekspresi tidak terdaftar — pakai?") dengan alasan "jangan
auto-load diam-diam". Yang diterapkan adalah adopsi **otomatis**, karena file
`.exp3` di folder model adalah data intrinsik model — sekelas motion native di
aturan #3 — bukan tebakan aplikasi tentang makna. Yang ditebak hanyalah niat
rigger untuk mengaktifkannya, dan biaya salah tebak asimetris: mengadopsi
ekspresi yang tak terpakai hanya menambah nama di daftar, sementara tidak
mengadopsi membuat 19 aset mati senyap. Kalau nanti terasa berlebihan, UI
centang bisa ditambahkan di atas endpoint yang sudah ada — flag `declared`
sudah disediakan untuk itu.

Aturan yang wajib dipertahankan:

- **Manifest lengkap → `null`.** Fungsi mengembalikan `null` sehingga pemuatan
  jatuh ke jalur URL biasa, persis seperti sebelum fitur ini ada. 神宫白子 (8/8
  sudah terdaftar) tidak disentuh sama sekali.
- **Nama duplikat tidak pernah di-append.** `getExpressionIndex()` melakukan
  `definitions.findIndex(e => e.Name === t)`, jadi entri kedua bernama sama akan
  tak terjangkau selamanya. Deklarasi rigger yang menang.
- **File di disk tidak pernah ditulis.** Adopsi murni in-memory; test
  membandingkan byte manifest sebelum/sesudah.
- **Setiap kegagalan → `null`.** Server mati, JSON rusak, payload aneh, path di
  luar `model/` — semuanya jatuh ke pemuatan biasa. Adopsi secara struktural
  tidak bisa menggagalkan pemuatan model.
- **File `.exp3` di ATAS direktori `model3.json` dilewati**, karena path
  relatifnya tidak akan pernah resolve.
- Nama ekspresi diambil **verbatim** dari nama file pilihan rigger (CJK,
  numerik, snake_case lewat apa adanya). Test memerahkan build kalau ada yang
  menyelipkan `'lumine'`, `神宫白子`, `'mothion'`, atau `exp_angry` ke handler.

Efek terukur: model default naik dari **0 → 19** emosi di
`getCapabilityProfile()`.

**Temuan sampingan:** `stripBom()` dipanggil di `server.js` tapi tidak pernah
didefinisikan. Cubism Editor dan beberapa tool Windows menulis `model3.json`
dengan BOM, dan `JSON.parse()` melempar padanya — manifest valid akan terlihat
rusak. Sekarang ada, dengan test bermanifest-BOM yang membuktikan
`declaredCount` terbaca 1, bukan 0.

## Urutan kerja yang wajib dipatuhi

Endpoint analisa **tidak boleh** mendahului UI. Hasilnya masuk `presets.ai`;
tanpa panel yang menampilkannya + tombol approve, output LLM cuma menumpuk di
file tanpa pernah bisa dipakai atau ditolak user.

## Model-agnostic

Aturan lengkap di `docs/MODEL-AGNOSTIC-RULES.md`. Ringkas: tidak ada nama
karakter, id parameter, atau angka range yang di-hardcode di kode. Nama tampilan
karakter diambil dari `config.displayName` di sheet (default = nama folder
model), bukan literal di `index.html`.

## Agen reaktif (sudah selesai — keputusan yang terkunci)

Rencana terpisah `docs/PLAN-ReactiveAgent.md` sudah **selesai seluruhnya** dan
dokumennya dihapus. Yang tersisa di sini hanya keputusan yang masih mengikat,
karena keputusan-keputusan ini beberapa kali hampir dibalik:

- **Kamera opt-in, default MATI.** Inferensi 100% lokal di browser
  (transformers.js); frame webcam tidak pernah di-upload ke server mana pun.
- **Ekspresi wajah user = INPUT mood**, bukan untuk dicermin balik tiap frame.
  Mood adalah gabungan kamera + teks ketikan.
- **Presence punya satu hub.** Ada dua produsen (modul webcam, dan fallback
  visibility/focus tab) dan keduanya tidak boleh dipercaya sekaligus. Semua
  memanggil `window.__agent.setPresence()`, agen memanggil balik
  `window.__l2dPresenceChanged()`. Sebelum aturan ini, menyalakan kamera justru
  **mematikan** semua event idle karena `presence` hanya pernah di-set di jalur
  fallback.
- **Izin kamera ditolak → `setPresence(null)`**, bukan `false`. Mode fallback
  memakai visibility saja; jangan pernah men-trigger "away" dari ketidaktahuan.
- Anti-jitter: mood hanya trigger saat label berubah + debounce, presence butuh
  `awayHiddenMs` konsisten sebelum dinyatakan away.

State runtime bisa dibaca lewat `window.__agent._reactiveState()`.

## Test

```bash
cd /f/backup/live2d-agent
for f in test/test-*.js; do node "$f"; done
```

Baseline saat ini: **901 passed, 0 failed** di 13 suite aktif
(`test-taxonomy-ichika.js` skip karena butuh aset model Ichika yang tidak ada di
repo). Setiap fase baru menambah suite sendiri; jangan biarkan angka turun.

Catatan menjalankan: loop di atas mencetak semua baris. Kalau mau ringkasan,
jangan ambil baris terakhir tiap suite sebagai hasil — suite yang men-skip
mencetak keterangan setelah ringkasannya, dan `test-motion-taxonomy.js` menutup
dengan baris kosong, sehingga keduanya terlihat gagal padahal bersih.
Grep `[0-9]+ passed, [0-9]+ failed` saja.

## Utang teknis / catatan

- **`properti` SELESAI sampai ke LLM.** `getCapabilityProfile()` sekarang
  mengiklankan `properties: capabilityPropertyNames(sheet)` (hanya branch
  `.user`, dipisah dari `nativeExpressions`), dan `agent.js` mencantumkannya di
  prompt "DAFTAR EXPRESSION / PROPERTI BAWAAN" — sehingga LLM mengeluarkan
  `[PROP:]`. Lihat `test-fase4-properties.js`.
- **`motionGroups` kosong di kedua model bundled** dan hanya ada 1 file
  `.motion3.json` di repo. Jadi `[GESTURE:]` sepenuhnya bergantung pada 9
  gesture builtin `GESTURE_LIBRARY`. Ini konsekuensi aset, bukan bug.
- **Proaktivitas diatur via UI, bukan lagi cuma config.** Mesin
  `reactEvent`/presence/mood sudah lengkap; sekarang ada panel **Kelakuan** (tab
  ⚙️ AI) dengan profil Hidup/Sedang/Tenang + slider mentah + countdown masa
  tenang, persist via `POST /api/config saveEvents` (aman untuk apiKey).
  Default `config.json` user tetap 30 menit (Tenang) — sesuai aturan data milik
  user.
- **Badge sumber preset diperbaiki.** `resolvePresets()` kini mengisi `source`
  (`user`/`ai`) + `suggestion`, sehingga saran AI (🤖) tampil berbeda dari
  preset user (👤) dan tombol "Pakai" bisa menyetujuinya. Sebelumnya semua
  tampil sebagai user (bug senyap). Lihat `test-fase4-sheetbadge.js`.
- **Adopsi `.exp3` belum diverifikasi visual.** Test membuktikan file ditemukan,
  path fetchable, dan manifest tergabung benar — tapi apakah 19 ekspresi lumine
  *terlihat* benar saat dirender hanya bisa dikonfirmasi di browser. Penanda di
  console: `[exp3] adopted N undeclared expression file(s) for <model>`. Ada
  juga kontrol opt-out per-file di tab 📋 Sheet (🧬 Ekspresi Teradopsi).
- **`package.json` SUDAH ada** — jalankan `npm test` (menjalankan
  `test/run-all.js`, cross-platform). Baseline **993 passed, 0 failed** di 19
  suite. `test-taxonomy-ichika.js` skip (butuh aset model Ichika).
- `config.json` milik user pernah berisi koneksi rusak (`baseUrl` invalid →
  error "Invalid URL" saat chat) dan `systemPrompt` yang menyebut nama karakter
  berbeda dari model yang dimuat. Keduanya sudah dibersihkan (backup:
  `config.json.bak`, untracked). Tetap berlaku: ini data milik user, **minta izin
  dulu** sebelum menyentuh. (Fyi: `config.json.bak` **tidak** di-ignore oleh
  `.gitignore` — jangan commit file itu karena memuat API key.)
