/**
 * vtuber-audience-donation.test.ts — S3-A: suppressi AUDIENCE + antrean FIFO
 * DONATION pada responder VTuber jendela utama.
 *
 * Fungsi yang diuji = teks ASLI static/js/mode-runtime.js (ekstraksi
 * brace-matcher + vm — pola capability-resync). Catatan vm Bun: tulis dari
 * host ke binding script TIDAK terpropagasi — karena itu test mengatur state
 * closure lewat __ctl (setter yang didefinisikan DI DALAM context), dan semua
 * fungsi async dipanggil FIRE-AND-FORGET (persis cara poll() memanggilnya),
 * lalu flush dengan microtask tick. LLM dan ucap dikendalikan deferred
 * manual — deterministik, tanpa sleep-sebagai-bukti.
 *
 * Invarian yang dikunci:
 *  AUDIENCE: seen-id → dup-key 8dtk per-user → cooldown → satu in-flight.
 *            Yang ditekan TIDAK masuk antrean apa pun.
 *  DONATION: tidak pernah lewat cooldown/dup audience; FIFO cap 20 (buang
 *            yang terbaru); drain serialized; maju hanya setelah lifecycle
 *            ucap (completed ATAU lost); error tidak mendeadlock; teardown
 *            (stopped+gen) membungkam kontinuaasi basi.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

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

interface Dono { id: number; type: string; user: string; text: string; amount?: string }

function makeRuntime() {
  const fnames = [
    "pruneSeen", "alreadySeen", "noteSeen", "normKey", "audienceDup",
    "speak", "speakWait", "maybeRespond", "enqueueDonation", "pumpDonations",
  ];
  const prelude = `
    var cursor = 0; var stopped = false; var lastSpeakAt = 0; var overlayOn = false;
    var audBusy = false; var gen = 0; var donoBusy = false;
    var seenIds = new Map(); var dupKeys = new Map(); var donoQueue = [];
    var AUDIENCE_DUP_MS = 8000; var AUDIENCE_SEEN_MS = 300000;
    var AUDIENCE_SEEN_MAX = 500; var DONO_QUEUE_MAX = 20; var SPEECH_WAIT_MAX_MS = 60000;
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
      },
      // vm Bun: binding var dalam script TIDAK tersinkron dua arah dengan
      // objek host — baca/tulis state skalar WAJIB lewat fungsi di dalam
      // context (array/Map aman dirujuk langsung karena tidak pernah di-
      // reassign, hanya dimutasi).
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
    var llm = []; // askLLM deferred — test resolve/reject manual
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
  const body = fnames.map((f) => extractFn(src, f)).join("\n\n");
  const sandbox: any = { setTimeout, clearTimeout, Date, Math, Number, String, JSON, Promise, Map, console, Error };
  vm.createContext(sandbox);
  vm.runInContext(prelude + "\n" + body, sandbox);
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
  const set = (k: string, v?: any) => sandbox.__ctl.set(k, v);
  const get = (k: string) => sandbox.__ctl.get(k);
  return { sandbox, tick, set, get };
}

const chat = (id: number, user: string, text: string): Dono => ({ id, type: "chat", user, text });
const dono = (id: number, user: string, text: string, amount = "Rp 50.000"): Dono =>
  ({ id, type: "donation", user, text, amount });

// ═══ AUDIENCE ═══════════════════════════════════════════════════════════
describe("S3-A AUDIENCE — seen/dedup 8dtk per-user → cooldown → satu in-flight", () => {
  test("A1: event audience normal → LLM → ucap via kanal (producer vtuber/audience)", async () => {
    const { sandbox, tick, get } = makeRuntime();
    sandbox.maybeRespond(chat(1, "rina", "halo"));
    await tick();
    expect(sandbox.llm.length).toBe(1);
    sandbox.llm[0].res("Halo juga rina!");
    await tick();
    expect(sandbox.agentSays).toEqual(["Halo juga rina!"]);
    expect(sandbox.speaks[0].producer).toBe("vtuber/audience");
    expect(get("audBusy")).toBe(false);
  });

  test("A2: pesan SAMA dari user SAMA dalam window → kedua ditekan (bukan diantrekan)", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.maybeRespond(chat(1, "rina", "halo"));
    await tick();
    sandbox.maybeRespond(chat(2, "rina", "halo"));
    await tick();
    expect(sandbox.llm.length).toBe(1);
    expect(sandbox.donoQueue.length).toBe(0); // suppression = final, BUKAN antrean
  });

  test("A3: ID event yang sama datang dua kali (polling dobel) → satu proses", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.maybeRespond(chat(7, "budi", "asik"));
    await tick();
    sandbox.maybeRespond(chat(7, "budi", "asik"));
    await tick();
    expect(sandbox.llm.length).toBe(1);
    expect(sandbox.dupKeys.size).toBe(1);
  });

  test("A4: user BEDA dengan teks sama → TIDAK dibungkam dedup", async () => {
    const { sandbox, tick, set } = makeRuntime();
    sandbox.maybeRespond(chat(1, "rina", "gg"));
    await tick();
    sandbox.llm[0].res("");                   // selesai tanpa ucap
    await tick();
    set("lastSpeakAt", 0);                    // lewati cooldown — uji dedup saja
    sandbox.maybeRespond(chat(2, "dwi", "gg"));
    await tick();
    expect(sandbox.llm.length).toBe(2);       // pesan sah user kedua diterima
  });

  test("A5: cooldown → event baru ditekan; tidak masuk antrean mana pun", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.maybeRespond(chat(1, "rina", "satu"));
    await tick();
    sandbox.llm[0].res("");
    await tick();
    sandbox.maybeRespond(chat(2, "rina", "dua")); // cooldown aktif, dup key beda
    await tick();
    expect(sandbox.llm.length).toBe(1);
    expect(sandbox.donoQueue.length).toBe(0);
  });

  test("A6: in-flight — request audience KEDUA tidak pernah paralel", async () => {
    const { sandbox, tick, set, get } = makeRuntime();
    sandbox.maybeRespond(chat(1, "rina", "satu"));
    await tick();
    set("lastSpeakAt", 0);                     // cooldown lepas — yang menahan kini audBusy
    sandbox.maybeRespond(chat(2, "rina", "dua"));
    await tick();
    expect(sandbox.llm.length).toBe(1);
    sandbox.llm[0].res("");
    await tick();
    expect(get("audBusy")).toBe(false);
  });

  test("A-window: dup window kedaluwarsa → pesan berulang boleh diterima lagi", async () => {
    const { sandbox, tick, set } = makeRuntime();
    sandbox.maybeRespond(chat(1, "rina", "halo"));
    await tick();
    sandbox.llm[0].res("");
    await tick();
    set("lastSpeakAt", 0);
    // mundurkan timestamp dup key (simulasi window 8 dtk lewat):
    sandbox.dupKeys.set("rina::halo", Date.now() - 8001);
    sandbox.maybeRespond(chat(2, "rina", "halo"));
    await tick();
    expect(sandbox.llm.length).toBe(2);
    sandbox.llm[1].res("");
  });
});

// ═══ DONATION ═══════════════════════════════════════════════════════════
describe("S3-A DONATION — FIFO berurutan, tahan cooldown/duplikat/error/teardown", () => {
  test("D1: donasi tiba saat cooldown audience aktif → diproses, TIDAK hilang", async () => {
    const { sandbox, tick, set } = makeRuntime();
    set("lastSpeakAt", Date.now());            // audience cooldown SEDANG aktif
    sandbox.enqueueDonation(dono(1, "rian", "terbaik"));
    await tick();
    expect(sandbox.llm.length).toBe(1);        // donasi masuk jalur sendiri
    expect(String(sandbox.llm[0].prompt)).toContain("donatePrompt");
    sandbox.llm[0].res("");
  });

  test("D2/D3/D6: A→B→C FIFO; drain serialized; queue maju HANYA setelah lifecycle ucap", async () => {
    const { sandbox, tick, get } = makeRuntime();
    sandbox.enqueueDonation(dono(1, "A", "a"));
    sandbox.enqueueDonation(dono(2, "B", "b"));
    sandbox.enqueueDonation(dono(3, "C", "c"));
    await tick();
    expect(sandbox.llm.length).toBe(1);        // hanya A diproses
    expect(sandbox.donoQueue.map((e: Dono) => e.id)).toEqual([2, 3]);
    sandbox.llm[0].res("makasih A");
    await tick();
    expect(sandbox.speaks[0].producer).toBe("vtuber/donation");
    expect(sandbox.llm.length).toBe(1);        // D6: B BELUM mulai — ucap A belum selesai
    sandbox.speaks[0].done();                  // completed → slot A berakhir
    await tick();
    expect(sandbox.llm.length).toBe(2);
    expect(String(sandbox.llm[1].prompt)).toContain('"user":"B"');
    sandbox.llm[1].res("makasih B");
    await tick();
    sandbox.speaks[1].done();
    await tick();
    expect(String(sandbox.llm[2].prompt)).toContain('"user":"C"');
    sandbox.llm[2].res("makasih C");
    await tick();
    sandbox.speaks[2].done();
    await tick();
    expect(sandbox.donoQueue.length).toBe(0);
    expect(get("donoBusy")).toBe(false);
  });

  test("D4: donasi event sama terlihat dua kali polling → diproses sekali", async () => {
    const { sandbox, set } = makeRuntime();
    set("donoBusy", true);                      // tahan drain — hanya cek antrean
    sandbox.enqueueDonation(dono(9, "x", "y"));
    sandbox.enqueueDonation(dono(9, "x", "y"));
    expect(sandbox.donoQueue.length).toBe(1);
  });

  test("D5-error: donasi A gagal → slot berakhir, B lanjut tanpa drain manual", async () => {
    const { sandbox, tick, get } = makeRuntime();
    sandbox.enqueueDonation(dono(1, "A", "a"));
    sandbox.enqueueDonation(dono(2, "B", "b"));
    await tick();
    sandbox.llm[0].rej(new Error("LLM mati"));
    await tick(12);
    expect(sandbox.donoQueue.length).toBe(0);  // B sudah bergeser keluar antrean
    expect(get("donoBusy")).toBe(true);        // drain lanjut AKTIF di B (bukan deadlock)
    expect(sandbox.llm.length).toBe(2);        // B jalan — tanpa deadlock
    expect(String(sandbox.llm[1].prompt)).toContain('"user":"B"');
    sandbox.llm[1].res("");
  });

  test("D5-lost: ucap donasi direbut kanal → slot berakhir, TIDAK retry tanpa batas", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.enqueueDonation(dono(1, "A", "a"));
    sandbox.enqueueDonation(dono(2, "B", "b"));
    await tick();
    sandbox.llm[0].res("jawA");
    await tick();
    sandbox.speaks[0].done();                  // selesai outcome apa pun → lanjut
    await tick();
    expect(sandbox.llm.length).toBe(2);
    expect(String(sandbox.llm[1].prompt)).toContain('"user":"B"'); // B, bukan retry A
    sandbox.llm[1].res("");
  });

  test("D7: audience menyela tidak mengubah urutan donasi A→B", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.enqueueDonation(dono(1, "A", "a")); // donasi mulai → llm[0]
    sandbox.enqueueDonation(dono(2, "B", "b"));
    await tick();
    sandbox.maybeRespond(chat(50, "rina", "halo")); // audience independen → llm[1]
    await tick();
    sandbox.llm[1].res("hi");                    // audience: speak fire-and-forget
    sandbox.llm[0].res("makasih A");             // donasi A selesai LLM, ucap menunggu
    await tick();
    const don = sandbox.speaks.find((s: any) => s.producer === "vtuber/donation");
    don.done();
    await tick();
    const prompts = sandbox.llm.map((l: any) => String(l.prompt)).join("|");
    expect(prompts.indexOf('"user":"A"')).toBeGreaterThanOrEqual(0);
    expect(prompts.indexOf('"user":"B"')).toBeGreaterThan(prompts.indexOf('"user":"A"'));
    sandbox.llm[2] && sandbox.llm[2].res("");
  });

  test("D8: destroy di tengah donasi → kontinuaasi basi tidak bersuara", async () => {
    const { sandbox, tick, set } = makeRuntime();
    sandbox.enqueueDonation(dono(1, "A", "a"));
    await tick();
    set("stopped", true); set("bumpGen"); set("clearQueue");   // efek destroy()
    sandbox.llm[0].res("tidak boleh terdengar");
    await tick();
    expect(sandbox.agentSays.length).toBe(0);
    expect(sandbox.speaks.filter((s: any) => s.producer === "vtuber/donation").length).toBe(0);
  });

  test("D8b: overlay aktif → donasi tidak diucapkan (yield existing), slot tetap selesai", async () => {
    const { sandbox, tick, set, get } = makeRuntime();
    set("overlay", true);
    sandbox.enqueueDonation(dono(1, "A", "a"));
    await tick();
    expect(sandbox.llm.length).toBe(0);        // tidak ada LLM boros saat yield
    expect(sandbox.donoQueue.length).toBe(0);  // slot selesai — antrean tidak tersumbat
    expect(get("donoBusy")).toBe(false);
  });

  test("D9/D10: drain kosong aman + dua pemicu bersamaan → satu proses", async () => {
    const { sandbox, tick } = makeRuntime();
    sandbox.pumpDonations();                    // D9: queue kosong
    await tick();
    expect(sandbox.llm.length).toBe(0);
    sandbox.enqueueDonation(dono(1, "A", "a"));
    await tick();
    sandbox.pumpDonations();                    // D10: dipicu ulang saat berjalan
    sandbox.pumpDonations();
    await tick();
    expect(sandbox.llm.length).toBe(1);
    sandbox.llm[0].res("");
  });

  test("D-bound: antrean penuh menjatuhkan yang TERBARU, FIFO tertampung utuh", async () => {
    const { sandbox, set } = makeRuntime();
    set("donoBusy", true);
    for (let i = 1; i <= 20; i++) sandbox.enqueueDonation(dono(i, "u" + i, "t"));
    sandbox.enqueueDonation(dono(21, "late", "t"));
    expect(sandbox.donoQueue.length).toBe(20);
    expect(sandbox.donoQueue[0].id).toBe(1);
    expect(sandbox.donoQueue.some((e: Dono) => e.id === 21)).toBe(false);
  });

  test("D-nooverlap: kegagalan audience tidak menyentuh jalur donasi", async () => {
    const { sandbox, tick, get } = makeRuntime();
    sandbox.maybeRespond(chat(1, "rina", "x"));
    await tick();
    sandbox.llm[0].rej(new Error("audience mati"));  // audience gagal total
    await tick();
    expect(sandbox.donoQueue.length).toBe(0);
    expect(get("donoBusy")).toBe(false);
    sandbox.enqueueDonation(dono(2, "A", "a"));      // donasi tetap normal
    await tick();
    expect(sandbox.llm.length).toBe(2);
    sandbox.llm[1].res("");
  });
});

// ═══ WIRING / LIFECYCLE guards (sumber) ════════════════════════════════
describe("S3-A wiring & lifecycle", () => {
  test("poll memisahkan jalur: donation→enqueue, chat→maybeRespond", () => {
    expect(src).toMatch(/if \(ev\.type === "donation"\) \{[\s\S]{0,160}alert\(ev\);[\s\S]{0,160}enqueueDonation\(ev\);[\s\S]{0,160}\} else if \(ev\.type === "chat"\) \{[\s\S]{0,160}maybeRespond\(ev\);/);
    expect(src).not.toMatch(/"chat" \|\| ev\.type === "donation"\) maybeRespond/);
  });
  test("destroy() dan onStop() membungkam async + mengosongkan antrean", () => {
    const dest = src.slice(src.indexOf("return function destroy()"));
    expect(dest).toMatch(/gen\+\+;[\s\S]{0,140}donoQueue\.length = 0;/);
    const stop = src.slice(src.indexOf("const onStop = async"), src.indexOf("const onStop = async") + 520);
    expect(stop).toMatch(/gen\+\+;[\s\S]{0,140}donoQueue\.length = 0;/);
  });
  test("S3-A tidak menyentuh operator (O2 masih terbuka) & kanal ucap S1 tidak diubah", () => {
    expect(src).not.toMatch(/["']vtuber\/operator["']/);
    expect(src).toMatch(/__debugSpeak\(text, null, "vtuber\/audience"\)/); // speak() lama utuh
    expect(src).toMatch(/speakWait\(reply, "vtuber\/donation"\)/);          // via bridge S1 yang sama
  });
});
