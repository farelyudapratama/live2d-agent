// Fase 2 — reactive agent (presence / idle / mood / emosi model-agnostic).
//
// Dua jenis tes:
//   • BEHAVIORAL — agent.js dieksekusi di atas window tiruan, lalu alur event
//     benar-benar dijalankan (quietMs dipercepat, presence dipalsukan). Ini yang
//     membuktikan alurnya benar, bukan cuma ada.
//   • STRUKTURAL — membaca sumber untuk mengunci invariant yang tidak bisa
//     dijalankan tanpa browser (checkbox ada di HTML, tidak ada nama emosi
//     literal, dsb). Tanpa ini refactor berikutnya bisa mencabut perbaikan
//     tanpa satu pun tes memerah.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
const camSrc = fs.readFileSync(path.join(ROOT, 'js', 'camera-presence.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cfgSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const cfgExample = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// Buang komentar sebelum memindai "apakah ada nama emosi literal di KODE".
// Tanpa ini, komentar yang MENJELASKAN bug lama ('setExpression(\'sedih\')')
// ikut cocok dan tesnya memerah karena dokumentasinya sendiri.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const agentCode = stripComments(agentSrc);
const appCode = stripComments(appSrc);
const camCode = stripComments(camSrc);

// ─────────────────────────────────────────────────────────────────
// Harness: jalankan agent.js di atas window tiruan.
// ─────────────────────────────────────────────────────────────────
function loadAgent(opts) {
  opts = opts || {};
  const calls = { events: [], fetches: [], expressed: [], presenceCb: [] };

  const win = {
    __appEvents: opts.events || { quietMs: 0, idleSpeak: true, awaySpeak: true, returnSpeak: true },
    __live2dAgent: opts.l2d || null,
    __l2dPresenceChanged: (p) => calls.presenceCb.push(p),
  };

  // reactEvent() memanggil /api/chat lewat fetch. Tolak dengan tenang: yang
  // diuji di sini adalah KEPUTUSAN memanggil atau tidak, bukan isi balasan LLM.
  const fetchStub = (url, init) => {
    calls.fetches.push({ url: String(url), body: init && init.body ? String(init.body) : '' });
    return Promise.reject(new Error('offline (stub)'));
  };

  const sandbox = {
    window: win,
    document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [] },
    fetch: fetchStub,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Object, Promise, isFinite, Number,
  };
  sandbox.globalThis = sandbox;

  const vm = require('vm');
  vm.createContext(sandbox);
  try {
    vm.runInContext(agentSrc, sandbox, { filename: 'agent.js' });
  } catch (e) {
    return { error: e, calls, win };
  }
  return { agent: win.__agent, calls, win };
}

// Model tiruan: kosakata emosi bisa diatur per-tes, jadi kita bisa membuktikan
// tidak ada nama emosi yang di-hardcode.
function fakeL2d(expressible) {
  const log = [];
  return {
    _log: log,
    isReady: () => true,
    _getSupportedEmotions: () => expressible || {},
    getExpressibleEmotions: () => expressible || {},
    expressEmotion: (name) => { log.push(name); return (expressible || {})[name] || null; },
    setExpression: (name) => { log.push('legacy:' + name); },
  };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────
section('1. Checkbox kamera benar-benar ada di markup (bug utama Fase 2)');

const camId = (appSrc.match(/getElementById\(\s*['"]([a-zA-Z-]*camera[a-zA-Z-]*)['"]\s*\)/i) || [])[1]
  || (appSrc.match(/getElementById\(\s*['"](use-camera|useCamera)['"]\s*\)/) || [])[1];
ok('app.js mencari sebuah id checkbox kamera', !!camId, camId || 'tidak ditemukan');
ok('id yang dicari app.js ADA di index.html', !!camId && htmlSrc.indexOf('id="' + camId + '"') !== -1,
  camId ? 'id="' + camId + '"' : '-');
ok('markup kamera adalah <input type="checkbox">',
  /<input[^>]*type="checkbox"[^>]*id="use-camera"|<input[^>]*id="use-camera"[^>]*type="checkbox"/.test(htmlSrc));
ok('checkbox punya <label for> (aksesibilitas)',
  /<label[^>]*for="use-camera"/.test(htmlSrc));
ok('ada elemen status kamera yang diumumkan ke screen reader',
  /id="camera-status"/.test(htmlSrc) && /aria-live="polite"/.test(htmlSrc));
ok('tidak ada alert() lagi di jalur kamera — pakai status inline',
  !/alert\(['"]Modul kamera/.test(appCode) && !/alert\('Gagal akses kamera/.test(appCode));

// ─────────────────────────────────────────────────────────────────
section('2. Presence satu hub: kamera ON tidak boleh mematikan idle');

ok('app.js mengekspos callback presence untuk agent',
  /window\.__l2dPresenceChanged\s*=/.test(appSrc));
ok('agent.js memanggil callback itu di setiap perubahan presence',
  /__l2dPresenceChanged/.test(agentSrc));
ok('setPresence memberi tahu app.js SEBELUM keluar saat p === null',
  agentSrc.indexOf('__l2dPresenceChanged') < agentSrc.indexOf("if (p === null) return;"),
  'notifikasi mendahului early-return');

const r2 = loadAgent({ events: { quietMs: 0 }, l2d: fakeL2d({}) });
ok('agent.js dievaluasi tanpa error', !r2.error, r2.error ? r2.error.message : 'ok');
if (r2.agent) {
  r2.agent.setPresence(true);
  ok('setPresence(true) meneruskan true ke app.js',
    r2.calls.presenceCb[r2.calls.presenceCb.length - 1] === true);
  r2.agent.setPresence(null);
  ok('setPresence(null) juga diteruskan (fallback harus tahu)',
    r2.calls.presenceCb[r2.calls.presenceCb.length - 1] === null);
}

ok('idle repeat dibatalkan dengan clearInterval, bukan clearTimeout',
  /clearInterval\(agentIdleRepeat\)/.test(appSrc));
ok('ada stopAgentIdle() untuk menghentikan nagging saat user pergi',
  /function stopAgentIdle/.test(appSrc) && /stopAgentIdle\(\);\s*\/\/ away/.test(appSrc));

// ─────────────────────────────────────────────────────────────────
section('3. Config adalah otoritas (awaySpeak / returnSpeak / idleSpeak / quietMs)');

ok('config.json punya events.quietMs', typeof cfgSrc.events.quietMs === 'number', String(cfgSrc.events.quietMs));
ok('config.example.json juga punya events.quietMs', typeof cfgExample.events.quietMs === 'number');
ok('tidak ada lagi konstanta AGENT_QUIET_MS yang di-hardcode',
  !/AGENT_QUIET_MS\s*=\s*30\s*\*/.test(agentCode));
ok('agent membaca window.__appEvents (objek hidup, bukan snapshot)',
  /window\.__appEvents/.test(agentSrc) && /window\.__appEvents\s*=\s*EVENTS/.test(appSrc));

(async () => {
  // awaySpeak: false -> user pergi TIDAK boleh memicu panggilan LLM
  const rA = loadAgent({ events: { quietMs: 0, awaySpeak: false, returnSpeak: true }, l2d: fakeL2d({ sedih: 'param' }) });
  rA.agent.setPresence(true);
  rA.agent.setPresence(false);
  await wait(10);
  ok('awaySpeak:false -> tidak ada panggilan LLM saat user pergi',
    rA.calls.fetches.length === 0, rA.calls.fetches.length + ' panggilan');

  // awaySpeak: true -> harus memicu
  const rB = loadAgent({ events: { quietMs: 0, awaySpeak: true, returnSpeak: true }, l2d: fakeL2d({ sedih: 'param' }) });
  rB.agent.setPresence(true);
  rB.agent.setPresence(false);
  await wait(10);
  ok('awaySpeak:true -> user pergi memicu reaksi',
    rB.calls.fetches.length === 1, rB.calls.fetches.length + ' panggilan');

  // returnSpeak: false -> user balik tidak memicu
  const rC = loadAgent({ events: { quietMs: 0, awaySpeak: false, returnSpeak: false }, l2d: fakeL2d({}) });
  rC.agent.setPresence(false);
  rC.agent.setPresence(true);
  await wait(10);
  ok('returnSpeak:false -> user balik tidak memicu reaksi',
    rC.calls.fetches.length === 0, rC.calls.fetches.length + ' panggilan');

  // idleSpeak: false -> reactEvent('idle') ditolak di agent, bukan cuma di app
  const rD = loadAgent({ events: { quietMs: 0, idleSpeak: false }, l2d: fakeL2d({}) });
  await rD.agent.reactEvent('idle');
  await wait(10);
  ok('idleSpeak:false -> reactEvent("idle") ditolak di sisi agent juga',
    rD.calls.fetches.length === 0, rD.calls.fetches.length + ' panggilan');

  // quietMs besar -> semua event ditahan
  const rE = loadAgent({ events: { quietMs: 60000, awaySpeak: true, returnSpeak: true, idleSpeak: true }, l2d: fakeL2d({ sedih: 'param' }) });
  rE.agent.setPresence(true);
  rE.agent.setPresence(false);
  await rE.agent.reactEvent('idle');
  await wait(10);
  ok('quietMs masih berjalan -> semua event ambient ditahan',
    rE.calls.fetches.length === 0, rE.calls.fetches.length + ' panggilan');
  ok('quietMs terbaca dari config di _reactiveState()',
    rE.agent._reactiveState().quietMs === 60000, String(rE.agent._reactiveState().quietMs));

  // ─────────────────────────────────────────────────────────────────
  section('4. Emosi reaksi TIDAK boleh terikat satu karakter');

  ok('tidak ada setExpression dengan nama emosi literal di agent.js',
    !/setExpression\(\s*['"](sedih|senang|marah|kaget|malu|tersenyum|bingung)['"]/.test(agentCode));
  ok('agent memilih dari kemampuan model (getExpressibleEmotions)',
    /getExpressibleEmotions/.test(agentSrc));
  ok('app.js mengekspos getExpressibleEmotions()', /getExpressibleEmotions:/.test(appSrc));
  ok('app.js mengekspos expressEmotion() dengan fallback klip motion',
    /expressEmotion:/.test(appSrc) && /playEmotionClip\(name\)/.test(appSrc));

  // Model A punya 'sedih'; model B tidak punya sama sekali.
  const l2dA = fakeL2d({ sedih: 'param', senang: 'param' });
  const rF = loadAgent({ events: { quietMs: 0, awaySpeak: true }, l2d: l2dA });
  rF.agent.setPresence(true); rF.agent.setPresence(false);
  await wait(10);
  ok('model yang PUNYA "sedih" memakainya saat user pergi',
    l2dA._log.indexOf('sedih') !== -1, JSON.stringify(l2dA._log));

  const l2dB = fakeL2d({});   // tidak punya emosi apa pun
  const rG = loadAgent({ events: { quietMs: 0, awaySpeak: true }, l2d: l2dB });
  rG.agent.setPresence(true); rG.agent.setPresence(false);
  await wait(10);
  ok('model TANPA kosakata emosi tidak dipaksa berekspresi (no-op aman)',
    l2dB._log.length === 0, JSON.stringify(l2dB._log));
  ok('...tapi tetap bicara (reaksi verbal tidak bergantung emosi)',
    rG.calls.fetches.length === 1, rG.calls.fetches.length + ' panggilan');

  // Kosakata alternatif: model dengan nama .exp3 sendiri saja.
  const l2dC = fakeL2d({ bingung: 'native' });
  const rH = loadAgent({ events: { quietMs: 0, awaySpeak: true }, l2d: l2dC });
  rH.agent.setPresence(true); rH.agent.setPresence(false);
  await wait(10);
  ok('model dgn kosakata berbeda tetap dapat emosi dari preferensi berurutan',
    l2dC._log.indexOf('bingung') !== -1, JSON.stringify(l2dC._log));

  // Uji invariansi: emosi yang dipilih harus mengikuti kemampuan, bukan nama tetap.
  const picks = [];
  for (const vocab of [{ sedih: 'param' }, { malu: 'param' }, { bingung: 'clip' }]) {
    const l = fakeL2d(vocab);
    const r = loadAgent({ events: { quietMs: 0, awaySpeak: true }, l2d: l });
    r.agent.setPresence(true); r.agent.setPresence(false);
    await wait(5);
    picks.push(l._log[0]);
  }
  ok('tiga kosakata berbeda -> tiga pilihan berbeda (bukan konstanta)',
    new Set(picks).size === 3, JSON.stringify(picks));

  // ─────────────────────────────────────────────────────────────────
  section('5. Mood tidak boleh menempel selamanya');

  ok('app.js mengirim mood "normal" juga (tidak di-skip)',
    !/if \(m !== 'normal' && window\.__agent\)/.test(appCode) && /setUserMood\(m, 'text'\)/.test(appCode));

  const rI = loadAgent({ events: { quietMs: 0 }, l2d: fakeL2d({ sedih: 'param' }) });
  rI.agent.setUserMood('sedih', 'text');
  ok('mood teks tercatat', rI.agent._reactiveState().userMood === 'sedih');
  rI.agent.setUserMood('normal', 'text');
  ok('mood bisa kembali ke normal (tidak menempel)',
    rI.agent._reactiveState().userMood === 'normal', rI.agent._reactiveState().userMood);

  // Prioritas sumber: kamera > teks
  const rJ = loadAgent({ events: { quietMs: 0 }, l2d: fakeL2d({ sedih: 'param', senang: 'param' }) });
  rJ.agent.setUserMood('sedih', 'camera');
  rJ.agent.setUserMood('senang', 'text');
  ok('tebakan teks tidak menimpa mood dari kamera',
    rJ.agent._reactiveState().userMood === 'sedih', rJ.agent._reactiveState().userMood);
  rJ.agent.setUserMood('normal', 'text');
  ok('reset ke normal tetap diterima dari sumber mana pun',
    rJ.agent._reactiveState().userMood === 'normal');
  rJ.agent.setUserMood('senang', 'text');
  ok('setelah reset, teks boleh menetapkan mood lagi',
    rJ.agent._reactiveState().userMood === 'senang', rJ.agent._reactiveState().userMood);

  // ─────────────────────────────────────────────────────────────────
  section('6. Kamera: config diteruskan & sumber daya dilepas');

  ok('awayHiddenMs (dari events) diteruskan ke cameraPresence.start()',
    /awayHiddenMs:\s*EVENTS\.awayHiddenMs/.test(appSrc));
  ok('tidak ada lagi MOOD_GRACE_MS yang di-hardcode',
    !/const MOOD_GRACE_MS\s*=/.test(camCode));
  ok('grace/debounce/stabilitas mood bisa dikonfigurasi',
    /cfg\.moodGraceMs/.test(camSrc) && /cfg\.moodDebounceMs/.test(camSrc) && /cfg\.moodStableTicks/.test(camSrc));
  ok('fps tidak valid tidak membuat interval Infinity',
    /function tickIntervalMs/.test(camSrc) && /fps <= 0/.test(camSrc));
  ok('perhitungan "pergi" memakai interval yang sama dengan loop',
    /lowStreak \* tickIntervalMs\(\)/.test(camSrc));
  ok('gagal muat model tetap melepas stream kamera (lampu tidak menyala terus)',
    /releaseMedia\(\);\s*\n\s*throw err/.test(camSrc));
  ok('loop kamera pakai rantai setTimeout (inferensi tidak menumpuk)',
    /setTimeout\(loop, intervalMs\)/.test(camCode) && !/setInterval\(tick,/.test(camCode));
  ok('config.example.json mendokumentasikan opsi kamera baru',
    typeof cfgExample.camera.moodGraceMs === 'number' && typeof cfgExample.camera.moodStableTicks === 'number');
  ok('config.json juga membawa opsi kamera baru (bukan cuma contoh)',
    typeof cfgSrc.camera.moodGraceMs === 'number' && typeof cfgSrc.camera.moodStableTicks === 'number');

  // ─────────────────────────────────────────────────────────────────
  section('7. Cache server tidak boleh membekukan blok config yang bukan miliknya');

  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const serverCode = stripComments(serverSrc);
  ok('persistConnections() tidak menyimpan seluruh objek config ke runtimeConfig',
    !/runtimeConfig\s*=\s*data\s*;/.test(serverCode));
  ok('runtimeConfig hanya memuat activeId + connections',
    /runtimeConfig\s*=\s*\{\s*activeId:[^}]*connections:[^}]*\}/.test(serverCode));
  ok('loadConfig() tetap menaruh runtimeConfig di atas isi file',
    /Object\.assign\(\{\},\s*base,\s*runtimeConfig/.test(serverCode),
    'urutan ini yang membuat cache luas jadi berbahaya');

  // ─────────────────────────────────────────────────────────────────
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
