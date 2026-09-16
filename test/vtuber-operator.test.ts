/**
 * vtuber-operator.test.ts — S3-B: jalur OPERATOR (composer jendela utama) +
 * SLOT AKTIF BERSAMA donation/operator (maks 1 lifecycle ucap).
 *
 * Fungsi yang diuji = teks ASLI static/js/mode-runtime.js (ekstraksi
 * brace-matcher + vm — pola S3-A). Prelude mengulang SEMUA closure state
 * termasuk yang baru (opQueue/OP_QUEUE_MAX) dan SPEECH_WAIT_MAX_MS kecil agar
 * uji watchdog deterministik tanpa menunggu 60 dtk.
 *
 * Invarian yang dikunci (Behavior Contract S3-B, keputusan D-1..D-5):
 *  - operator = perintah eksplisit: TIDAK pernah lewat dup-key/cooldown
 *    audience; dedup HANYA event-id; teks sama dua kali = dua perintah sah.
 *  - satu slot (flag bersama donoBusy): donation dan operator tidak pernah
 *    berjalan bersamaan; klaim sinkron sebelum await pertama.
 *  - D-1 prioritas KALA KLAIM: donasi dulu; slot yang jalan tidak dipreempt.
 *  - lifecycle sama dengan donasi: maju hanya setelah ucap selesai
 *    (completed/lost/watchdog); error tidak deadlock; teardown membungkam.
 *  - D-3: overlay ON / respond OFF tidak membungkam operator.
 *  - composer HANYA menyuntik event (mock-event type=operator) — tanpa
 *    LLM/ucap sendiri; server mempertahankan tipe "operator", tipe asing
 *    tetap jatuh ke "chat".
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import {
  vtuberStart,
  vtuberStop,
  vtuberInjectEvent,
} from "../src/server/vtuber";

const repoRoot = resolve(import.meta.dir, "..");
const src = readFileSync(join(repoRoot, "static", "js", "mode-runtime.js"), "utf8");

function extractFn(s: string, name: string): string {
  const m = s.match(new RegExp("\\b(async\\s+)?function\\s+" + name + "\\s*\\("));
  if (!m || m.index === undefined) throw new Error(name + " tidak ada di mode-runtime.js");
  let i = s.indexOf("{", m.index + m[0].length - 1);
  let depth = 0, inStr: string | null = null, esc = false;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (!depth) break; }
  }
  const fnStart = s.indexOf("function", m.index);
  return (m[1] ? "async " : "") + s.slice(fnStart, i + 1);
}

interface OpEv { id: number; type: string; user: string; text: string; amount?: string }

const makePrelude = () => `
    var cursor = 0; var stopped = false; var lastSpeakAt = 0; var overlayOn = false;
    var audBusy = false; var gen = 0; var donoBusy = false;
    var seenIds = new Map(); var dupKeys = new Map();
    var donoQueue = []; var opQueue = [];
    var AUDIENCE_DUP_MS = 8000; var AUDIENCE_SEEN_MS = 300000;
    var AUDIENCE_SEEN_MAX = 500; var DONO_QUEUE_MAX = 20; var OP_QUEUE_MAX = 20;
    var SPEECH_WAIT_MAX_MS = 40; // watchdog cepat — uji pelepasan slot deterministik
    var __respond = true;
    var __ctl = {
      set: function (name, val) {
        if (name === "lastSpeakAt") lastSpeakAt = val;
        else if (name === "donoBusy") donoBusy = val;
        else if (name === "stopped") stopped = val;
        else if (name === "overlay") overlayOn = val;
        else if (name === "respond") __respond = val;
        else if (name === "bumpGen") gen++;
        else if (name === "clearQueue") donoQueue.length = 0;
        else if (name === "clearOpQueue") opQueue.length = 0;
      },
      // vm Bun: binding var script TIDAK tersinkron dua arah dengan sandbox —
      // skalar dibaca/tulis lewat fungsi DI DALAM context (pola S3-A).
      get: function (name) {
        if (name === "audBusy") return audBusy;
        if (name === "donoBusy") return donoBusy;
        if (name === "stopped") return stopped;
        if (name === "gen") return gen;
        if (name === "lastSpeakAt") return lastSpeakAt;
        return undefined;
      },
    };
    var $ = (sel) => sel === "#vt-respond" ? { checked: __respond }
      : sel === "#vt-cooldown" ? { value: "12" }
      : sel === "#vt-persona" ? { value: "ceria" } : {};
    var __t = (k, v) => k + ":" + JSON.stringify(v || {});
    var llm = [];
    var askLLM = (msgs) => new Promise((res, rej) => { llm.push({ res, rej, prompt: msgs[0].content }); });
    var agentSays = []; var lines = []; var speaks = []; var addChats = [];
    var vtuberAgentSay = (t) => { agentSays.push(t); };
    var line = (ev) => { lines.push(ev); };
    var window = {
      __debugSpeak: (t, done, producer) => { speaks.push({ t, done, producer }); },
      __addChat: (r, t) => { addChats.push(t); },
    };
    var console = { warn() {}, log() {}, error() {} };
`;

function makeRuntime() {
  const fnames = [
    "pruneSeen", "alreadySeen", "noteSeen", "normKey", "audienceDup",
    "speak", "speakWait", "maybeRespond", "enqueueDonation", "pumpDonations",
    "enqueueOperator", "pumpOperators",
  ];
  const body = fnames.map((f) => extractFn(src, f)).join("\n\n");
  const sandbox: any = { setTimeout, clearTimeout, Date, Math, Number, String, JSON, Promise, Map, console, Error };
  vm.createContext(sandbox);
  vm.runInContext(makePrelude() + "\n" + body, sandbox);
  const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
  const set = (k: string, v?: any) => sandbox.__ctl.set(k, v);
  const get = (k: string) => sandbox.__ctl.get(k);
  return { sandbox, tick, set, get };
}

const op = (id: number, text = "ucapkan greeting", user = "operator"): OpEv =>
  ({ id, type: "operator", user, text });
const chat = (id: number, user: string, text: string): OpEv => ({ id, type: "chat", user, text });
const dono = (id: number, user: string, text: string, amount = "Rp 50.000"): OpEv =>
  ({ id, type: "donation", user, text, amount });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prompts = (sandbox: any) => sandbox.llm.map((l: any) => String(l.prompt)).join("|");

// ═══ OPERATOR FIFO ═══════════════════════════════════════════════════
describe("S3-B OPERATOR — FIFO + lifecycle parity dengan donasi", () => {
  test("O1: event operator → LLM (operatorPrompt, teks utuh) → ucap via kanal (producer vtuber/operator)", async () => {
    const { sandbox, tick, get } = makeRuntime();
    sandbox.enqueueOperator(op(1, "sapa penonton baru"));
    await tick();
    expect(sandbox.llm.length).toBe(1);
    expect(String(sandbox.llm[0].prompt)).toContain("operatorPrompt");
    expect(String(sandbox.llm[0].prompt)).toContain("sapa penonton baru");
    expect(get("donoBusy")).toBe(true);           // slot bersama terklaim
    sandbox.llm[0].res("Halo penonton baru!");
    await tick();
    expect(sandbox.agentSays).toEqual(["Halo penonton baru!"]);
    expect(sandbox.speaks[0].producer).toBe("vtuber/operator");
    sandbox.speaks[0].done();
    await tick();
    expect(get("donoBusy")).toBe(false);          // slot lepas setelah lifecycle ucap
  });

  test("O2: dua perintah FIFO — yang kedua BELUM mulai sampai ucap pertama selesai", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.enqueueOperator(op(1, "satu"));
    sandbox.enqueueOperator(op(2, "dua"));
    await tick();
    expect(sandbox.llm.length).toBe(1);
    expect(sandbox.opQueue.map((e: OpEv) => e.id)).toEqual([2]);
    sandbox.llm[0].res("jaw1");
    await tick();
    expect(sandbox.llm.length).toBe(1);           // masih menunggu lifecycle ucap
    sandbox.speaks[0].done();
    await tick();
    expect(sandbox.llm.length).toBe(2);
    expect(String(sandbox.llm[1].prompt)).toContain('"text":"dua"');
    sandbox.llm[1].res("jaw2");
    await tick();
    sandbox.speaks[1].done();
    await tick();
    expect(sandbox.opQueue.length).toBe(0);
  });

  test("O3: ucap direbut kanal (lost) → slot berakhir, LANJUT ke O2 — bukan retry O1", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.enqueueOperator(op(1, "satu"));
    sandbox.enqueueOperator(op(2, "dua"));
    await tick();
    sandbox.llm[0].res("jaw1");
    await tick();
    sandbox.speaks[0].done();                     // outcome apa pun mengakhiri slot
    await tick();
    expect(sandbox.llm.length).toBe(2);
    expect(String(sandbox.llm[1].prompt)).toContain('"text":"dua"'); // maju, bukan retry
    sandbox.llm[1].res("");
  });

  test("O4: event-id sama datang dua kali → diproses sekali (dedup identity)", async () => {
    const { sandbox, set } = makeRuntime();
    set("donoBusy", true);                         // tahan drain — hanya cek antrean
    sandbox.enqueueOperator(op(9, "sama"));
    sandbox.enqueueOperator(op(9, "sama"));
    expect(sandbox.opQueue.length).toBe(1);
  });

  test("O5: teks operator SAMA dua kali (id beda) → KEDUANYA diproses; tidak pernah lewat dupKeys", async () => {
    const { sandbox, tick, get } = makeRuntime();
    sandbox.enqueueOperator(op(1, "ulang"));
    await tick();
    sandbox.llm[0].res("a");
    await tick();
    sandbox.speaks[0].done();
    await tick();
    sandbox.enqueueOperator(op(2, "ulang"));
    await tick();
    expect(sandbox.llm.length).toBe(2);            // teks sama BUKAN spam
    expect(sandbox.dupKeys.size).toBe(0);          // jalur operator tak menyentuh key audience
    expect(get("audBusy")).toBe(false);            // state audience tak tersentuh
    sandbox.llm[1].res("");
  });

  test("O6: D-1 prioritas saat klaim — slot bebas + dua antrean menunggu → DONASI dulu", async () => {
    const { sandbox, tick, set } = makeRuntime();
    set("donoBusy", true);                          // tahan drain, dua antrean terbentuk
    sandbox.enqueueDonation(dono(1, "rian", "terbaik"));
    sandbox.enqueueOperator(op(2, "menyapa"));
    expect(sandbox.donoQueue.length).toBe(1);
    expect(sandbox.opQueue.length).toBe(1);
    set("donoBusy", false);
    sandbox.pumpOperators();                        // pemicu operator saat donasi menunggu
    await tick();
    expect(String(sandbox.llm[0].prompt)).toContain("donatePrompt"); // donasi yang klaim
    expect(sandbox.opQueue.map((e: OpEv) => e.id)).toEqual([2]);      // operator tetap antre
    sandbox.llm[0].res("");
  });

  test("O7: operator sedang jalan + donasi tiba → TIDAK dipreempt; donasi berikutnya", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.enqueueOperator(op(1, "perintah"));
    await tick();
    sandbox.llm[0].res("jaw");
    await tick();                                    // operator sedang ucap
    sandbox.enqueueDonation(dono(2, "rian", "terbaik"));
    await tick();
    expect(sandbox.llm.length).toBe(1);              // donasi TIDAK mem-preempt slot
    expect(sandbox.donoQueue.length).toBe(1);
    sandbox.speaks[0].done();                        // operator selesai
    await tick();
    expect(sandbox.llm.length).toBe(2);
    expect(String(sandbox.llm[1].prompt)).toContain("donatePrompt"); // donasi berikutnya
    sandbox.llm[1].res("");
  });

  test("O8: antrean operator penuh → yang TERBARU dijatuhkan, FIFO tertampung utuh (cap 20)", async () => {
    const { sandbox, set } = makeRuntime();
    set("donoBusy", true);
    for (let i = 1; i <= 20; i++) sandbox.enqueueOperator(op(i, "t" + i));
    sandbox.enqueueOperator(op(21, "terlambat"));
    expect(sandbox.opQueue.length).toBe(20);
    expect(sandbox.opQueue[0].id).toBe(1);
    expect(sandbox.opQueue.some((e: OpEv) => e.id === 21)).toBe(false);
  });

  test("O9: LLM error → slot berakhir, perintah berikutnya lanjut tanpa drain manual", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.enqueueOperator(op(1, "satu"));
    sandbox.enqueueOperator(op(2, "dua"));
    await tick();
    sandbox.llm[0].rej(new Error("LLM mati"));
    await tick(16);
    expect(sandbox.llm.length).toBe(2);
    expect(String(sandbox.llm[1].prompt)).toContain('"text":"dua"');
    expect(sandbox.lines.some((l: any) => l.type === "system")).toBe(true); // feed mencatat
    sandbox.llm[1].res("");
  });

  test("O10: stop/destroy di tengah operator → kontinuaasi basi diam + antrean ikut mati", async () => {
    const { sandbox, tick, set } = makeRuntime();
    sandbox.enqueueOperator(op(1, "jalan"));
    sandbox.enqueueOperator(op(2, "antre"));
    await tick();
    set("stopped", true); set("bumpGen"); set("clearQueue"); set("clearOpQueue"); // efek destroy()
    sandbox.llm[0].res("tidak boleh terdengar");
    await tick();
    expect(sandbox.agentSays.length).toBe(0);
    expect(sandbox.speaks.filter((s: any) => s.producer === "vtuber/operator").length).toBe(0);
    expect(sandbox.opQueue.length).toBe(0);          // antrean tidak selamat lintas teardown
  });

  test("O11: D-3 overlay OBS aktif → operator TETAP diproses (donasi yield — kontrol)", async () => {
    const { sandbox, tick, set } = makeRuntime();
    set("overlay", true);
    sandbox.enqueueDonation(dono(1, "rian", "terbaik"));
    await tick();
    expect(sandbox.llm.length).toBe(0);              // kontrol: donasi tetap yield
    sandbox.enqueueOperator(op(2, "ucapkan"));
    await tick();
    expect(sandbox.llm.length).toBe(1);              // operator tidak diredam overlay
    sandbox.llm[0].res(" halo");
    await tick();
    expect(sandbox.speaks[0].producer).toBe("vtuber/operator");
    sandbox.speaks[0].done();
  });

  test("O12: switch auto-balas audience OFF → operator TETAP diproses (input eksplisit)", async () => {
    const { sandbox, tick, set } = makeRuntime();
    set("respond", false);
    sandbox.maybeRespond(chat(1, "rina", "halo"));
    await tick();
    expect(sandbox.llm.length).toBe(0);              // kontrol: audience patuh switch
    sandbox.enqueueOperator(op(2, "perintah"));
    await tick();
    expect(sandbox.llm.length).toBe(1);
    sandbox.llm[0].res("");
  });

  test("O13: drain antrean kosong aman + pemicu ganda bersamaan → satu proses", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.pumpOperators();                          // kosong
    await tick();
    expect(sandbox.llm.length).toBe(0);
    sandbox.enqueueOperator(op(1, "satu"));
    await tick();
    sandbox.pumpOperators();                          // dipicu ulang saat berjalan
    sandbox.pumpOperators();
    await tick();
    expect(sandbox.llm.length).toBe(1);
    sandbox.llm[0].res("");
  });

  test("O20: bridge ucap tak pernah memanggil callback → watchdog melepas slot (tanpa deadlock)", async () => {
    const { sandbox, tick, get } = makeRuntime();
    sandbox.enqueueOperator(op(1, "satu"));
    sandbox.enqueueOperator(op(2, "dua"));
    await tick();
    sandbox.llm[0].res("jaw1");
    await tick();
    // speaks[0].done() TIDAK pernah dipanggil — watchdog 40ms (prelude) bekerja
    expect(get("donoBusy")).toBe(true);
    await sleep(120);
    await tick();
    expect(get("donoBusy")).toBe(true);               // O2 kini aktif — slot TIDAK bocor
    expect(sandbox.llm.length).toBe(2);
    expect(String(sandbox.llm[1].prompt)).toContain('"text":"dua"');
    sandbox.llm[1].res("jaw2");
    await tick();
    sandbox.speaks[1].done();                          // O2 selesai normal
    await tick();
    expect(get("donoBusy")).toBe(false);
  });
});

// ═══ COMPOSER (input operator) ═══════════════════════════════════════
describe("S3-B composer — hanya menyuntik event, tanpa LLM/ucap sendiri", () => {
  function makeComposer(fail = false) {
    const body = extractFn(src, "onOperatorSend");
    const pre = `
      var __fail = ${fail ? "true" : "false"};
      var posted = []; var llmCalls = 0; var speakCalls = [];
      var setStatusLog = [];
      var setStatus = (t, c) => { setStatusLog.push({ t, c }); };
      var askLLM = () => { llmCalls++; return Promise.resolve(""); };
      var window = { __debugSpeak: (t, d, p) => { speakCalls.push({ t, p }); } };
      var opInputEl = { value: "  sapa  Rina  " };
      var post = (path, body) => {
        posted.push({ path, body });
        return __fail ? Promise.reject(new Error("runtime tidak aktif")) : Promise.resolve({});
      };
      var console = { warn() {}, log() {}, error() {} };
    `;
    const sandbox: any = { setTimeout, Promise, String, Math, console, Error };
    vm.createContext(sandbox);
    vm.runInContext(pre + "\n" + body, sandbox);
    const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
    return { sandbox, tick };
  }

  test("O14: submit → POST mock-event {type:operator,user:operator,text trim} — TANPA LLM/ucap", async () => {
    const { sandbox, tick } = makeComposer();
    sandbox.onOperatorSend();
    await tick();
    expect(sandbox.posted.length).toBe(1);
    expect(sandbox.posted[0].path).toBe("/api/vtuber/mock-event");
    expect(sandbox.posted[0].body).toEqual({ type: "operator", user: "operator", text: "sapa  Rina" });
    expect(sandbox.opInputEl.value).toBe("");          // terkirim → input dibersihkan
    expect(sandbox.llmCalls).toBe(0);                  // composer buta LLM
    expect(sandbox.speakCalls.length).toBe(0);         // composer buta ucap
  });

  test("O14b: input kosong/whitespace → tidak ada event; server-down → status gagal", async () => {
    const { sandbox, tick } = makeComposer(false);
    sandbox.opInputEl.value = "   \n ";
    sandbox.onOperatorSend();
    await tick();
    expect(sandbox.posted.length).toBe(0);
    const bad = makeComposer(true);
    bad.sandbox.onOperatorSend();
    await bad.tick();
    expect(bad.sandbox.setStatusLog.length).toBe(1);
    expect(bad.sandbox.setStatusLog[0].t).toContain("gagal");
  });
});

// ═══ SERVER: kontrak tipe operator ═══════════════════════════════════
describe("S3-B server — mock-event mempertahankan tipe operator", () => {
  test("O16: type=operator lolos utuh; type asing tetap jatuh ke chat", () => {
    expect(vtuberStart({ provider: "mock" }).ok).toBe(true);
    try {
      const ev = vtuberInjectEvent({ type: "operator", user: "operator", text: "ucapkan halo" });
      expect(ev).not.toBeNull();
      expect(ev!.type).toBe("operator");
      expect(vtuberInjectEvent({ type: "ngawur", user: "X", text: "?" })!.type).toBe("chat");
      expect(vtuberInjectEvent({ type: "donation", user: "Rian", text: "gopek", amount: "Rp 10.000" })!.type).toBe("donation");
    } finally {
      vtuberStop();
    }
  });
});

// ═══ WIRING / LIFECYCLE guards (sumber) ══════════════════════════════
describe("S3-B wiring & lifecycle (source guards)", () => {
  test("O15: poll merutekan operator ke enqueueOperator (bukan chat/donation)", () => {
    expect(src).toMatch(/\} else if \(ev\.type === "operator"\) \{[\s\S]{0,80}enqueueOperator\(ev\);/);
    expect(src).toMatch(/pumpOperators\(\);/);         // sapuan wake per-poll
  });

  test("O17: onStop() dan destroy() ikut mengosongkan antrean operator", () => {
    const dest = src.slice(src.indexOf("return function destroy()"));
    expect(dest).toMatch(/donoQueue\.length = 0;[\s\S]{0,80}opQueue\.length = 0;/);
    const stop = src.slice(src.indexOf("const onStop = async"), src.indexOf("const onStop = async") + 700);
    expect(stop).toMatch(/donoQueue\.length = 0;[\s\S]{0,80}opQueue\.length = 0;/);
  });

  test("O18: pumpDonations & jalur S3-A utuh — S3-B murni menambahkan", () => {
    // Header drain donasi tidak berubah (satu slot = flag yang sama, bukan queue baru)
    expect(src).toMatch(/async function pumpDonations\(\) \{\s*\n\s*if \(donoBusy\) return;/);
    expect(src).toMatch(/donoQueue\.push\(ev\);\s*\n\s*pumpDonations\(\);/);
    // Composer buta terhadap jalur ucap/agent lain — dicek pada BADANNya, bukan jarak file
    const composerBody = extractFn(src, "onOperatorSend");
    expect(composerBody).not.toMatch(/askLLM|__debugSpeak|__agent|speak\(/);
    expect(composerBody).toMatch(/post\("\/api\/vtuber\/mock-event", \{ type: "operator", user: "operator", text \}\)/);
  });

  test("O19: D-5 — #vt-donate-respond tidak disentuh jalur mana pun", () => {
    expect(src).not.toMatch(/vt-donate-respond/);       // mode-runtime buta switch mati itu
    const html = readFileSync(join(repoRoot, "static", "index.html"), "utf8");
    expect((html.match(/vt-donate-respond/g) || []).length).toBe(1); // tetap satu, utuh
  });
});
