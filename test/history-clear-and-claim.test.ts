/**
 * history-clear-and-claim.test.ts — dua targeted correctness fix pasca
 * audit policy (bukan fase; TANPA mengubah kebijakan pesan-konkuren):
 *
 * BUG 1 — Clear chat: handler app.js me-reassign `window.__agent.history = []`
 *   padahal facade adalah REFERENSI SHARED ke array hidup brain ("Array
 *   HIDUP", brain.ts:146) → UI kosong, brain.history tetap terkirim ke LLM.
 *   FIX: bersihkan IN-PLACE (length = 0). Test menjalankan statement HANDLER
 *   ASLI dari app.js via vm, lalu membuktikan payload request berikutnya
 *   hanya berisi pesan baru lewat AgentBrain nyata.
 *
 * BUG 2 — Race klaim-awal: `busy` diset SETELAH `await loadProfile()`;
 *   dua think() beruntun saat capProfile null lolos cek-busy bersamaan →
 *   dua request LLM paralel + _beginRequest() kedua men-null-kan
 *   timer/controller klaim pertama (request 1 kehilangan timeout).
 *   FIX: klaim sinkron (busy + snapshot _reqGen) sebelum await pertama +
 *   outer-finally safety-net. Kebijakan silent-drop pesan KE-DUA tidak
 *   berubah — yang berubah hanya bahwa ownership kini atomik.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { AgentBrain } from "../src/client/agent/brain";

const repoRoot = resolve(import.meta.dir, "..");
const appSrc = readFileSync(join(repoRoot, "static", "js", "app.js"), "utf8");
const brainSrc = readFileSync(join(repoRoot, "src", "client", "agent", "brain.ts"), "utf8");

const origWindow = (globalThis as any).window;
const origDocument = (globalThis as any).document;
const origFetch = (globalThis as any).fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => {
  (globalThis as any).window = origWindow;
  (globalThis as any).document = origDocument;
  (globalThis as any).fetch = origFetch;
  AgentBrain.LLM_REQUEST_TIMEOUT_MS = 90_000;
});

const PROFILE: any = {
  emotions: ["senang", "sedih", "normal"],
  nativeExpressions: [],
  accessories: [],
  properties: [],
  gestures: ["nod", "wave_hi"],
  motionCatalog: [],
  sheet: { config: { displayName: "T" } },
  userNote: "",
  roleIds: {},
  paramRange: {},
  modelName: "m",
  controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
};

// ═══════════════════════════════════════════════════════════════════════
// BUG 1 — clear chat
// ═══════════════════════════════════════════════════════════════════════
describe("Fix-1 clear chat membersihkan array HIDUP brain (bukan rebind facade)", () => {
  /** Ambil statement handler ASLI dari app.js: blok `if (window.__agent) { ... __agent.history ... }`. */
  function extractClearHandler(): string {
    const m = appSrc.match(/if \(window\.__agent\) \{[^{}]*__agent\.history[^{}]*\}/);
    expect(m).toBeTruthy();
    return m![0];
  }

  test("sumber: tidak ada lagi rebind `__agent.history = []`", () => {
    expect(appSrc).not.toMatch(/__agent\.history\s*=\s*\[\]/);
    // kontrak facade: history diekspos BY REFERENCE ke array hidup brain
    expect(brainSrc).toMatch(/history: brain\.history,/);
  });

  test("handler asli mengosongkan array brain IN-PLACE; referensi tetap identik", () => {
    const stmt = extractClearHandler();
    const brain: any = new AgentBrain();
    brain.history.push(
      { role: "user", content: "lama-1" },
      { role: "user", content: "lama-2" },
    );
    // facade persis seperti dipasang brain.ts: properti `history` = array hidup.
    // Handler app.js membaca `window.__agent.history` — jadi ctx.window adalah
    // objek yang MEMUAT __agent, bukan facadenya langsung.
    const facade: any = { history: brain.history };
    const ctx: any = { window: { __agent: facade }, Array };
    vm.createContext(ctx);
    vm.runInContext(stmt, ctx);

    expect(brain.history.length).toBe(0);
    expect(facade.history.length).toBe(0);
    expect(facade.history).toBe(brain.history); // invariant referensi SHARED utuh
  });

  test("end-to-end: habis clear, payload think() berikutnya hanya pesan baru", async () => {
    const stmt = extractClearHandler();
    const brain: any = new AgentBrain();
    const facade: any = { history: brain.history };
    (globalThis as any).window = {
      __live2dAgent: {
        isReady: () => true,
        getExpressibleEmotions: () => ({}),
        setExpression: () => {}, setAIPose: () => {}, playMotion: () => true,
        playGesture: () => {}, speak: () => {}, lockAI: () => {}, unlockAI: () => {},
        setGazeIntent: () => {},
      },
      __addChat: () => {},
    };
    (globalThis as any).document = { getElementById: () => null };
    const clearCtx: any = { window: { __agent: facade }, Array };
    vm.createContext(clearCtx);

    // stub fetch SEBELUM think apa pun (jangan pernah sentuh jaringan asli)
    const payloads: any[] = [];
    (globalThis as any).fetch = async (_u: string, init?: any) => {
      payloads.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ reply: "[EMOTION:senang][GESTURE:nod] Lama. [EMOTION:senang] Lanjut lama." }) };
    };
    brain.capProfile = PROFILE;
    await brain.think("pesan lama satu");
    await brain.think("pesan lama dua");
    expect(brain.history.length).toBe(2);

    vm.runInContext(stmt, clearCtx);
    expect(brain.history.length).toBe(0);

    payloads.length = 0;
    (globalThis as any).fetch = async (_u: string, init?: any) => {
      payloads.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ reply: "[EMOTION:senang][GESTURE:nod] Baru. [EMOTION:senang] Lanjutan." }) };
    };
    await brain.think("pesan baru");
    const msgs = payloads[0].messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("pesan baru"); // tidak ada sisa lama yang ikut terkirim
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 2 — first-request claim race
// ═══════════════════════════════════════════════════════════════════════
interface Env {
  brain: any;
  spoken: string[];
  chatCalls: { signal?: AbortSignal; body: any }[];
  begins: number;
  resolveProfile: () => void;
  setChat: (fn: (body: any, signal?: AbortSignal) => Promise<any>) => void;
}
function makeEnv(): Env {
  let resolveProfile!: () => void;
  const profilePromise = new Promise<any>((res) => { resolveProfile = () => res(PROFILE); });
  const spoken: string[] = [];
  const chatCalls: Env["chatCalls"] = [];
  let chatFn: (body: any, signal?: AbortSignal) => Promise<any> = async () => ({
    ok: true,
    json: async () => ({ reply: "[EMOTION:senang][GESTURE:nod] balas. [EMOTION:senang] lanjut." }),
  });
  (globalThis as any).window = {
    __live2dAgent: {
      isReady: () => true,
      getCapabilityProfile: () => profilePromise,
      getExpressibleEmotions: () => ({}),
      setExpression: () => {}, setAIPose: () => {}, playMotion: () => true,
      playGesture: () => {}, speak: (t: string, cb?: () => void) => {
        spoken.push(t);
        if (cb) setTimeout(cb, 0); // engine nyata: utterance SELESAI → onDone
      },
      lockAI: () => {}, unlockAI: () => {}, stopSpeech: () => {}, setGazeIntent: () => {},
    },
    __addChat: () => {},
  };
  (globalThis as any).document = { getElementById: () => null };
  (globalThis as any).fetch = async (u: string, init?: any) => {
    const body = JSON.parse(init.body);
    chatCalls.push({ signal: init.signal, body });
    return chatFn(body, init.signal);
  };
  const brain: any = new AgentBrain(); // capProfile sengaja null → jalurnya loadProfile await
  const env: Env = {
    brain, spoken, chatCalls, begins: 0, resolveProfile,
    setChat(fn) { chatFn = fn; },
  };
  const origBegin = brain._beginRequest.bind(brain);
  brain._beginRequest = (...a: any[]) => { env.begins++; return origBegin(...a); };
  return env;
}

describe("Fix-2 klaim request atomik sebelum await pertama (race first-request)", () => {
  test("B1: dua think() beruntun saat profil belum ada → HANYA satu request masuk lifecycle", async () => {
    const E = makeEnv();
    const pA = E.brain.think("A");
    // klaim HARUS sudah berlaku sebelum await berikutnya — cek sinkron:
    expect(E.brain.busy).toBe(true);
    const pB = E.brain.think("B"); // harus silent-drop (kebijakan lama, tak berubah)
    E.resolveProfile();
    await Promise.all([pA, pB]);
    expect(E.begins).toBe(1);                    // tak ada _beginRequest kedua
    expect(E.chatCalls.length).toBe(1);          // tak ada dua request LLM paralel
    expect(E.chatCalls[0].body.messages.length).toBe(1); // hanya A di payload
    expect(E.chatCalls[0].body.messages[0].content).toBe("A");
    expect(E.spoken.filter((t) => t === "balas.").length).toBe(1); // satu balasan, tak dobel
    expect(E.brain.busy).toBe(false);
    expect(E.brain._reqCtrl).toBeNull();         // tak ada timer/controller tercuri tersisa
    expect(E.brain._reqTimer).toBeNull();
    await sleep(600); // drain rantai utterance (semua segmen selesai via cb + jeda 180ms)
    expect(E.brain._reactiveState().utteranceActive).toBe(false); // tak ada lock playback bocor
  });

  test("B2: think() lalu reactEvent() beruntun saat profil belum ada → satu request", async () => {
    const E = makeEnv();
    const pA = E.brain.think("A");
    const pE = E.brain.reactEvent("idle");
    E.resolveProfile();
    await Promise.all([pA, pE]);
    expect(E.begins).toBe(1);
    expect(E.chatCalls.length).toBe(1);
    expect(E.brain.busy).toBe(false);
    await sleep(600); // drain rantai utterance sebelum afterEach mencabut window
  });

  test("B3: timeout bookkeeping milik request AKTIF — signal fetch == controller aktif", async () => {
    const E = makeEnv();
    let seenSignal: AbortSignal | undefined;
    E.setChat(async (_b, sig) => {
      seenSignal = sig;
      return new Promise((_res, rej) => {
        sig!.addEventListener("abort", () => {
          const e: any = new Error("aborted"); e.name = "AbortError"; rej(e);
        });
      });
    });
    const origTimeout = AgentBrain.LLM_REQUEST_TIMEOUT_MS;
    AgentBrain.LLM_REQUEST_TIMEOUT_MS = 40;
    try {
      const pA = E.brain.think("A");
      const pB = E.brain.think("B");
      E.resolveProfile();
      await Promise.all([pA, pB]);
      expect(E.chatCalls.length).toBe(1);
      expect(seenSignal).toBeDefined();
      expect(seenSignal!.aborted).toBe(true);     // yang di-abort justru yang AKTIF (bukan warisan)
      expect(E.brain._reqCtrl).toBeNull();        // dan dibersihkan rapi
      expect(E.brain._reqTimer).toBeNull();
      expect(E.spoken.filter((t) => String(t).includes("gak bisa mikir")).length).toBe(1);
      expect(E.brain.busy).toBe(false);
    } finally {
      AgentBrain.LLM_REQUEST_TIMEOUT_MS = origTimeout;
    }
  });

  test("B4: provider error pada first-request → satu fallback, busy lepas, request berikutnya normal", async () => {
    const E = makeEnv();
    E.setChat(async () => ({ ok: false, json: async () => ({ error: "provider mati" }) }));
    const p = E.brain.think("A");
    E.resolveProfile();
    await p;
    expect(E.spoken.filter((t) => String(t).includes("gak bisa mikir")).length).toBe(1);
    expect(E.brain.busy).toBe(false);
    // request berikutnya tetap jalan normal (state pulih penuh)
    E.setChat(async () => ({ ok: true, json: async () => ({ reply: "[EMOTION:senang] pulih. [EMOTION:senang] ya." }) }));
    await E.brain.think("B");
    expect(E.spoken).toContain("pulih.");
    expect(E.begins).toBe(2);
    await sleep(600); // drain rantai terakhir sebelum teardown window
  });

  test("B5: model switch SAAT loadProfile → request dibuang sebelum mulai; pesan user tercatat; model baru bisa jawab", async () => {
    const E = makeEnv();
    const p = E.brain.think("A");
    E.brain.invalidateCapabilityProfile();          // switch terjadi SELAMA await profil
    E.resolveProfile();                             // profil (model lama) baru tiba belakangan
    await p;
    expect(E.chatCalls.length).toBe(0);             // tidak ada request dengan profil basi
    expect(E.spoken.length).toBe(0);
    expect(E.brain.busy).toBe(false);               // outer finally menjamin klaim lepas
    expect(E.brain.history.some((m: any) => m.content === "A")).toBe(true); // identik semantik abort P16
    // model baru (profil diset langsung) tetap bisa dipakai
    E.brain.capProfile = PROFILE;
    await E.brain.think("B");
    expect(E.chatCalls.length).toBe(1);
    expect(E.brain.busy).toBe(false);
    await sleep(600); // drain rantai B sebelum teardown window
  });

  test("B6: kontinuaasi LAMBAT yang resolve setelah switch tidak boleh bicara (stale, first-request path)", async () => {
    const E = makeEnv();
    let lateResolve!: (r: any) => void;
    E.setChat(() => new Promise((res) => { lateResolve = res; })); // provider MENGABAIKAN signal
    const p = E.brain.think("A");
    E.resolveProfile();
    await new Promise((r) => setTimeout(r, 0));      // request mulai & menggantung
    expect(E.chatCalls.length).toBe(1);
    E.brain.invalidateCapabilityProfile();           // switch → abort + gen++
    lateResolve({ ok: true, json: async () => ({ reply: "[EMOTION:senang][GESTURE:nod] TERLAMBAT. [EMOTION:senang] x." }) });
    await p;
    expect(E.spoken.filter((t) => t.includes("TERLAMBAT")).length).toBe(0);
    expect(E.brain.busy).toBe(false);
    expect(E.brain._reactiveState().utteranceActive).toBe(false);
  });

  test("B7: sekuensial normal tetap jalan pasca race (regresi happy path)", async () => {
    const E = makeEnv();
    const p = E.brain.think("satu");
    E.resolveProfile();
    await p;
    expect(E.begins).toBe(1);
    await E.brain.think("dua");   // profil sudah ada → tanpa window race
    expect(E.begins).toBe(2);
    expect(E.chatCalls.length).toBe(2);
    expect(E.brain.busy).toBe(false);
    await sleep(600); // drain rantai terakhir sebelum teardown window
  });
});
