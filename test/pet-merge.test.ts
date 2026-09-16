/**
 * pet-merge.test.ts — S2 Behavior Contract: PET THINKING MERGE (fold/re-issue).
 *
 * Kontrak: pesan user yang tiba saat PET sedang THINKING (request LLM aktif)
 * tidak boleh hilang — respons yang sedang berjalan digugarkan sebagai
 * jawaban final, dan SATU request penggantian membawa history gabungan
 * (A + B + C, urutan utuh). Model menafsir gabungan — TIDAK ada classifier.
 *
 * Beda CASE: saat SPEAKING (busy sudah false, rantai aktif) tetap PREEMPT
 * Phase 18 (R8) — buffer merge TIDAK boleh ikut campur di sana.
 *
 * Semua request dikontrol deferred promise (resolve/reject manual) — urutan
 * penyelesaian deterministik, bukan tebakan sleep. Hanya drain rantai
 * utterance memakai jeda kecil.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AgentBrain } from "../src/client/agent/brain";

const origWindow = (globalThis as any).window;
const origDocument = (globalThis as any).document;
const origFetch = (globalThis as any).fetch;
afterEach(() => {
  (globalThis as any).window = origWindow;
  (globalThis as any).document = origDocument;
  (globalThis as any).fetch = origFetch;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Req {
  url: string;
  body: any;
  signal?: AbortSignal;
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

function makeEnv() {
  const reqs: Req[] = [];
  const spoken: string[] = [];
  const chat: { role: string; text: string }[] = [];
  const engine = {
    // speak TIDAK auto-completing: rantai speech hidup sampai kita mau
    // (meniru TTS nyata; R8 butuh chain aktif yang stabil).
    speak: (t: string, cb?: () => void) => {
      spoken.push(t);
      (engine as any)._cb = cb;
    },
    finishSpeech: () => { const cb = (engine as any)._cb; (engine as any)._cb = null; if (cb) cb(); },
  };
  (globalThis as any).window = {
    __live2dAgent: {
      isReady: () => true,
      getExpressibleEmotions: () => ({ senang: "param", sedih: "param", malu: "param" }),
      setExpression: () => {}, setAIPose: () => {}, playMotion: () => true,
      playGesture: () => {}, speak: engine.speak,
      lockAI: () => {}, unlockAI: () => {}, stopSpeech: () => {}, setGazeIntent: () => {},
    },
    __addChat: (role: string, text: string) => chat.push({ role, text }),
    __appEvents: { idleSpeak: true, quietMs: 0 },
  };
  (globalThis as any).document = { getElementById: () => null };
  (globalThis as any).fetch = async (u: string, init?: any) => {
    const body = JSON.parse(init.body);
    return new Promise<any>((resolve, reject) => {
      reqs.push({ url: String(u), body, signal: init.signal, resolve, reject });
    });
  };
  const brain: any = new AgentBrain();
  brain.capProfile = {
    emotions: ["senang", "sedih", "malu", "normal"],
    nativeExpressions: [], accessories: [], properties: [],
    gestures: ["nod", "wave_hi", "look_away_shy", "think"],
    motionCatalog: [], sheet: { config: { displayName: "T" } }, userNote: "",
    roleIds: {}, paramRange: {}, modelName: "m",
    controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
  };
  const chatReqs = () => reqs.filter((r) => r.url.includes("/api/chat"));
  const dirReqs = () => reqs.filter((r) => r.url.includes("/api/animate-text"));
  const answer = (i: number, text: string) =>
    chatReqs()[i].resolve({ ok: true, json: async () => ({ reply: text }) });
  const fail = (i: number, msg = "provider mati") => chatReqs()[i].reject(new Error(msg));
  const texts = (i: number) => chatReqs()[i].body.messages.map((m: any) => m.content);
  const userSpoken = () => spoken.filter((t) => !t.includes("gak bisa mikir") && !t.includes("bingung"));
  return { brain, reqs, spoken, chat, engine, chatReqs, dirReqs, answer, fail, texts };
}

const R2REPLY = "[EMOTION:senang][GESTURE:nod] JAWABAN-A. [EMOTION:senang] ekor-a.";
const ABREPLY = "[EMOTION:senang][GESTURE:wave_hi] JAWABAN-AB. [EMOTION:senang] ekor-ab.";

describe("S2 PET MERGE — THINKING fold/re-issue", () => {
  test("R1: A saja → satu request, satu respons (regresi perilaku lama)", async () => {
    const E = makeEnv();
    const p = E.brain.think("halo A");
    await sleep(5);
    expect(E.chatReqs().length).toBe(1);
    E.answer(0, R2REPLY);
    await p;
    expect(E.spoken).toContain("JAWABAN-A.");
    expect(E.chatReqs().length).toBe(1); // tidak ada penggantian
  });

  test("R2: B tiba saat A thinking → respons A digugurkan, SATU request penggantian berisi A lalu B", async () => {
    const E = makeEnv();
    const pA = E.brain.think("A");
    await sleep(5);
    const pB = E.brain.think("B"); // merge, bukan drop, bukan request paralel
    await pB;
    expect(E.chatReqs().length).toBe(1);                      // tetap SATU request aktif
    expect(E.brain._reactiveState().pendingMergeCount).toBe(1);
    E.answer(0, R2REPLY);                                      // respons A tiba
    await sleep(5);                                            // pass penggantian berjalan; pA belum resolve
    expect(E.chatReqs().length).toBe(2);
    expect(E.texts(0)).toEqual(["A"]);
    expect(E.texts(1)).toEqual(["A", "B"]);                   // order utuh, tanpa duplikasi
    expect(E.spoken).not.toContain("JAWABAN-A.");             // A TIDAK pernah bersuara
    expect(E.chat.filter((c) => c.role === "agent").map((c) => c.text)).not.toContain("JAWABAN-A."); // UI tidak klaim
    E.answer(1, ABREPLY);
    await pA;
    expect(E.spoken).toContain("JAWABAN-AB.");                // hanya penggabungan yang bersuara
    expect(E.spoken.filter((t) => t === "JAWABAN-A.").length).toBe(0);
    expect(E.brain.busy).toBe(false);
    E.engine.finishSpeech(); await sleep(300);
  });

  test("R3/R7: A → B → C saat A thinking → satu penggantian berisi [A,B,C] berurutan", async () => {
    const E = makeEnv();
    const pA = E.brain.think("A");
    await sleep(5);
    await E.brain.think("B");
    await E.brain.think("C");
    expect(E.brain._reactiveState().pendingMergeCount).toBe(2);
    E.answer(0, R2REPLY);
    await sleep(5);
    expect(E.texts(1)).toEqual(["A", "B", "C"]);              // B sebelum C, tak ada duplikat
    expect(E.chatReqs().length).toBe(2);
    E.answer(1, ABREPLY);
    await pA;
    expect(E.spoken).toContain("JAWABAN-AB.");
    E.engine.finishSpeech(); await sleep(300);
  });

  test("R4: input tiba saat DIRECTOR pass (window resolved-yang-belum-bersuara) → masih THINKING → merge", async () => {
    const E = makeEnv();
    const pA = E.brain.think("A");
    await sleep(5);
    E.answer(0, "teks polos satu kalimat tanpa directive.");   // 1 segmen → director pass jalan
    await sleep(5);
    expect(E.dirReqs().length).toBe(1);                        // director sedang menggantung
    await E.brain.think("B");                                  // tiba di window director
    E.dirReqs()[0].resolve({ ok: true, json: async () => ({ segments: [] }) });
    await sleep(5);
    // CP-2 harus menahan utterance A (fallback segmen) dan mengganti:
    expect(E.chatReqs().length).toBe(2);
    expect(E.texts(1)).toEqual(["A", "B"]);
    expect(E.spoken.length).toBe(0);
    E.answer(1, ABREPLY);
    await pA;
    expect(E.spoken).toContain("JAWABAN-AB.");
    E.engine.finishSpeech(); await sleep(300);
  });

  test("R5: A GAGAL + B pending → B tetap dapat percobaan percakapan; fallback tepat satu di akhir", async () => {
    const E = makeEnv();
    const pA = E.brain.think("A");
    await sleep(5);
    await E.brain.think("B");
    E.fail(0);                                                 // provider error pass-1
    await sleep(5);
    expect(E.spoken.filter((t) => t.includes("gak bisa mikir")).length).toBe(0); // BULAN dulu fallback
    expect(E.chatReqs().length).toBe(2);                       // pass penggantian berjalan
    expect(E.texts(1)).toEqual(["A", "B"]);
    E.fail(1);                                                 // pass-2 juga gagal, tak ada pending
    await pA;
    expect(E.spoken.filter((t) => t.includes("gak bisa mikir")).length).toBe(1); // tepat satu
    expect(E.brain.busy).toBe(false);
  });

  test("R6: model switch saat A thinking + B pending → siklus basi diam, tanpa penggantian lintas model; B bertahan di history", async () => {
    const E = makeEnv();
    const pA = E.brain.think("A");
    await sleep(5);
    await E.brain.think("B");
    E.brain.invalidateCapabilityProfile();                     // switch → gen++ + abort
    E.chatReqs()[0].resolve({ ok: true, json: async () => ({ reply: R2REPLY }) }); // provider basi, abaikan signal
    await pA;
    await sleep(30);
    expect(E.chatReqs().length).toBe(1);                       // TIDAK ada pass penggantian lintas model
    expect(E.spoken.length).toBe(0);                           // diam tanpa fallback
    expect(E.brain._reactiveState().pendingMergeCount).toBe(0);
    const hist = E.brain.history.map((m: any) => m.content);
    expect(hist).toContain("A");
    expect(hist).toContain("B");                               // pesan tidak hilang dari konteks
    expect(E.brain.busy).toBe(false);
  });

  test("R8: SPEAKING + B → PREEMPT (bukan merge): buffer kosong, rantai lama mati, B dijawab langsung", async () => {
    const E = makeEnv();
    const pA = E.brain.think("A");
    await sleep(5);
    E.answer(0, R2REPLY);
    await pA;                                                  // chain bicara seg-1 (speak stub pending)
    expect(E.spoken).toContain("JAWABAN-A.");
    expect(E.brain.busy).toBe(false);
    expect(E.brain._reactiveState().utteranceActive).toBe(true); // rantai A HIDUP (CASE 2)
    const pB = E.brain.think("B");
    expect(E.brain._reactiveState().pendingMergeCount).toBe(0);  // TIDAK lewat buffer merge
    await sleep(5);
    expect(E.chatReqs().length).toBe(2);                         // request B langsung jalan + preempt
    E.engine.finishSpeech();                                     // cb basi rantai A → tak boleh lanjut
    await sleep(300);
    expect(E.spoken.filter((t) => t === "ekor-a.").length).toBe(0); // segmen A kedua TIDAK pernah
    E.answer(1, ABREPLY);
    await pB;
    expect(E.spoken).toContain("JAWABAN-AB.");
    E.engine.finishSpeech(); await sleep(300);
  });

  test("reactEvent: input user menunggu saat proaktif thinking → proaktif mengalah, loop user mengambil alih", async () => {
    const E = makeEnv();
    const pE = E.brain.reactEvent("idle");
    await sleep(5);
    expect(E.chatReqs().length).toBe(1);
    await E.brain.think("B");                                  // busy oleh proaktif → buffer
    expect(E.brain._reactiveState().pendingMergeCount).toBe(1);
    E.answer(0, R2REPLY);                                      // balasan proaktif tiba
    await pE;
    expect(E.spoken.length).toBe(0);                           // proaktif TIDAK bersuara
    expect(E.brain._reactiveState().lastProactiveAction).toBeNull(); // tak dicatat (tidak dieksekusi)
    await sleep(5);                                            // flush folded think (setTimeout 0)
    expect(E.chatReqs().length).toBe(2);                       // user loop mengambil alih
    expect(E.texts(1)).toContain("B");
    E.answer(1, ABREPLY);
    await sleep(5);
    expect(E.spoken).toContain("JAWABAN-AB.");
    E.engine.finishSpeech(); await sleep(300);
  });

  test("flush think('') tidak menambah entri history kosong", async () => {
    const E = makeEnv();
    const pE = E.brain.reactEvent("idle");
    await sleep(5);
    await E.brain.think("B");
    E.answer(0, R2REPLY);
    await pE;
    await sleep(5);
    const users = E.brain.history.filter((m: any) => m.role === "user").map((m: any) => m.content);
    E.answer(1, ABREPLY);
    await sleep(5);
    const users2 = E.brain.history.filter((m: any) => m.role === "user").map((m: any) => m.content);
    expect(users).toEqual(["B"]);
    expect(users2).toEqual(["B"]);                             // tanpa duplikat/entri kosong
    E.engine.finishSpeech(); await sleep(300);
  });

  test("invarian konkurensi: tidak pernah ada dua request thinking paralel (R2/R3/R5 beruntun)", async () => {
    const E = makeEnv();
    let inFlight = 0, max = 0;
    const origFetchCall = (globalThis as any).fetch;
    (globalThis as any).fetch = (u: string, init: any) => {
      inFlight++; max = Math.max(max, inFlight);
      return origFetchCall(u, init).then((r: any) => { inFlight--; return r; })
        .catch((e: any) => { inFlight--; throw e; });
    };
    const pA = E.brain.think("A");
    await sleep(5);
    await E.brain.think("B");
    await E.brain.think("C");
    E.answer(0, R2REPLY);
    await sleep(5);                                            // pass-2 berjalan; cek puncak in-flight
    expect(max).toBe(1);                                       // SATU thinking request pada satu waktu
    expect(E.chatReqs().length).toBe(2);
    E.answer(1, ABREPLY);
    await pA;
    E.engine.finishSpeech(); await sleep(300);
    expect(E.brain.busy).toBe(false);
  });
});
