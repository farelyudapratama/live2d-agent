/**
 * request-lifecycle.test.ts — Phase 16: Agent Request Lifecycle Resilience.
 *
 * Mengunci jaminan: request LLM di AgentBrain tidak bisa membuat agent macet
 * permanen. Timeout AbortController membatasi umur fetch klien→server; model
 * switch membatalkan request aktif; hasil basi (resolve setelah abort) tidak
 * pernah dieksekusi. Semua jalur terminal melepas busy + setThinking +
 * controller + timer.
 *
 * Yang dikunci (nomor T = checklist Phase 16):
 *   T1  think() sukses berjalan persis seperti sebelumnya
 *   T2  fetch tak pernah settle → timeout memicu
 *   T3  timeout meng-abort signal fetch
 *   T4  timeout melepas busy
 *   T5  timeout menyelesaikan setThinking(false)
 *   T6  timeout membersihkan controller + timer
 *   T7  timeout menghasilkan TEPAT SATU fallback
 *   T8  think() kedua langsung setelah timeout berhasil (recovery penuh)
 *   T9  network error melepas lifecycle
 *   T10 HTTP error melepas lifecycle
 *   T11 reactEvent() timeout melepas lifecycle
 *   T12 reactEvent() timeout membersihkan diversity hint
 *   T13 reactEvent() timeout TIDAK mencatat proactive action palsu
 *   T14 reactEvent() sukses tetap mencatat aksi P15.5
 *   T15 model switch meng-abort request aktif (tanpa fallback)
 *   T16 hasil yang resolve setelah abort TIDAK memainkan segmen basi
 *   T17 request model A tidak boleh memengaruhi model B
 *   T18 tidak ada fallback ganda
 *   T19 tidak ada eksekusi aksi ganda
 *   T20 concurrency: guard busy think(A)+think(B) tetap seperti sebelumnya
 *   T21 konteks Speaker P15.1 tetap utuh
 *   T22 diversity hint P15.2 tetap cakup request proaktif saja
 *   T23 konteks Director P15.3 tetap utuh
 *   T24 expression hint P15.4 tetap utuh
 *   T25 tidak ada dependensi baru ke renderer/Arbiter/MotionRuntime di brain
 *
 * Timeout dipendekkan lewat AgentBrain.LLM_REQUEST_TIMEOUT_MS (dipulihkan
 * setiap test). "Never-resolving" di sini berarti nyata: promise hanya settle
 * saat signal abort — persis perilaku fetch browser asli terhadap sinyal.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { AgentBrain } from "../src/client/agent/brain";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const origWindow = (globalThis as any).window;
const origDocument = (globalThis as any).document;
const origFetch = (globalThis as any).fetch;

const TIMEOUT_MS = 40;
const DEFAULT_TIMEOUT_MS = AgentBrain.LLM_REQUEST_TIMEOUT_MS;

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

// Fake agent engine — speak TIDAK memanggil callback onDone sehingga hanya
// segmen pertama yang main (sinkron, tanpa timer tertinggal).
function makeFakeAgent() {
  const calls = {
    speak: [] as string[],
    playGesture: [] as string[],
    playMotion: [] as any[],
    setExpression: [] as any[],
    addChat: [] as any[],
  };
  const agent: any = {
    isReady: () => true,
    getExpressibleEmotions: () => ({
      senang: "param", tersenyum: "param", sedih: "param", malu: "param",
      kaget: "param", kesal: "param", bingung: "param", normal: "param",
    }),
    setExpression: (e: any) => calls.setExpression.push(e),
    setAIPose: () => {},
    playMotion: (id: any) => { calls.playMotion.push(id); return true; },
    playGesture: (g: any) => calls.playGesture.push(g),
    speak: (t: string) => { calls.speak.push(t); },
    lockAI: () => {},
    unlockAI: () => {},
    setGazeIntent: () => {},
  };
  return { agent, calls };
}

const PROFILE: any = {
  emotions: ["senang", "tersenyum", "sedih", "malu", "kaget", "kesal", "bingung", "normal"],
  nativeExpressions: ["exp_angry", "exp_01"],
  accessories: [],
  properties: [],
  gestures: ["nod", "shake", "tilt_curious", "lean_excited", "recoil_surprised", "look_away_shy", "laugh_bounce", "think", "wave_hi"],
  motionCatalog: [],
  sheet: { config: { displayName: "TestChar" } },
  userNote: "Karakter ceria",
  roleIds: {},
  paramRange: {},
  modelName: "test-model",
  controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
};

interface FetchCall {
  url: string;
  body: any;
  signal?: AbortSignal;
}

/** setup(): brain + fake agent + capture fetch. `thinkingEl` fake untuk T5. */
function setup(opts: { thinkingEl?: boolean } = {}) {
  const { agent, calls } = makeFakeAgent();
  const fakeWindow: any = {
    __live2dAgent: agent,
    __addChat: (role: string, text: string) => calls.addChat.push({ role, text }),
    __appEvents: { idleSpeak: true, quietMs: 0 },
  };
  (globalThis as any).window = fakeWindow;
  let hiddenToggles: boolean[] = [];
  if (opts.thinkingEl) {
    const el: any = {
      dataset: {},
      textContent: "Mikir...",
      getAttribute: () => null,
      removeAttribute: () => {},
      classList: {
        toggle(_cls: string, force: boolean) { hiddenToggles.push(force); },
      },
    };
    (globalThis as any).document = { getElementById: () => el };
  } else {
    (globalThis as any).document = { getElementById: () => null };
  }
  const fetchCalls: FetchCall[] = [];
  AgentBrain.LLM_REQUEST_TIMEOUT_MS = TIMEOUT_MS;
  const brain: any = new AgentBrain();
  brain.capProfile = PROFILE;
  return {
    brain, agent, calls, fetchCalls,
    thinkingHidden: () => hiddenToggles,
    restore() {
      (globalThis as any).window = origWindow;
      (globalThis as any).document = origDocument;
      (globalThis as any).fetch = origFetch;
      AgentBrain.LLM_REQUEST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
    },
  };
}

/** fetch yang TIDAK PERNAH settle sendiri — hanya reject saat signal abort.
 *  Persis fetch browser: tanpa abort, request menggantung selamanya. */
function installHangingFetch(ctx: ReturnType<typeof setup>) {
  (globalThis as any).fetch = async (url: string, init?: any) => {
    ctx.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, signal: init?.signal });
    return new Promise((_resolve, reject) => {
      const sig: AbortSignal | undefined = init?.signal;
      if (sig) {
        if (sig.aborted) return reject(abortError());
        sig.addEventListener("abort", () => reject(abortError()));
      }
      // tanpa abort: tidak pernah resolve → hanya timeout yang menyelamatkan
    });
  };
}

/** fetch yang MENGABAIKAN signal lalu resolve dengan reply — mensimulasikan
 *  provider/mock yang tetap resolve setelah abort (jalur proteksi basi). */
function installResolveAfterAbortFetch(ctx: ReturnType<typeof setup>, reply: string, delayMs: number) {
  (globalThis as any).fetch = async (url: string, init?: any) => {
    ctx.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, signal: init?.signal });
    await sleep(delayMs);
    return { ok: true, status: 200, json: async () => ({ reply }) };
  };
}

function installOkFetch(ctx: ReturnType<typeof setup>, reply: string) {
  (globalThis as any).fetch = async (url: string, init?: any) => {
    ctx.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, signal: init?.signal });
    return { ok: true, status: 200, json: async () => ({ reply }) };
  };
}

afterEach(() => {
  (globalThis as any).window = origWindow;
  (globalThis as any).document = origDocument;
  (globalThis as any).fetch = origFetch;
  AgentBrain.LLM_REQUEST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
});

// ═══════════════════════════════════════════════════════════════════════
// T1: happy path tidak berubah
// ═══════════════════════════════════════════════════════════════════════
describe("P16 T1 — think() sukses berjalan persis seperti sebelumnya", () => {
  test("reply berdirective → main + lifecycle bersih, tanpa fallback", async () => {
    const ctx = setup();
    try {
      // Multi-segment: reply 1 segmen secara by-design lewat director pass
      // (perilaku lama), jadi happy path directive murni pakai 2 segmen.
      installOkFetch(ctx, "[EMOTION:senang][GESTURE:nod] Halo! [EMOTION:senang][GESTURE:nod] hai lagi.");
      await ctx.brain.think("hai");
      expect(ctx.calls.playGesture).toEqual(["nod"]);
      expect(ctx.calls.speak.length).toBe(1);
      expect(ctx.calls.speak[0]).toBe("Halo!");
      // Bukan fallback
      expect(ctx.calls.speak.join()).not.toContain("gak bisa mikir");
      expect(ctx.brain.busy).toBe(false);
      expect(ctx.brain._reqCtrl).toBeNull();
      expect(ctx.brain._reqTimer).toBeNull();
      // fetch memang membawa signal (request terikat controller)
      expect(ctx.fetchCalls[0].signal).toBeInstanceOf(AbortSignal);
      expect(ctx.fetchCalls[0].signal!.aborted).toBe(false);
    } finally { ctx.restore(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T2–T7 + T18: never-resolving fetch → timeout → abort → cleanup → 1 fallback
// ═══════════════════════════════════════════════════════════════════════
describe("P16 T2-T7/T18 — fetch tak settle: timeout, abort, cleanup, fallback tunggal", () => {
  test("T2+T3: request menggantung, lalu signal ter-abort oleh timeout", async () => {
    const ctx = setup();
    try {
      installHangingFetch(ctx);
      await ctx.brain.think("hai"); // settle HANYA karena timeout meng-abort
      expect(ctx.fetchCalls.length).toBe(1);
      expect(ctx.fetchCalls[0].signal!.aborted).toBe(true);
    } finally { ctx.restore(); }
  });

  test("T4+T5: timeout melepas busy dan menyelesaikan setThinking(false)", async () => {
    const ctx = setup({ thinkingEl: true });
    try {
      installHangingFetch(ctx);
      await ctx.brain.think("hai");
      expect(ctx.brain.busy).toBe(false);
      const toggles = ctx.thinkingHidden();
      expect(toggles.length).toBeGreaterThanOrEqual(2);
      expect(toggles[0]).toBe(false); // setThinking(true) → hidden=false
      expect(toggles[toggles.length - 1]).toBe(true); // setThinking(false) → hidden=true
    } finally { ctx.restore(); }
  });

  test("T6: timeout membersihkan controller + timer (tidak ada yang tertinggal)", async () => {
    const ctx = setup();
    try {
      installHangingFetch(ctx);
      await ctx.brain.think("hai");
      expect(ctx.brain._reqCtrl).toBeNull();
      expect(ctx.brain._reqTimer).toBeNull();
      expect(ctx.brain._reactiveState().activeRequest).toBe(false);
    } finally { ctx.restore(); }
  });

  test("T7+T18: timeout menghasilkan TEPAT SATU fallback, tanpa dobel", async () => {
    const ctx = setup();
    try {
      installHangingFetch(ctx);
      await ctx.brain.think("hai");
      const fallbacks = ctx.calls.speak.filter((t) => t.includes("gak bisa mikir"));
      expect(fallbacks.length).toBe(1);
      const chatFallbacks = ctx.calls.addChat.filter((c) => String(c.text).includes("gak bisa mikir"));
      expect(chatFallbacks.length).toBe(1);
      expect(ctx.calls.speak.length).toBe(1);
    } finally { ctx.restore(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T8: pemulihan inti — timeout → cleanup → think() berikutnya SUKSES
// ═══════════════════════════════════════════════════════════════════════
describe("P16 T8 — recovery: think() kedua langsung setelah timeout berhasil", () => {
  test("timeout → busy lepas → think() berikutnya menjawab normal", async () => {
    const ctx = setup();
    try {
      installHangingFetch(ctx);
      await ctx.brain.think("pertama"); // timeout + fallback
      expect(ctx.brain.busy).toBe(false);
      // kini fetch normal lagi
      installOkFetch(ctx, "[EMOTION:senang][GESTURE:wave_hi] Hai lagi!");
      await ctx.brain.think("kedua");
      expect(ctx.calls.playGesture).toEqual(["wave_hi"]);
      expect(ctx.calls.speak).toContain("Hai lagi!");
      expect(ctx.calls.speak.filter((t) => t.includes("gak bisa mikir")).length).toBe(1);
    } finally { ctx.restore(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T9/T10: network error & HTTP error melepas lifecycle
// ═══════════════════════════════════════════════════════════════════════
describe("P16 T9/T10 — network error dan HTTP error melepas lifecycle", () => {
  test("network error (reject) → fallback satu, busy lepas, controller nol", async () => {
    const ctx = setup();
    try {
      (globalThis as any).fetch = async (url: string, init?: any) => {
        ctx.fetchCalls.push({ url: String(url), body: null, signal: init?.signal });
        throw new TypeError("Failed to fetch");
      };
      await ctx.brain.think("hai");
      expect(ctx.calls.speak.filter((t) => t.includes("gak bisa mikir")).length).toBe(1);
      expect(ctx.brain.busy).toBe(false);
      expect(ctx.brain._reqCtrl).toBeNull();
      expect(ctx.brain._reqTimer).toBeNull();
    } finally { ctx.restore(); }
  });

  test("HTTP error (!ok) → fallback satu, busy lepas, controller nol", async () => {
    const ctx = setup();
    try {
      (globalThis as any).fetch = async (url: string, init?: any) => {
        ctx.fetchCalls.push({ url: String(url), body: null, signal: init?.signal });
        return { ok: false, status: 502, json: async () => ({ error: "upstream down" }) };
      };
      await ctx.brain.think("hai");
      expect(ctx.calls.speak.filter((t) => t.includes("gak bisa mikir")).length).toBe(1);
      expect(ctx.brain.busy).toBe(false);
      expect(ctx.brain._reqCtrl).toBeNull();
      expect(ctx.brain._reqTimer).toBeNull();
    } finally { ctx.restore(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T11–T14: reactEvent()
// ═══════════════════════════════════════════════════════════════════════
describe("P16 T11-T13 — reactEvent() timeout melepas lifecycle + state P15.2/P15.5", () => {
  test("timeout melepas busy/controller/timer, dan diversity hint dibersihkan", async () => {
    const ctx = setup();
    try {
      installHangingFetch(ctx);
      ctx.brain._diversityHistory.set("idle", ["senang+nod"]);
      await ctx.brain.reactEvent("idle");
      expect(ctx.brain.busy).toBe(false);
      expect(ctx.brain._reqCtrl).toBeNull();
      expect(ctx.brain._reqTimer).toBeNull();
      // T12: hint TETAP dibersihkan walau request timeout
      expect(ctx.brain._diversityHint).toBe("");
      // T13: TIDAK ada proactive action palsu (baik bridge P15.5 maupun
      // record P15.2) — hanya yang benar-benar dieksekusi boleh tercatat.
      expect(ctx.brain._lastProactiveAction).toBeNull();
      expect(ctx.brain._diversityHistory.get("idle")).toEqual(["senang+nod"]);
      // Tidak ada eksekusi apa pun
      expect(ctx.calls.speak.length).toBe(0);
      expect(ctx.calls.playGesture.length).toBe(0);
    } finally { ctx.restore(); }
  });

  test("T14: reactEvent() SUKSES tetap mencatat aksi P15.5 + history P15.2", async () => {
    const ctx = setup();
    try {
      installOkFetch(ctx, "[EMOTION:sedih][GESTURE:look_away_shy] Kok sepi... [EMOTION:sedih][GESTURE:tilt_curious] Kamu ke mana?");
      await ctx.brain.reactEvent("idle");
      expect(ctx.brain._lastProactiveAction).toBe("sedih + look_away_shy");
      expect(ctx.brain._diversityHistory.get("idle")).toEqual(["sedih+look_away_shy", "sedih+tilt_curious"]);
      expect(ctx.brain._diversityHint).toBe("");
      expect(ctx.brain.busy).toBe(false);
    } finally { ctx.restore(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T15–T17: model switch / hasil basi
// ═══════════════════════════════════════════════════════════════════════
describe("P16 T15-T17 — model switch membatalkan, hasil basi tidak dieksekusi", () => {
  test("T15: invalidateCapabilityProfile() meng-abort request aktif (tanpa fallback)", async () => {
    const ctx = setup();
    try {
      installHangingFetch(ctx);
      const p = ctx.brain.think("hai");
      await sleep(5); // fetch sudah dimulai (signal sudah direkam mock)
      ctx.brain.invalidateCapabilityProfile();
      await p; // reject AbortError → catch → silent (bukan timeout murni)
      expect(ctx.fetchCalls[0].signal!.aborted).toBe(true);
      // Pembatalan sadar = TIDAK ada fallback chat
      expect(ctx.calls.speak.length).toBe(0);
      expect(ctx.brain.busy).toBe(false);
      expect(ctx.brain._reqCtrl).toBeNull();
      expect(ctx.brain._reqTimer).toBeNull();
    } finally { ctx.restore(); }
  });

  test("T16: hasil yang resolve SETELAH abort tidak memainkan segmen basi", async () => {
    const ctx = setup();
    try {
      // mock mengabaikan signal → resolve terlambat dengan reply penuh directive
      installResolveAfterAbortFetch(ctx, "[EMOTION:senang][GESTURE:wave_hi] TERLAMBAT", 25);
      const p = ctx.brain.think("hai");
      await sleep(5);
      ctx.brain.invalidateCapabilityProfile(); // abort + naikkan generasi
      await p;
      expect(ctx.fetchCalls[0].signal!.aborted).toBe(true);
      // Hasil basi dibuang: tidak ada aksi, tidak ada fallback, tidak ada speak
      expect(ctx.calls.playGesture.length).toBe(0);
      expect(ctx.calls.speak.length).toBe(0);
      expect(ctx.brain.busy).toBe(false);
    } finally { ctx.restore(); }
  });

  test("T17: request model A tidak boleh memengaruhi model B", async () => {
    const ctx = setup();
    try {
      installResolveAfterAbortFetch(ctx, "[EMOTION:senang][GESTURE:wave_hi] dari model A", 25);
      const p = ctx.brain.think("hai");
      await sleep(5);
      // switch: profil jadi milik model B, request A dibatalkan
      ctx.brain.invalidateCapabilityProfile();
      expect(ctx.brain._reactiveState().requestGeneration).toBe(1);
      const profileB = { ...PROFILE, modelName: "model-B", sheet: { config: { displayName: "BChar" } } };
      ctx.brain.capProfile = profileB;
      await p;
      // tidak ada jejak model A di state model B
      expect(ctx.calls.playGesture.length).toBe(0);
      expect(ctx.calls.speak.length).toBe(0);
      expect(ctx.brain._lastProactiveAction).toBeNull();
      expect(ctx.brain._reactiveState().requestGeneration).toBe(1);
    } finally { ctx.restore(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T19/T20: eksekusi tunggal + konkurensi busy guard
// ═══════════════════════════════════════════════════════════════════════
describe("P16 T19/T20 — tanpa eksekusi ganda; busy guard think() tetap berlaku", () => {
  test("T19: multi-segment reply hanya mengeksekusi segmen aktif sekali", async () => {
    const ctx = setup();
    try {
      installOkFetch(ctx, "[EMOTION:senang][GESTURE:nod] Satu. [EMOTION:malu][GESTURE:wave_hi] Dua.");
      await ctx.brain.think("hai");
      // speak fake tidak memanggil onDone → segmen 2 tidak pernah mulai;
      // yang penting: TIDAK ada panggilan ganda untuk aksi yang sama.
      expect(ctx.calls.playGesture).toEqual(["nod"]);
      expect(ctx.calls.speak.filter((t) => t.includes("gak bisa mikir")).length).toBe(0);
    } finally { ctx.restore(); }
  });

  test("T20: think() kedua saat request pertama aktif di-block busy (satu fetch), lalu recover", async () => {
    const ctx = setup();
    try {
      installHangingFetch(ctx);
      const pA = ctx.brain.think("A");
      await sleep(5);
      const pB = ctx.brain.think("B");
      await pB; // langsung return — guard busy, bukan fetch kedua
      expect(ctx.fetchCalls.length).toBe(1);
      // A masih digantung sampai timeout → cleanup
      await pA;
      expect(ctx.brain.busy).toBe(false);
      // Setelah timeout, B boleh jalan normal. Reply multi-segment supaya
      // jalur director (Pass 2) tidak mengubah aksi yang diassert.
      installOkFetch(ctx, "[EMOTION:senang][GESTURE:think] oke. [EMOTION:senang][GESTURE:think] lanjut.");
      await ctx.brain.think("B lagi");
      // speak fake tidak memanggil onDone → hanya segmen pertama yang jalan
      expect(ctx.calls.playGesture).toEqual(["think"]);
    } finally { ctx.restore(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// T21–T24: non-regresi Phase 15 melalui jalur lifecycle baru
// ═══════════════════════════════════════════════════════════════════════
describe("P16 T21-T24 — Phase 15 tetap utuh di atas request lifecycle baru", () => {
  test("T21: konteks Speaker P15.1 masih terbentuk (mood + sesi)", () => {
    const ctx = setup();
    try {
      ctx.brain.userMood = "sedih";
      ctx.brain.agentStart = Date.now() - 5 * 60 * 1000;
      const prompt = ctx.brain.buildSystemPrompt("");
      expect(prompt).toContain("KONTEKS PERILAKU");
      expect(prompt).toContain("Mood user: sedih");
      expect(prompt).toContain("Sesi: 5m");
    } finally { ctx.restore(); }
  });

  test("T22: diversity hint hanya hidup untuk request reactEvent, lenyap setelahnya", async () => {
    const ctx = setup();
    try {
      ctx.brain._diversityHistory.set("idle", ["senang+nod"]);
      installOkFetch(ctx, "[EMOTION:sedih] sepi ya. [EMOTION:sedih] kamu ke mana?");
      await ctx.brain.reactEvent("idle");
      // prompt request proaktif mengandung hint
      const chatCall = ctx.fetchCalls.find((c) => c.url.includes("/api/chat"));
      expect(chatCall!.body.system).toContain("VARIASI PERILAKU");
      // setelah selesai → bersih untuk think() berikutnya
      expect(ctx.brain._diversityHint).toBe("");
      expect(ctx.brain.buildSystemPrompt("")).not.toContain("VARIASI PERILAKU");
    } finally { ctx.restore(); }
  });

  test("T23: Director context P15.3 masih terkirim di body /api/animate-text", async () => {
    const ctx = setup();
    try {
      ctx.brain.userMood = "malu";
      ctx.brain.agentStart = Date.now() - 7 * 60 * 1000;
      installOkFetch(ctx, '{"segments":[]}');
      const segs = await ctx.brain.animateTextViaDirector(
        "hanya teks", ctx.brain.capProfile,
      );
      const call = ctx.fetchCalls.find((c) => c.url.includes("/api/animate-text"));
      expect(call).toBeTruthy();
      expect(call!.body.context).toContain("Mood user: malu");
      expect(call!.body.context).toContain("Sesi: 7m");
      expect(Array.isArray(segs)).toBe(true);
    } finally { ctx.restore(); }
  });

  test("T24: expression hint P15.4 masih menempel di Speaker prompt", () => {
    const ctx = setup();
    try {
      const prompt = ctx.brain.buildSystemPrompt("");
      expect(prompt).toContain("exp_angry — emotion: kesal");
      expect(prompt).toContain("exp_01");
      expect(prompt).not.toContain("exp_01 —");
    } finally { ctx.restore(); }
  });

  test("T25: brain.ts tidak mengenal renderer/Arbiter/MotionRuntime/RoleBridge", () => {
    const src = readFileSync(join(import.meta.dir, "../src/client/agent/brain.ts"), "utf8");
    // Tidak ada import baru ke area terlarang — brain hanya boleh menarik dari
    // tetangga agent/ dan shared/. Regex menangani import multi-baris.
    const importLines = src
      .split("\n")
      .filter((l) => /from "([^"]*)"/.test(l))
      .map((l) => l.match(/from "([^"]+)"/)?.[1] || "");
    const forbidden = ["live2d", "renderer", "arbiter", "motion-runtime", "role-bridge", "model-profile", "parameter-api"];
    for (const imp of importLines) {
      for (const f of forbidden) {
        expect(imp.toLowerCase().includes(f)).toBe(false);
      }
    }
    // Permukaan yang dipakai brain tetap hanya kontrak window.__live2dAgent
    expect(importLines).toContain("./directive-parser");
    expect(importLines).toContain("./expression-classifier");
    expect(importLines).toContain("./param-range");
  });
});
