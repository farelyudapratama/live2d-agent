# Multi-LLM Role Routing — Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task.

**Goal:** Pisahkan satu LLM "serba bisa" menjadi beberapa LLM ber-PERAN (chat / motion / specialist), supaya prompt teks tidak lagi tercemar detail parameter, dan agent bisa diperluas ke tugas lain (coding, email, dst) tanpa membebani LLM pembicara.

**Architecture:** Menempel pada array `connections` + `llmWithFallback()` yang SUDAH ada di `server.js` — bukan sistem baru. Tiap connection diberi tag `roles: []`. Endpoint memanggil `llmForRole(role, ...)` yang menyaring connections berdasarkan role lalu memakai kebijakan retry/cooldown yang sama. Connection lama tanpa `roles` dianggap punya SEMUA role (kompatibel mundur, tidak ada yang rusak).

**Tech Stack:** Node.js murni (tanpa dependency), vanilla JS frontend, test harness `vm`-sandbox gaya `test/test-fase*.js`.

---

## 0. Konteks & fakta kode saat ini (sudah diverifikasi)

| Hal | Kondisi sekarang | Berkas:baris |
|---|---|---|
| Penyimpanan koneksi | `config.json` → `{ activeId, connections: [...] }` | `server.js:31` |
| Pemilih koneksi | `getActiveConnection()` = `activeId` atau `connections[0]` | `server.js:90-95` |
| Retry/cooldown | `llmWithFallback(messages, clientSystem)` — active dulu, lalu sisanya urut config; skip yang `rateLimitedUntil` | `server.js:412-457` |
| Pass 1 (teks) | `POST /api/chat` → `llmWithFallback` | `server.js:464-489` |
| Pass 2 (motion) | `POST /api/animate-text` → `llmWithFallback` (Animation Director) | `server.js:937-1020` |
| Analisa preset | `POST /api/model/analyze-sheet` | `server.js:779` |
| Klasifikasi param | `POST /api/model/classify-params` | `server.js:680` |
| CRUD koneksi | `POST /api/config` action `add/update/delete/setActive/saveEvents/save` | `server.js:585-648` |
| UI koneksi | `renderConns()` + modal `#conn-modal` | `js/app.js:2019-2088` |
| Prompt teks | `buildSystemPrompt()` menyuntik SELURUH `DAFTAR PARAMETER LENGKAP` + `📝 penjelasan user` | `agent.js:43-159` |
| Deskripsi param | `params[i].userNote` (v4), dikirim ke `analyze-sheet` sebagai `notes` | `js/app.js` `saveParamNote` |

**Masalah yang plan ini selesaikan:**
1. `buildSystemPrompt()` menumpuk daftar param + deskripsi user ke prompt Pass 1. Makin banyak deskripsi → LLM pembicara makin bingung & mahal.
2. Semua peran memakai SATU connection aktif. Tidak bisa "yang murah untuk motion, yang pintar untuk teks".
3. Belum ada jalur untuk tugas non-obrolan (coding, email, dll).

## 1. Keputusan desain (mengikat)

1. **`roles` adalah TAG, bukan hierarki.** Satu connection boleh punya banyak role. Tidak ada "role induk".
2. **Kompatibel mundur MUTLAK.** Connection tanpa field `roles` (atau `roles: []`) = **wildcard**, memenuhi role apa pun. Config lama user harus tetap jalan tanpa diedit.
3. **Fallback tidak pernah kosong.** Kalau tidak ada connection ber-role X, `llmForRole('X')` jatuh ke perilaku lama (`llmWithFallback` penuh). Tidak boleh ada endpoint yang mati hanya karena user belum menandai role.
4. **`llmWithFallback()` TIDAK diganti, dibungkus.** Kebijakan retry/cooldown/persist tetap satu tempat. `llmForRole()` hanya menentukan URUTAN kandidat.
5. **Deskripsi param milik LLM MOTION, bukan LLM teks.** Setelah plan ini, `paramRef` + `📝 penjelasan user` HILANG dari Pass 1 dan MUNCUL di director prompt. Ini pembalikan yang disengaja — jangan "diperbaiki" balik.
6. **Specialist tidak pernah mengeksekusi aksi berbahaya sendiri.** Role `coding`/`email` hanya menghasilkan TEKS/rencana yang dibacakan karakter atau ditampilkan. Eksekusi nyata (tulis file, kirim email) adalah pekerjaan terpisah dan butuh izin user eksplisit — DI LUAR lingkup plan ini.
7. **Model-agnostic tetap berlaku.** Plan ini hanya mengubah *LLM mana yang dipanggil*, tidak mengubah cara param di-resolve. Sheet tetap per-model.

## 2. Daftar role kanonik

Satu sumber kebenaran, dipakai server (validasi) dan UI (checkbox):

```
chat       — menghasilkan teks balasan karakter (Pass 1)
motion     — Animation Director: teks -> segment emosi/gesture (Pass 2)
sheet      — analisa preset + klasifikasi parameter (analyze-sheet, classify-params)
router     — klasifikasi intent (obrolan vs tugas). Ringan & murah.
coding     — specialist: pertanyaan/permintaan koding
email      — specialist: menyusun draf email
```

Role tak dikenal dari config **di-drop dengan warning**, tidak menggagalkan boot.

---

# FASE 1 — Inti routing (`roles` + `llmForRole`)

Fase ini sendirian sudah membuat multi-LLM bisa dipakai lewat edit `config.json` manual, tanpa UI.

### Task 1.1: Tambah tabel role kanonik + normalizer di `server.js`

**Objective:** Satu sumber kebenaran daftar role + fungsi pembersih input.

**Files:**
- Modify: `server.js` — sisipkan setelah `const KNOWN_ROLES = [...]` (blok role PARAMETER, ~baris 244-249). Namanya beda, jangan tertukar: yang lama `KNOWN_ROLES` (role parameter Cubism), yang baru `LLM_ROLES`.

**Step 1: Tulis test dulu (RED)**

Buat `test/test-fase6-llm-roles.js`:

```js
// Fase 6 — multi-LLM role routing.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  -> ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } }
function section(t) { console.log('\n' + t); }

section('1. LLM_ROLES table');
ok('LLM_ROLES declared', /const LLM_ROLES = \[/.test(srvSrc));
ok('six canonical roles present',
  ['chat','motion','sheet','router','coding','email']
    .every(r => new RegExp("'" + r + "'").test(srvSrc.slice(srvSrc.indexOf('const LLM_ROLES'), srvSrc.indexOf('const LLM_ROLES') + 300))));
ok('LLM_ROLES is distinct from the Cubism KNOWN_ROLES table',
  /const KNOWN_ROLES = \[/.test(srvSrc) && /const LLM_ROLES = \[/.test(srvSrc));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
```

**Step 2: Jalankan, pastikan GAGAL**

Run: `node test/test-fase6-llm-roles.js`
Expected: `FAIL  LLM_ROLES declared`

**Step 3: Implementasi minimal di `server.js`**

Sisipkan tepat SETELAH array `KNOWN_ROLES` ditutup:

```js
// ── LLM role routing ───────────────────────────────────────────
// Peran FUNGSIONAL sebuah connection, bukan role parameter Cubism di
// KNOWN_ROLES di atas — dua tabel berbeda, jangan tertukar.
//
// Alasan ada: satu LLM yang mengerjakan semuanya harus menerima seluruh
// daftar parameter + deskripsi user di prompt-nya, dan itu justru membuat
// balasan teksnya makin buruk (dan makin mahal). Dengan tag ini, prompt
// berat pindah ke connection yang memang tugasnya memetakan gerak.
const LLM_ROLES = ['chat', 'motion', 'sheet', 'router', 'coding', 'email'];

// Bersihkan field `roles` dari sebuah connection.
// Array kosong / field absen = WILDCARD (memenuhi semua role) supaya config
// lama milik user tetap jalan tanpa diedit sama sekali.
function normalizeRoles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const k = r.trim().toLowerCase();
    if (!k) continue;
    if (LLM_ROLES.indexOf(k) === -1) {
      console.warn('[roles] role tidak dikenal diabaikan:', k);
      continue;
    }
    if (out.indexOf(k) === -1) out.push(k);
  }
  return out;
}

// true kalau connection ini boleh dipakai untuk `role`.
function connHasRole(conn, role) {
  const roles = normalizeRoles(conn && conn.roles);
  if (!roles.length) return true;          // wildcard
  return roles.indexOf(role) !== -1;
}
```

**Step 4: Jalankan test, pastikan LULUS**

Run: `node test/test-fase6-llm-roles.js`
Expected: `3 passed, 0 failed`

**Step 5: Commit**

```bash
git add server.js test/test-fase6-llm-roles.js
git commit -m "feat(llm): add LLM_ROLES table + role normalizer"
```

---

### Task 1.2: `normalizeRoles()` — kasus tepi

**Objective:** Buktikan wildcard, dedupe, case-insensitive, dan penolakan role palsu.

**Files:** Modify: `test/test-fase6-llm-roles.js`

**Step 1: Tambah test yang mengeksekusi fungsi asli (bukan regex)**

Sisipkan sebelum baris ringkasan:

```js
section('2. normalizeRoles / connHasRole executed');

function sliceFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const rolesHarness = [
  srvSrc.slice(srvSrc.indexOf('const LLM_ROLES = ['), srvSrc.indexOf('\n', srvSrc.indexOf('const LLM_ROLES = ['))),
  sliceFn(srvSrc, 'normalizeRoles'),
  sliceFn(srvSrc, 'connHasRole'),
].join('\n');
ok('role helpers extracted', rolesHarness.length > 200, rolesHarness.length + ' chars');

const sb = { console: { warn() {}, log() {} }, Array, String };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(rolesHarness + '\nglobalThis.__nr = normalizeRoles; globalThis.__ch = connHasRole;', sb);
const nr = sb.__nr, ch = sb.__ch;

ok('absent roles -> wildcard (all roles allowed)', ch({}, 'chat') && ch({}, 'coding'));
ok('empty array -> wildcard', ch({ roles: [] }, 'motion'));
ok('explicit role matches', ch({ roles: ['motion'] }, 'motion'));
ok('explicit role excludes others', !ch({ roles: ['motion'] }, 'chat'));
ok('case-insensitive', ch({ roles: ['CHAT'] }, 'chat'));
ok('whitespace trimmed', ch({ roles: ['  chat  '] }, 'chat'));
ok('unknown role dropped', nr(['chat', 'teleport']).join(',') === 'chat');
ok('duplicates deduped', nr(['chat', 'chat', 'CHAT']).length === 1);
ok('non-string entries ignored', nr([1, null, {}, 'chat']).join(',') === 'chat');
ok('non-array roles -> wildcard', ch({ roles: 'chat' }, 'motion'),
  'a string is not a valid roles list; degrade to wildcard rather than lock out');
```

**Step 2:** Run → expect FAIL bila implementasi Task 1.1 kurang tepat.
**Step 3:** Perbaiki `server.js` sampai lulus.
**Step 4:** Run: `node test/test-fase6-llm-roles.js` → Expected: `13 passed, 0 failed`
**Step 5:** Commit: `test(llm): lock normalizeRoles/connHasRole edge cases`

---

### Task 1.3: `llmForRole()` — pembungkus `llmWithFallback`

**Objective:** Pilih kandidat berdasarkan role, pakai kebijakan retry yang sudah ada.

**Files:** Modify: `server.js` — sisipkan TEPAT SETELAH `llmWithFallback()` ditutup (~baris 457).

**Step 1: Test (RED)** — tambah ke `test/test-fase6-llm-roles.js`:

```js
section('3. llmForRole ordering + fallback');
ok('llmForRole defined', /function llmForRole\(/.test(srvSrc));
ok('llmForRole reuses llmWithFallback (single retry policy)',
  /function llmForRole[\s\S]{0,900}llmWithFallback\(/.test(srvSrc));
ok('no-match falls back to full connection list',
  /function llmForRole[\s\S]{0,900}(tidak ada connection|fallback)/i.test(srvSrc));
ok('llmForRole logs which role picked which connection',
  /\[roles\]/.test(srvSrc));
```

**Step 2:** Run → FAIL.

**Step 3: Implementasi**

```js
// Panggil LLM untuk sebuah PERAN.
//
// Bukan pengganti llmWithFallback(): kebijakan retry/cooldown/persist tetap
// di sana (satu tempat). Yang ditambahkan di sini hanya PENYARINGAN kandidat
// + preferensi urutan, lalu pekerjaan diserahkan.
//
// Aturan keras: kalau tidak ada connection yang menandai dirinya untuk role
// ini, JANGAN gagal — jatuh ke perilaku lama (semua connection). Endpoint
// tidak boleh mati hanya karena user belum menandai role apa pun.
function llmForRole(role, messages, clientSystem) {
  const conns = getConnections();
  const matching = conns.filter(c => connHasRole(c, role));
  const explicit = conns.filter(c => normalizeRoles(c.roles).indexOf(role) !== -1);

  if (!matching.length) {
    console.warn('[roles] tidak ada connection untuk role "' + role + '" — pakai semua connection');
    return llmWithFallback(messages, clientSystem);
  }
  // Connection yang MENANDAI role ini secara eksplisit diutamakan di atas
  // wildcard, supaya menandai satu connection sebagai 'motion' benar-benar
  // mengarahkan trafik motion ke sana.
  const ordered = explicit.concat(matching.filter(c => explicit.indexOf(c) === -1));
  console.log('[roles] role=' + role + ' -> ' + ordered.map(c => c.name || c.id).join(' > '));
  return llmWithFallback(messages, clientSystem, ordered);
}
```

**Step 4: Ubah `llmWithFallback()` supaya menerima urutan opsional**

Ganti bagian pembuka fungsi (`server.js:412-422`):

```js
// `order` opsional: daftar connection yang SUDAH diurutkan (dipakai
// llmForRole). Bila tidak diberikan, perilaku lama dipertahankan persis:
// active dulu, lalu sisanya urut config.
function llmWithFallback(messages, clientSystem, order) {
  return new Promise((resolve, reject) => {
    const conns = getConnections();
    if (!conns.length) {
      const e = new Error('Belum ada connection. Buka panel ⚙️ AI Connections.');
      e.httpStatus = 400; e.kind = 'no-connections';
      return reject(e);
    }
    const active = getActiveConnection();
    const order2 = (Array.isArray(order) && order.length)
      ? order.filter(Boolean)
      : [active, ...conns.filter(c => c !== active)].filter(Boolean);
```

Lalu ganti SEMUA pemakaian `order` di dalam body menjadi `order2` (ada di `idx >= order.length`, `order[idx++]`, dan `idx < order.length`).

**Step 5:** Run: `node test/test-fase6-llm-roles.js` → Expected: `17 passed, 0 failed`
Run juga: `node -c server.js` → tanpa error.
**Step 6:** Commit: `feat(llm): add llmForRole() wrapper over llmWithFallback`

---

### Task 1.4: Persist `roles` lewat `POST /api/config`

**Objective:** `roles` selamat saat add/update dan tidak dihapus oleh CRUD lain.

**Files:** Modify: `server.js` (blok `action === 'add'` dan `'update'`, ~baris 599-613)

**Step 1: Test (RED)**

```js
section('4. roles persisted through /api/config');
const cfgBlock = srvSrc.slice(srvSrc.indexOf("=== '/api/config'", srvSrc.indexOf("'POST' && req.url.split('?')[0] === '/api/config'")), srvSrc.indexOf("/api/test"));
ok('add normalises roles', /action === 'add'[\s\S]{0,400}normalizeRoles/.test(srvSrc));
ok('update normalises roles', /action === 'update'[\s\S]{0,600}normalizeRoles/.test(srvSrc));
ok('GET /api/config exposes roles to the UI',
  /connections: conns[\s\S]{0,200}/.test(srvSrc) && /roles/.test(srvSrc.slice(srvSrc.indexOf("GET' && req.url.split('?')[0] === '/api/config'"), srvSrc.indexOf("POST' && req.url.split('?')[0] === '/api/config'"))));
```

**Step 2:** Run → FAIL.

**Step 3: Implementasi** — di dalam `action === 'add'`, setelah `conn.id = id;`:

```js
          // roles wajib dinormalisasi di server: UI bisa dilewati (curl,
          // config.json diedit tangan), dan role palsu tidak boleh tersimpan.
          conn.roles = normalizeRoles(conn.roles);
```

Di dalam `action === 'update'`, setelah baris `if (!upd.apiKey || ...) upd.apiKey = conns[i].apiKey;`:

```js
          // Bedakan "tidak mengirim roles" (pertahankan yang lama) dari
          // "mengirim array kosong" (user sengaja mengosongkan = wildcard).
          if (Object.prototype.hasOwnProperty.call(upd, 'roles')) {
            upd.roles = normalizeRoles(upd.roles);
          }
```

Di handler `GET /api/config` (~baris 574-580), pastikan `roles` ikut dikirim. Ubah pemetaan connection menjadi:

```js
    const conns = (cfg.connections || []).map(c => {
      const o = Object.assign({}, c, { apiKey: maskKey(c.apiKey) });
      o.roles = normalizeRoles(c.roles);   // selalu array, UI tidak perlu cek undefined
      return o;
    });
```

**Step 4:** Run: `node test/test-fase6-llm-roles.js` → Expected: `20 passed, 0 failed`
**Step 5:** Commit: `feat(config): persist + expose connection roles`

---

# FASE 2 — Pasang role ke endpoint + PINDAHKAN beban prompt

Inti keluhan user diselesaikan di sini: deskripsi parameter berhenti mencemari prompt teks.

### Task 2.1: `/api/chat` pakai role `chat`

**Files:** Modify: `server.js:481`

**Step 1: Test (RED)** — tambah ke `test/test-fase6-llm-roles.js`:

```js
section('5. endpoints wired to roles');
const chatBlock = srvSrc.slice(srvSrc.indexOf("=== '/api/chat'"), srvSrc.indexOf("=== '/api/tts'"));
ok("/api/chat uses role 'chat'", /llmForRole\('chat'/.test(chatBlock));
```

**Step 2:** Run → FAIL.
**Step 3:** Ganti `llmWithFallback(messages, clientSystem)` menjadi:

```js
      llmForRole('chat', messages, clientSystem).then(({ reply, used }) => {
```

**Step 4:** Run test → PASS. Run `node -c server.js`.
**Step 5:** Commit: `feat(llm): route /api/chat through the 'chat' role`

---

### Task 2.2: `/api/animate-text` pakai role `motion`

**Files:** Modify: `server.js:983`

**Step 1: Test (RED)**

```js
const animBlock = srvSrc.slice(srvSrc.indexOf("=== '/api/animate-text'"), srvSrc.indexOf('Model management'));
ok("/api/animate-text uses role 'motion'", /llmForRole\('motion'/.test(animBlock));
```

**Step 2:** Run → FAIL.
**Step 3:** Ganti `llmWithFallback([{ role: 'user', content: directorPrompt }])` menjadi:

```js
      llmForRole('motion', [{ role: 'user', content: directorPrompt }]).then(({ reply }) => {
```

**Step 4:** Run test → PASS.
**Step 5:** Commit: `feat(llm): route the animation director through the 'motion' role`

---

### Task 2.3: `analyze-sheet` + `classify-params` pakai role `sheet`

**Files:** Modify: `server.js:871` dan `server.js:724`

**Step 1: Test (RED)**

```js
const sheetBlock = srvSrc.slice(srvSrc.indexOf("=== '/api/model/analyze-sheet'"), srvSrc.indexOf("=== '/api/animate-text'"));
const clsBlock = srvSrc.slice(srvSrc.indexOf("=== '/api/model/classify-params'"), srvSrc.indexOf("=== '/api/model/analyze-sheet'"));
ok("analyze-sheet uses role 'sheet'", /llmForRole\('sheet'/.test(sheetBlock));
ok("classify-params uses role 'sheet'", /llmForRole\('sheet'/.test(clsBlock));
```

**Step 2:** Run → FAIL.
**Step 3:** Di kedua blok, ganti `llmWithFallback([{ role: 'user', content: prompt }])` → `llmForRole('sheet', [{ role: 'user', content: prompt }])`.
**Step 4:** Run test → PASS.
**Step 5:** Commit: `feat(llm): route sheet analysis through the 'sheet' role`

---

### Task 2.4: ⚠️ CABUT daftar parameter dari prompt teks (`agent.js`)

**Objective:** Ini task terpenting di seluruh plan. Prompt Pass 1 berhenti membawa ~90 baris parameter + deskripsi user.

**Files:** Modify: `agent.js:47-72` (blok pembangun `paramRef`) dan `agent.js:109-110` (tempat `paramRef` disisipkan ke `capBlock`).

**Alasan (jangan dibalik):** Sebelum ini, setiap pesan obrolan membawa seluruh tabel parameter. Dengan deskripsi per-param terisi, blok itu tumbuh tanpa batas dan justru menurunkan mutu balasan — LLM pembicara tidak butuh tahu `ParamAngleX` punya range -30..30; ia hanya perlu tahu nama emosi & gesture yang tersedia. Yang butuh angka adalah Animation Director (Task 2.5).

**Step 1: Test (RED)** — buat `test/test-fase6-prompt-split.js`:

```js
// Fase 6 — pemisahan prompt: teks vs motion.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const agentSrc = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  -> ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } }
function section(t) { console.log('\n' + t); }
function sliceFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

section('1. Pass 1 prompt is LEAN (no param dump, no per-param notes)');
const bsp = sliceFn(agentSrc, 'buildSystemPrompt');
ok('buildSystemPrompt extracted', !!bsp);

const sb = { console: { log() {}, warn() {} } };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(bsp + '\nglobalThis.__bsp = buildSystemPrompt;', sb);
sb.capProfile = {
  sheet: {
    params: [
      { id: 'ParamAngleX', label: 'ParamAngleX', min: -30, max: 30, def: 0, group: 'Sudut (Angle)', userNote: 'geser kepala kiri kanan' },
      { id: 'ParamRahang', label: 'ParamRahang', min: 0, max: 1, def: 0, group: 'Kustom', userNote: 'buka rahang bawah' },
    ],
  },
  userNote: 'dia pemalu',
  emotions: ['senang', 'sedih'],
  nativeExpressions: ['exp_a'],
  properties: [], accessories: [], gestures: ['nod'],
};
const p1 = sb.__bsp('');

ok('param ranges NOT in the chat prompt', !/-30\.\.30/.test(p1),
  'ranges belong to the motion pass, not the speaker');
ok('per-param userNote NOT in the chat prompt', !/buka rahang bawah/.test(p1),
  'THIS is the fix: descriptions no longer pollute the text LLM');
ok('DAFTAR PARAMETER block removed', !/DAFTAR PARAMETER LENGKAP/.test(p1));
ok('character note (top-level userNote) IS still present', /dia pemalu/.test(p1),
  'character identity is the speaker\'s job — keep it');
ok('emotion vocabulary still present', /senang/.test(p1));
ok('gesture vocabulary still present', /nod/.test(p1));
ok('prompt is materially shorter than 4000 chars', p1.length < 4000, p1.length + ' chars');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
```

**Step 2:** Run: `node test/test-fase6-prompt-split.js` → Expected FAIL pada 3 assertion pertama.

**Step 3: Implementasi — hapus blok `paramRef`**

Di `agent.js`, HAPUS seluruh blok pembangun `paramRef` (dari `let paramRef = '';` sampai penutup `}` sebelum komentar `// User-authored character note`), ganti dengan:

```js
    // CATATAN ARSITEKTUR — daftar parameter SENGAJA TIDAK dikirim ke pass ini.
    //
    // Dulu di sini seluruh tabel parameter (id, min..max, default) plus setiap
    // 📝 penjelasan user disuntikkan ke prompt pembicara. Begitu user mulai
    // benar-benar mengisi deskripsi per-parameter, blok itu tumbuh tanpa batas
    // dan justru MENURUNKAN mutu balasan teks — pembicara tidak perlu tahu
    // ParamAngleX ber-range -30..30 untuk memilih kata.
    //
    // Sekarang angka + deskripsi itu milik role 'motion' (Animation Director di
    // POST /api/animate-text), yang tugasnya memang memetakan teks -> gerak.
    // Pass ini hanya menerima KOSAKATA: nama emosi, gesture, properti, aksesoris.
    // Jangan kembalikan blok parameter ke sini. Dikunci test/test-fase6-prompt-split.js.
```

**Step 4:** Di `capBlock`, ganti bagian:

```
=== DAFTAR PARAMETER (dengan range aktual dari model) ===
${paramRef || 'Tidak ada data parameter.'}
```

menjadi:

```
=== GERAK ===
Untuk gerakan, PILIH dari daftar gesture di bawah. Angka parameter mentah
diurus sistem — kamu tidak perlu (dan tidak boleh) mengarang angka.
```

Hapus juga poin `3. KEPALA / 4. MATA / 5. MULUT / 6. BADAN` dari `=== FORMAT DIRECTIVE ===` bila prompt jadi ambigu tanpa range — atau pertahankan tapi tanpa menyebut range. Keputusan: **pertahankan** directive-nya (masih valid bila LLM memakainya), hanya jangan sertakan tabel range.

**Step 5:** Run: `node test/test-fase6-prompt-split.js` → Expected: `8 passed, 0 failed`
**Step 6:** Commit: `refactor(agent): remove param dump + per-param notes from the chat prompt`

---

### Task 2.5: Kirim deskripsi param KE Animation Director

**Objective:** Deskripsi user tetap dipakai — hanya pindah pemilik, bukan hilang.

**Files:**
- Modify: `agent.js` `animateTextViaDirector()` (~baris 456-486) — sertakan `paramNotes` di body.
- Modify: `server.js` `/api/animate-text` — terima + sanitasi + suntik ke `directorPrompt`.

**Step 1: Test (RED)** — tambah ke `test/test-fase6-prompt-split.js`:

```js
section('2. Motion pass RECEIVES the descriptions');
ok('agent sends paramNotes to the director',
  /paramNotes/.test(agentSrc), 'the notes must not simply vanish');
const animBlock = srvSrc.slice(srvSrc.indexOf("=== '/api/animate-text'"), srvSrc.indexOf('Model management'));
ok('director endpoint accepts paramNotes', /incoming\.paramNotes/.test(animBlock));
ok('director endpoint sanitises paramNotes (control chars + cap)',
  /\\u0000-\\u0008/.test(animBlock) || /replace\(\/\[\\u0000/.test(animBlock));
ok('director prompt mentions the user explanation section',
  /PENJELASAN PARAMETER DARI USER/.test(animBlock));
ok('director prompt caps how many notes it embeds',
  /slice\(0, ?(20|30|40|50)\)/.test(animBlock),
  'an unbounded list would re-create the very problem we just fixed');
```

**Step 2:** Run → FAIL.

**Step 3: Implementasi klien** — di `agent.js` `animateTextViaDirector()`, tambahkan pembangun `paramNotes` sebelum `fetch`:

```js
      // Deskripsi per-parameter milik user, DIBATASI jumlahnya.
      // Ini konteks otoritatif untuk director: kalau user menulis "ParamX =
      // buka rahang", director tidak boleh menebak lain. Batas 24 entri +
      // 200 char/entri disengaja — memindahkan blok tak terbatas dari prompt
      // teks ke prompt motion hanya memindahkan masalahnya.
      const sheetParams = (profile && profile.sheet && profile.sheet.params) || [];
      const paramNotes = {};
      let noteCount = 0;
      for (const p of sheetParams) {
        if (noteCount >= 24) break;
        if (p && p.id && typeof p.userNote === 'string' && p.userNote.trim()) {
          paramNotes[p.id] = p.userNote.trim().slice(0, 200);
          noteCount++;
        }
      }
```

Lalu sertakan di body: `body: JSON.stringify({ text, capabilities: {...}, paramNotes }),`

**Step 4: Implementasi server** — di `/api/animate-text`, setelah `const gestures = ...`:

```js
      // Penjelasan parameter tulisan USER. Otoritatif: director harus
      // menghormati makna ini, bukan menebak dari nama id.
      const rawNotes = (incoming.paramNotes && typeof incoming.paramNotes === 'object' && !Array.isArray(incoming.paramNotes))
        ? incoming.paramNotes : {};
      const noteLines = Object.keys(rawNotes).slice(0, 24).reduce((acc, id) => {
        const v = rawNotes[id];
        if (typeof id !== 'string' || !id || typeof v !== 'string') return acc;
        const clean = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 200);
        if (clean) acc.push('- "' + id.slice(0, 60) + '": ' + clean);
        return acc;
      }, []).join('\n');
```

Lalu di `directorPrompt`, sisipkan setelah daftar gesture:

```js
${noteLines ? `\nPENJELASAN PARAMETER DARI USER (otoritatif — hormati makna ini):\n${noteLines}\n` : ''}
```

**Step 5:** Run: `node test/test-fase6-prompt-split.js` → Expected: `13 passed, 0 failed`
**Step 6:** Commit: `feat(motion): move per-param descriptions into the animation director`

---

# FASE 3 — UI: centang peran per connection

### Task 3.1: Checkbox role di modal connection

**Files:**
- Modify: `index.html` — di `#conn-modal` `.api-form`, setelah field `System Prompt` (~baris 356-358).
- Modify: `css/app.css` — gaya `.conn-roles`.

**Step 1: Markup** — tambahkan sebelum penutup `.api-form`:

```html
        <label>Peran (roles)
          <span class="form-hint">Kosongkan semua = connection ini boleh dipakai untuk semua peran.</span>
        </label>
        <div class="conn-roles" id="m-roles">
          <label><input type="checkbox" value="chat" /> 💬 chat (teks balasan)</label>
          <label><input type="checkbox" value="motion" /> 🎭 motion (gerak/ekspresi)</label>
          <label><input type="checkbox" value="sheet" /> 📋 sheet (analisa parameter)</label>
          <label><input type="checkbox" value="router" /> 🔀 router (deteksi maksud)</label>
          <label><input type="checkbox" value="coding" /> 💻 coding</label>
          <label><input type="checkbox" value="email" /> ✉️ email</label>
        </div>
```

**Step 2: CSS** — tambahkan di akhir `css/app.css`:

```css
/* ===== Peran connection (multi-LLM routing) ===== */
.conn-roles { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 8px; }
.conn-roles label {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-dim); cursor: pointer;
}
.conn-roles label:hover { color: var(--text); }
.conn-roles input { accent-color: var(--accent); }
.form-hint { display: block; font-size: 10px; color: var(--text-dim); font-weight: 400; }
.conn-role-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.conn-role-tag {
  font-size: 9px; padding: 1px 6px; border-radius: 999px;
  background: rgba(124,111,255,0.18); border: 1px solid var(--accent);
  color: var(--text); white-space: nowrap;
}
.conn-role-tag.wild { background: rgba(255,255,255,0.06); border-color: var(--border); color: var(--text-dim); }
```

**Step 3:** Commit: `feat(ui): add role checkboxes to the connection modal`

---

### Task 3.2: Isi + baca checkbox di `openModal` / `m-save`

**Files:** Modify: `js/app.js:2051-2088`

**Step 1: Test (RED)** — buat `test/test-fase6-roles-ui.js`:

```js
// Fase 6 — UI peran connection.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  -> ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } }
function section(t) { console.log('\n' + t); }

section('1. Markup + styles');
ok('role checkbox container exists', /id="m-roles"/.test(htmlSrc));
['chat','motion','sheet','router','coding','email'].forEach(r =>
  ok('checkbox for role ' + r, new RegExp('value="' + r + '"').test(htmlSrc)));
ok('conn-roles styled', /\.conn-roles/.test(cssSrc));
ok('role tag styled', /\.conn-role-tag/.test(cssSrc));

section('2. openModal fills, m-save reads');
ok('openModal ticks stored roles', /#m-roles[\s\S]{0,400}checked/.test(appSrc));
ok('m-save collects checked roles into an array',
  /roles:\s*(rolesFromForm|Array\.from)/.test(appSrc));
ok('connection card renders role tags', /conn-role-tag/.test(appSrc));
ok('wildcard shown as "semua" when roles empty', /semua/.test(appSrc));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
```

**Step 2:** Run → FAIL.

**Step 3: Implementasi** — tambahkan helper di dekat `openModal`:

```js
    // Peran connection: baca/tulis checkbox #m-roles.
    // Semua tercentang KOSONG = wildcard (server memperlakukannya sebagai
    // "boleh untuk semua peran"), jadi user tidak wajib paham konsep role.
    function rolesFromForm() {
      const box = $('#m-roles');
      if (!box) return [];
      return Array.from(box.querySelectorAll('input[type="checkbox"]'))
        .filter(cb => cb.checked).map(cb => cb.value);
    }
    function rolesToForm(roles) {
      const box = $('#m-roles');
      if (!box) return;
      const want = new Set(Array.isArray(roles) ? roles : []);
      for (const cb of box.querySelectorAll('input[type="checkbox"]')) {
        cb.checked = want.has(cb.value);
      }
    }
```

Di `openModal(c)`, tambahkan sebelum `modal.classList.remove('hidden')`:

```js
      rolesToForm(c ? c.roles : []);
```

Di handler `#m-save`, tambahkan ke objek `conn`:

```js
        roles: rolesFromForm(),
```

**Step 4: Tampilkan tag peran di kartu connection** — di `renderConns()`, setelah baris `conn-meta`, sisipkan ke template:

```js
        const roles = Array.isArray(c.roles) ? c.roles : [];
        const roleTags = roles.length
          ? roles.map(r => `<span class="conn-role-tag">${esc(r)}</span>`).join('')
          : '<span class="conn-role-tag wild">semua peran</span>';
```

lalu tambahkan `<div class="conn-role-tags">${roleTags}</div>` di dalam `card.innerHTML` setelah `conn-meta`.

**Step 5:** Run: `node test/test-fase6-roles-ui.js` → Expected: `13 passed, 0 failed`
**Step 6:** Commit: `feat(ui): show + edit connection roles`

---

# FASE 4 — Specialist + intent router (opsional, setelah 1–3 jalan)

> Urutan ini WAJIB: router tidak boleh mendahului Fase 2. Kalau prompt teks masih tercemar, menambah router hanya menambah panggilan LLM tanpa memperbaiki penyebabnya.

### Task 4.1: Endpoint `POST /api/route-intent`

**Objective:** Satu panggilan murah yang mengklasifikasikan pesan user.

**Files:** Modify: `server.js` — tambahkan handler baru SETELAH blok `/api/animate-text` (sebelum `// ── Model management`).

**Step 1: Test (RED)** — buat `test/test-fase6-intent-router.js` (struktur sama seperti suite lain):

```js
section('1. /api/route-intent contract');
ok('endpoint registered', /req\.url\.split\('\?'\)\[0\] === '\/api\/route-intent'/.test(srvSrc));
const rBlock = srvSrc.slice(srvSrc.indexOf("=== '/api/route-intent'"), srvSrc.indexOf('Model management'));
ok('body size capped', /body\.length > 1e6/.test(rBlock));
ok('malformed JSON -> 400', /body JSON rusak/.test(rBlock));
ok("uses role 'router'", /llmForRole\('router'/.test(rBlock));
ok('intent whitelist enforced', /INTENTS/.test(rBlock));
ok('unknown intent degrades to chat', /'chat'/.test(rBlock));
ok('LLM failure degrades to 200 + intent chat (never blocks the reply)',
  /res\.writeHead\(200\)[\s\S]{0,200}intent: 'chat'/.test(rBlock));
```

**Step 2:** Run → FAIL.

**Step 3: Implementasi**

```js
  // ── POST /api/route-intent → klasifikasi maksud pesan user ──
  //
  // Tujuannya BUKAN menjadi pintar, tapi menjadi MURAH: satu label dari daftar
  // tertutup, supaya pesan "tolong bikin fungsi Python" tidak dijawab oleh
  // persona karakter yang tidak dituning untuk koding.
  //
  // Aturan degradasi: apa pun yang salah (LLM mati, JSON aneh, label ngawur)
  // menghasilkan 200 + intent 'chat'. Router yang gagal TIDAK BOLEH memblokir
  // balasan — karakter harus tetap menjawab seperti sebelum fitur ini ada.
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/route-intent') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let incoming;
      try { incoming = JSON.parse(body); } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'body JSON rusak' })); return;
      }
      const text = String(incoming.text == null ? '' : incoming.text).slice(0, 4000).trim();
      // Daftar TERTUTUP. 'chat' selalu ada dan selalu jadi jawaban default.
      const INTENTS = ['chat', 'coding', 'email'];
      if (!text) { res.writeHead(200); res.end(JSON.stringify({ intent: 'chat' })); return; }

      const prompt = `Klasifikasikan maksud pesan user berikut ke SATU label.

Pesan: """${text}"""

Label yang tersedia:
- chat   : obrolan biasa, pertanyaan umum, curhat, sapaan
- coding : minta menulis/memperbaiki/menjelaskan KODE program
- email  : minta menyusun draf email / pesan formal

Jawab HANYA satu kata dari daftar di atas, tanpa tanda baca, tanpa penjelasan.`;

      llmForRole('router', [{ role: 'user', content: prompt }]).then(({ reply }) => {
        const guess = String(reply || '').toLowerCase().replace(/[^a-z]/g, '');
        const intent = INTENTS.indexOf(guess) !== -1 ? guess : 'chat';
        if (intent !== guess) console.warn('[router] label tidak dikenal "' + guess + '" -> chat');
        res.writeHead(200); res.end(JSON.stringify({ intent }));
      }).catch(err => {
        console.warn('[router] gagal, jatuh ke chat:', err.message);
        res.writeHead(200); res.end(JSON.stringify({ intent: 'chat', warning: err.message }));
      });
    });
    return;
  }
```

**Step 4:** Run test → PASS. Run `node -c server.js`.
**Step 5:** Commit: `feat(router): add /api/route-intent with closed intent list`

---

### Task 4.2: Endpoint `POST /api/specialist`

**Objective:** Jalankan tugas specialist dan kembalikan TEKS. Tidak ada efek samping.

**Files:** Modify: `server.js` — setelah `/api/route-intent`.

**Step 1: Test (RED)**

```js
section('2. /api/specialist contract');
const sBlock = srvSrc.slice(srvSrc.indexOf("=== '/api/specialist'"), srvSrc.indexOf('Model management'));
ok('endpoint registered', /=== '\/api\/specialist'/.test(srvSrc));
ok('role validated against LLM_ROLES', /LLM_ROLES\.indexOf/.test(sBlock));
ok('chat/motion/sheet/router rejected as specialist roles',
  /SPECIALIST_ROLES/.test(sBlock),
  'a specialist call must not be able to hijack the speaker role');
ok('returns text only — no file writes, no network side effects',
  !/writeFileSync|fs\./.test(sBlock),
  'HARD RULE: specialists produce text; execution needs explicit user consent');
ok('uses llmForRole with the requested role', /llmForRole\(role/.test(sBlock));
```

**Step 2:** Run → FAIL.

**Step 3: Implementasi**

```js
  // ── POST /api/specialist → jalankan tugas specialist (coding/email/…) ──
  //
  // ATURAN KERAS: endpoint ini HANYA menghasilkan TEKS. Tidak menulis file,
  // tidak mengirim email, tidak menyentuh disk. Eksekusi nyata adalah fitur
  // terpisah yang butuh izin user eksplisit — jangan tambahkan di sini.
  //
  // Role yang boleh diminta dibatasi ke SPECIALIST_ROLES supaya pemanggil
  // tidak bisa memakai endpoint ini untuk membajak persona ('chat') atau
  // memalsukan output director ('motion').
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/specialist') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let incoming;
      try { incoming = JSON.parse(body); } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'body JSON rusak' })); return;
      }
      const SPECIALIST_ROLES = ['coding', 'email'];
      const role = String(incoming.role || '').toLowerCase();
      const text = String(incoming.text == null ? '' : incoming.text).slice(0, 8000).trim();
      if (LLM_ROLES.indexOf(role) === -1 || SPECIALIST_ROLES.indexOf(role) === -1) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'role specialist tidak valid: ' + role }));
        return;
      }
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'text kosong' })); return; }

      const SYSTEMS = {
        coding: 'Kamu asisten pemrograman. Jawab ringkas dan tepat. Sertakan kode dalam blok ' +
          'markdown bila relevan. Jangan berpura-pura menjalankan apa pun; kamu hanya menulis.',
        email: 'Kamu penyusun draf email. Hasilkan draf siap kirim: subjek + isi. ' +
          'Sopan, jelas, tanpa basa-basi berlebihan. Kamu TIDAK mengirim apa pun.',
      };

      llmForRole(role, [{ role: 'user', content: text }], SYSTEMS[role]).then(({ reply, used }) => {
        res.writeHead(200); res.end(JSON.stringify({ role, result: reply, used }));
      }).catch(err => {
        res.writeHead(err.httpStatus || 502);
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    return;
  }
```

**Step 4:** Run test → PASS.
**Step 5:** Commit: `feat(specialist): add text-only /api/specialist endpoint`

---

### Task 4.3: Sambungkan router ke `agent.think()`

**Objective:** Pesan bernuansa tugas diselesaikan specialist, lalu **karakter membacakan ringkasannya**.

**Files:** Modify: `agent.js` `think()` (~baris 488-547)

**Desain yang dipilih (dan alasannya):** karakter tetap yang "bicara". Hasil specialist tidak langsung diteriakkan mentah lewat TTS (blok kode dibaca TTS = mimpi buruk). Alih-alih:
1. Router menentukan intent.
2. Bila bukan `chat` → panggil `/api/specialist`, tampilkan hasil MENTAH ke chat log (`__addChat`), lalu minta LLM `chat` membuat **satu kalimat pengantar** yang diucapkan.

**Step 1: Test (RED)** — tambah ke `test/test-fase6-intent-router.js`:

```js
section('3. agent.think wiring');
ok('think() consults the intent router', /\/api\/route-intent/.test(agentSrc));
ok('non-chat intent calls the specialist endpoint', /\/api\/specialist/.test(agentSrc));
ok('router failure never blocks the reply (try/catch around it)',
  /route-intent[\s\S]{0,600}catch/.test(agentSrc));
ok('specialist result is written to the chat log, not fed raw to TTS',
  /__addChat[\s\S]{0,300}result|result[\s\S]{0,300}__addChat/.test(agentSrc));
ok('speaks only a short intro sentence for specialist results',
  /pengantar|intro/i.test(agentSrc));
```

**Step 2:** Run → FAIL.

**Step 3: Implementasi** — di `think()`, setelah `setThinking(true); try {` dan SEBELUM fetch `/api/chat`:

```js
      // ── Router maksud (Fase 4) ──
      // Kegagalan apa pun di sini WAJIB jatuh ke 'chat'. Router adalah
      // optimasi, bukan gerbang: kalau ia mati, karakter harus tetap menjawab.
      let intent = 'chat';
      try {
        const rr = await fetch(API + '/api/route-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: userText }),
        });
        if (rr.ok) {
          const rj = await rr.json();
          if (rj && typeof rj.intent === 'string') intent = rj.intent;
        }
      } catch (e) {
        console.warn('[agent] router tidak tersedia, lanjut sebagai chat:', e.message);
      }

      if (intent !== 'chat') {
        console.log('[agent] intent =', intent, '-> specialist');
        const sr = await fetch(API + '/api/specialist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: intent, text: userText }),
        });
        const sj = await sr.json().catch(() => ({}));
        if (sr.ok && sj.result) {
          // Hasil specialist ditulis APA ADANYA ke chat log — blok kode harus
          // bisa dibaca & dicopy user. Yang DIUCAPKAN hanya satu kalimat
          // pengantar, karena TTS membaca kode adalah siksaan.
          if (window.__addChat) window.__addChat('agent', sj.result);
          const intro = intent === 'coding'
            ? 'Ini kodenya, aku tulis di chat ya~'
            : 'Draf emailnya sudah aku siapkan di chat~';
          speakSegments([{ text: intro, actions: { emotion: 'senang', gesture: 'nod' } }]);
          history.push({ role: 'assistant', content: sj.result });
          return;                      // finally{} tetap membereskan busy/thinking
        }
        console.warn('[agent] specialist gagal, jatuh ke chat:', sj.error || sr.status);
      }
```

**Step 4:** Run: `node test/test-fase6-intent-router.js` → Expected semua PASS.
**Step 5:** Verifikasi manual: `node server.js`, kirim "bikin fungsi python buat fibonacci" → log harus memperlihatkan `[agent] intent = coding -> specialist`.
**Step 6:** Commit: `feat(agent): route task-like messages to specialists`

---

# Berkas yang tersentuh (ringkasan)

| Berkas | Perubahan | Fase |
|---|---|---|
| `server.js` | +`LLM_ROLES`, `normalizeRoles`, `connHasRole`, `llmForRole`; `llmWithFallback(…, order)`; 4 endpoint di-rewire; +`/api/route-intent`, +`/api/specialist`; `roles` di CRUD + GET config; `paramNotes` di director | 1,2,4 |
| `agent.js` | −blok `paramRef` dari prompt teks; +`paramNotes` ke director; +router/specialist di `think()` | 2,4 |
| `index.html` | +checkbox `#m-roles` di modal connection | 3 |
| `css/app.css` | +`.conn-roles`, `.conn-role-tag`, `.form-hint` | 3 |
| `js/app.js` | +`rolesFromForm`/`rolesToForm`; tag peran di `renderConns()` | 3 |
| `test/test-fase6-llm-roles.js` | BARU — 20+ test routing | 1,2 |
| `test/test-fase6-prompt-split.js` | BARU — 13 test pemisahan prompt | 2 |
| `test/test-fase6-roles-ui.js` | BARU — 13 test UI | 3 |
| `test/test-fase6-intent-router.js` | BARU — 17 test router/specialist | 4 |
| `config.example.json` | +contoh `roles` per connection | 1 |
| `README.md`, `docs/HANDOFF-SHEET-SYSTEM.md` | dokumentasi arsitektur baru | 5 |

**Tidak boleh disentuh:** `js/pixi*.js`, `js/live2dcubismcore.min.js`, `model/`, `sheets/*.json` (data user), `config.json` (data user — hanya baca; contoh ada di `config.example.json`).

## Validasi menyeluruh

```bash
cd /f/backup/live2d-agent
node -c server.js && node -c js/app.js && node -c agent.js   # syntax
npm test                                                      # semua suite
```

**Baseline sekarang: 1023 passed, 0 failed / 20 suite (1 skip).**
**Target setelah plan ini: ≥ 1086 passed, 0 failed / 24 suite.** Angka tidak boleh turun.

Verifikasi manual (butuh browser, tidak bisa headless):
1. `node server.js`, buka URL.
2. Tab ⚙️ AI → Edit sebuah connection → centang hanya `motion` → Simpan. Kartu harus menampilkan tag `motion`.
3. Kirim satu pesan. Console server harus mencetak dua baris berbeda:
   `[roles] role=chat -> …` lalu `[roles] role=motion -> …`
4. Isi deskripsi param di popup 📝, kirim pesan lagi. Deskripsi harus muncul di prompt director (log `[roles] role=motion`), dan **tidak** ada `DAFTAR PARAMETER LENGKAP` di prompt chat.

## Risiko & mitigasi

| Risiko | Dampak | Mitigasi (sudah di plan) |
|---|---|---|
| User menandai `motion` saja di SATU-SATUNYA connection → role `chat` tak punya kandidat eksplisit | Chat mati | `connHasRole` wildcard + `llmForRole` fallback ke semua connection. Task 1.3 mengunci ini. |
| Prompt teks jadi terlalu kurus → LLM lupa cara memakai directive | Karakter berhenti bergerak | Kosakata emosi/gesture/properti/aksesoris DIPERTAHANKAN; hanya tabel angka yang dicabut. Test Task 2.4 mengunci keduanya. |
| Deskripsi param membanjiri prompt director (masalah lama pindah tempat) | Motion memburuk | Batas keras 24 entri × 200 char di klien DAN server (Task 2.5). |
| Router menambah latensi tiap pesan | Balasan terasa lambat | Router opsional (Fase 4, terpisah). Bila tak ada connection ber-role `router`, pertimbangkan mem-bypass panggilannya — lihat pertanyaan terbuka #2. |
| Specialist dianggap bisa mengeksekusi | Kerusakan nyata (file/email terkirim) | Aturan keras: `/api/specialist` teks-only, tanpa `fs`. Dikunci test Task 4.2. |
| `llmWithFallback` diubah → memecahkan endpoint lama | Semua LLM mati | Parameter `order` OPSIONAL; tanpa argumen perilakunya identik. Suite lama (1023 test) adalah jaring pengamannya. |

## Pertanyaan terbuka (butuh keputusan user)

1. **Fase 4 sekarang atau nanti?** Fase 1–3 sudah menjawab keluhan utama ("LLM bingung"). Fase 4 menambah kemampuan baru (coding/email) + satu panggilan LLM per pesan.
2. **Router dipanggil selalu, atau hanya bila ada connection ber-role `router`?** Rekomendasi: **hanya bila ada** — supaya user yang tidak butuh specialist tidak menanggung latensi. Ini beda satu `if` di Task 4.3.
3. **Intent tambahan?** Sekarang `coding` + `email`. Menambah (mis. `search`, `translate`) = tambah entri di `LLM_ROLES`, `INTENTS`, `SPECIALIST_ROLES`, `SYSTEMS`, dan satu checkbox.
4. **Perlu `temperature`/`maxTokens` per role?** Connection sudah punya field itu, jadi cukup buat connection terpisah. Belum perlu skema baru (YAGNI).

## Definisi selesai

- [ ] `config.json` bisa punya 3 connection dengan role berbeda, dan console membuktikan trafik terbagi (`[roles] role=…`).
- [ ] Prompt chat TIDAK lagi memuat `DAFTAR PARAMETER LENGKAP` maupun `📝 penjelasan user` (dikunci test).
- [ ] Director prompt MEMUAT `PENJELASAN PARAMETER DARI USER` bila ada deskripsi (dikunci test).
- [ ] Menghapus semua centang role tetap membuat aplikasi jalan seperti sebelum plan ini (kompatibel mundur).
- [ ] `npm test` ≥ 1086 passed, 0 failed.
- [ ] Fase 4 (bila dikerjakan): pesan koding memicu `[agent] intent = coding -> specialist`, dan hasilnya muncul di chat log sementara TTS hanya mengucapkan kalimat pengantar.




