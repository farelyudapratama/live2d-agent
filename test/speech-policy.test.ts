/**
 * speech-policy.test.ts — S4-D: SHARED SPEECH POLICY (D1–D7 terkunci).
 *
 * Yang diuji = AgentBrain ASLI + SpeechChannel ASLI + bridge contract yang
 * ditiru persis dari speakShared app.js (outcome dihitung dari kepemilikan
 * SAAT audio selesai — pola brain-speech-channel.test.ts S1). Kebijakan
 * panel.ts/app.js yang tidak bisa di-import diuji lewat GUARD pada teks
 * sumber ASLI (konvensi guard repo) + diverifikasi dinamis di
 * smoke-engine-utterance.ts skenario S7.
 *
 * Tabel prioritas terkunci (§22):
 *   user-chain 0 | worker actor -1 | proactive chain -2 | vtuber & app/direct 0 (S3/lama UTUH)
 * Aturan kanal (channel.ts, TIDAK diubah): claim ditolak hanya bila
 * incoming.priority < holder.priority; sama/lebih tinggi = takeover legal.
 * Konsekuensi: worker (-1) refused saat chain/user (0) memegang (D1);
 * proactive (-2) refused saat si apa pun ≥ -1 memegang (D2); user input
 * (0) selalu merebut worker (-1) (D6).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentBrain } from "../src/client/agent/brain";
import { createSpeechChannel } from "../src/client/speech/channel";

const repoRoot = resolve(import.meta.dir, "..");
const origWindow = (globalThis as any).window;
const origDocument = (globalThis as any).document;
const origFetch = (globalThis as any).fetch;
afterEach(() => {
  (globalThis as any).window = origWindow;
  (globalThis as any).document = origDocument;
  (globalThis as any).fetch = origFetch;
});

const PROFILE: any = {
  emotions: ["senang", "sedih", "malu", "normal"],
  nativeExpressions: [],
  accessories: [],
  properties: [],
  gestures: ["nod", "wave_hi", "think"],
  motionCatalog: [],
  sheet: { config: { displayName: "T" } },
  userNote: "",
  roleIds: {},
  paramRange: {},
  modelName: "m",
  controlAxes: { head: true, eyes: true, mouth: true, body: true, brow: false },
};

/** setup: kanal ASLI + fake engine dengan KONTRAK speakShared persis. */
function setup() {
  const ch = createSpeechChannel();
  let enforcerRuns = 0;
  ch.setEnforcer(() => {
    enforcerRuns++;
  });
  const engine = {
    spoken: [] as { text: string; token: any; onDone: any }[],
    locks: 0,
    unlocks: 0,
    stops: 0,
  };
  (globalThis as any).window = {
    __speechChannel: ch,
    __live2dAgent: {
      isReady: () => true,
      getExpressibleEmotions: () => ({}),
      setExpression: () => {},
      setAIPose: () => {},
      playMotion: () => true,
      playGesture: () => {},
      speak: (t: string, onDone?: any, opts?: any) => {
        const token = opts && typeof opts === "object" && "token" in opts ? opts.token ?? null : null;
        engine.spoken.push({ text: t, token, onDone });
      },
      lockAI: () => {
        engine.locks++;
      },
      unlockAI: () => {
        engine.unlocks++;
      },
      stopSpeech: () => {
        engine.stops++;
      },
      setGazeIntent: () => {},
    },
    __addChat: () => {},
    __appEvents: { idleSpeak: true, quietMs: 0 },
  };
  (globalThis as any).document = { getElementById: () => null };
  const brain: any = new AgentBrain();
  brain.capProfile = PROFILE;
  const finishCurrent = (i: number) => {
    const s = engine.spoken[i];
    if (!s || !s.onDone) return;
    const outcome = !s.token || ch.isOwner(s.token) ? "completed" : "lost";
    s.onDone(outcome);
  };
  const enforcer = () => enforcerRuns;
  return { brain, ch, engine, finishCurrent, enforcer };
}

const chatStub = (reply: string) => {
  (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ reply }) });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ═══ D1 + §19: chain utuh, worker refused ═════════════════════════════
describe("S4-D D1 — worker speech tidak bisa preempt/mematikan companion chain", () => {
  test("D1a: claim(-1) saat user-chain(0) memegang → REFUSED; channel tidak pindah", async () => {
    const { brain, ch, engine, finishCurrent } = setup();
    chatStub("[EMOTION:senang][GESTURE:nod] SEG-A. [EMOTION:senang][GESTURE:nod] SEG-B. [EMOTION:senang] SEG-C.");
    const p = brain.think("hai");
    await p; // chain aktif bicara seg A
    expect(ch.current()?.producer).toBe("brain/chain");
    const refused = ch.claim("harness/actor", { priority: -1 });
    expect(refused).toBeNull();                      // D1: refusal MEKANIS
    expect(ch.current()?.producer).toBe("brain/chain");
    // §19 inti: percobaan worker TIDAK memicu onLost — rantai HIDUP:
    expect(brain._reactiveState().utteranceActive).toBe(true);
    finishCurrent(0);                                 // seg A selesai natural → B
    await sleep(250);
    expect(engine.spoken.map((s) => s.text)).toEqual(["SEG-A.", "SEG-B."]);
    finishCurrent(1);                                 // → C
    await sleep(250);
    expect(engine.spoken.map((s) => s.text)).toEqual(["SEG-A.", "SEG-B.", "SEG-C."]);
    finishCurrent(2);
    await sleep(250);
    expect(ch.current()).toBeNull();                  // selesai penuh, kanal lepas
    expect(engine.locks).toBe(1);
    expect(engine.unlocks).toBe(1);                   // pairing P18 utuh (D7)
  });

  test("D1b: refusal terjadi SEBELUM audio — nol utterance worker, nol bubble", () => {
    // panel funnel (speakAsCharacter) TIDAK meng-import DOM test — guard
    // urutan pada teks sumber ASLI: claim dulu, hanya lolos yang addChat.
    const panel = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "panel.ts"), "utf8");
    const iClaim = panel.indexOf('ch.claim("harness/actor", { priority: -1 })');
    const iRefused = panel.indexOf("if (!tok) return;");
    const iBubble = panel.indexOf('__addChat?.("agent", text)');
    expect(iClaim).toBeGreaterThan(-1);
    expect(iRefused).toBeGreaterThan(iClaim);         // refused → return SEBELUM bubble
    expect(iBubble).toBeGreaterThan(iRefused);        // bubble hanya utk pemilik
  });
});

// ═══ D2: proactive refused saat worker memegang ═══════════════════════
describe("S4-D D2 — proactive speech tidak merebut kanal dari worker", () => {
  test("D2a: holder worker(-1) → reactEvent claim(-2) REFUSED; senyap, pairing utuh", async () => {
    const { brain, ch, engine } = setup();
    const worker = ch.claim("harness/actor", { priority: -1 }); // simulasi baris worker audible
    expect(worker).not.toBeNull();
    chatStub("[EMOTION:senang][GESTURE:nod] PRO-A. [EMOTION:senang] PRO-B.");
    await brain.reactEvent("idle");
    expect(engine.spoken.length).toBe(0);             // TIDAK ADA audio proaktif
    expect(ch.current()?.producer).toBe("harness/actor"); // worker tak terusik
    expect(brain._reactiveState().utteranceActive).toBe(false); // rantai tak pernah lahir
    expect(engine.locks).toBe(engine.unlocks);        // refusal me-reset lock (P18 pairing)
    ch.release(worker as any);
  });

  test("D2b: kanal bebas → proactive normal (tidak ada regresi perilaku lama)", async () => {
    const { brain, ch, engine, finishCurrent } = setup();
    chatStub("[EMOTION:senang][GESTURE:nod] PRO-A. [EMOTION:senang] PRO-B.");
    await brain.reactEvent("idle");
    expect(ch.current()?.producer).toBe("brain/chain"); // proactive claim 0-vs-bebas OK
    expect(engine.spoken.length).toBe(1);
    finishCurrent(0);
    await sleep(250);
    expect(engine.spoken.length).toBe(2);             // chain proaktif lanjut normal
    finishCurrent(1);
    await sleep(250);
    expect(ch.current()).toBeNull();
  });
});

// ═══ D6: explicit user input SELALU menang (deklarasi, bukan kebetulan)
describe("S4-D D6 — user input preempt worker speech", () => {
  test("D6a: worker(-1) memegang → think() claim(0) takeover + enforcer jalan", async () => {
    const { brain, ch, engine, finishCurrent, enforcer } = setup();
    const worker = ch.claim("harness/actor", { priority: -1 });
    chatStub("[EMOTION:senang][GESTURE:nod] USER-A. [EMOTION:senang] USER-B.");
    const p = brain.think("pesan user");
    await p;
    expect(ch.current()?.producer).toBe("brain/chain"); // user merebut kanal
    expect(enforcer()).toBe(1);                          // audio worker dihentikan
    expect(worker).not.toBeNull();
    expect(ch.isOwner(worker as any)).toBe(false);       // worker basi — release-nya nanti no-op aman
    finishCurrent(0);
    await sleep(250);
    expect(engine.spoken.length).toBe(2);                // chain user lanjut penuh
    finishCurrent(1);
    await sleep(250);
  });

  test("D6b: MERGE/PREEMPT companion lama utuh (tidak disentuh S4-D)", async () => {
    const { brain, ch } = setup();
    expect(typeof brain._pendingMerge).not.toBe("undefined");
    expect(ch.version()).toBe("1.0.0-speech-channel");   // kanal tidak diubah
  });
});

// ═══ Tabel prioritas — matriks penuh pada kanal ASLI ═══════════════════
describe("S4-D prioritas — matriks takeover/refusal (channel ASLI, unchanged)", () => {
  test("M1: holder chain(0): -1 refused, -2 refused, 0 takeover, +1 takeover", () => {
    const ch = createSpeechChannel();
    const holder = ch.claim("brain/chain", { priority: 0 })!;
    expect(ch.claim("harness/actor", { priority: -1 })).toBeNull();
    expect(ch.claim("prober", { priority: -2 })).toBeNull();
    expect(ch.claim("user2", { priority: 0 })).not.toBeNull();
    ch.release(holder); // holder lama sudah digusur; rapikan
  });

  test("M2: holder worker(-1): proactive(-2) refused; serialisasi antar-worker = flag panel (guard D3)", () => {
    const ch = createSpeechChannel();
    const worker = ch.claim("harness/actor", { priority: -1 })!;
    expect(ch.claim("brain/chain", { priority: -2 })).toBeNull(); // D2 numerik
    // antar -1 secara kanal legal (sama) — YANG menyerikan adalah flag
    // producer-side panel.ts; guard urutan di bawah membuktikannya.
    expect(ch.claim("harness/actor", { priority: -1 })).not.toBeNull();
    ch.release(worker);
    const panel = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "panel.ts"), "utf8");
    const iFlag = panel.indexOf("if (harnessVoicing) return;");
    const iClaim = panel.indexOf('ch.claim("harness/actor"');
    expect(iFlag).toBeGreaterThan(-1);
    expect(iFlag).toBeLessThan(iClaim);                 // cek flag SEBELUM klaim (D3)
    expect(panel).toMatch(/setTimeout\(done, 60000\)/); // watchdog ikut konvensi speakWait
  });

  test("M3: holder proactive(-2): worker(-1) dan chain(0) legal merebut — lapisan terendah", () => {
    const ch = createSpeechChannel();
    const pro = ch.claim("brain/chain", { priority: -2 })!;
    expect(ch.claim("harness/actor", { priority: -1 })).not.toBeNull();
    expect(ch.isOwner(pro)).toBe(false);
  });
});

// ═══ §5/§23 speakShared — jalur refusal (guard teks ASLI app.js) ══════
describe("S4-D speakShared — refusal tidak bersuara (app.js ASLI)", () => {
  const app = readFileSync(join(repoRoot, "static", "js", "app.js"), "utf8");
  const body = app.slice(app.indexOf("function speakShared"), app.indexOf("function speak(text, onDone)"));

  test("SS1: claim(null) → onDone('refused') SEBELUM speak() — tidak ada jalur audio", () => {
    expect(body).toMatch(/if \(!token && implicit\) \{\s*\n\s*\/\/ S4-D/);
    const iRefusal = body.indexOf('onDone("refused")');
    const iSpeak = body.indexOf("speak(text, function ()");
    expect(iRefusal).toBeGreaterThan(-1);
    expect(iRefusal).toBeLessThan(iSpeak);
    expect(body).toMatch(/return;\s*\n\s*\}\s*\n\s*const mine = token;/);
  });

  test("SS2: priority di-forward ke claim; default 0 = konsumen lama (vtuber/app/direct) tak berubah", () => {
    expect(body).toMatch(/priority: Number\.isFinite\(Number\(opts\.priority\)\)[\s\S]{0,80}: 0,/);
    // vtuber __debugSpeak tidak mengirim priority → 0 → terhadap holder mana pun
    // (0 sama/lbh) legal takeover — SEMANTIK S3 UTUH (verified by S3 suites).
  });

  test("SS3: refusal tidak menyentuh release (token tak pernah dipegang) & channel.ts beku", () => {
    expect(body).toMatch(/if \(onDone\) onDone\("refused"\);\s*\n\s*return;/); // sebelum blok speak/release mana pun
    const chan = readFileSync(join(repoRoot, "src", "client", "speech", "channel.ts"), "utf8");
    expect(chan).not.toMatch(/S4-D/);                   // file kanal TIDAK disentuh
    expect(chan).toMatch(/return "1.0.0-speech-channel"/);
    expect(chan).toMatch(/if \(owner && priority < owner\.token\.priority\) return null;/);
  });
});

// ═══ §7/§25 Isolasi eksekusi worker — guard teks ASLI ══════════════════
describe("S4-D isolasi eksekusi — suppressed speech ≠ task state", () => {
  test("ISO1: speakAsCharacter TIDAK menyebut state worker apa pun", () => {
    const panel = readFileSync(join(repoRoot, "src", "client", "agent", "panel", "panel.ts"), "utf8");
    const body = panel.slice(panel.indexOf("let harnessVoicing"), panel.indexOf("export function startAssistantPanel"));
    expect(body).not.toMatch(/activeTask|parkedTasks|cancelRequested|approvals|rt\./);
    expect(body).toMatch(/priority: -1/);              // D1 numerik
    expect(body).toMatch(/producer: "harness\/actor"/); // identitas S1 tetap
  });

  test("ISO2: brain.ts — hanya klaim yang berubah; _onChannelLost & outcome TAKSONOMI utuh (D7)", () => {
    const brain = readFileSync(join(repoRoot, "src", "client", "agent", "brain.ts"), "utf8");
    expect(brain).toMatch(/priority: preempt \? 0 : -2,/);
    const def = brain.indexOf("private _onChannelLost");
    const lost = brain.slice(def, brain.indexOf("private _releaseChannel", def));
    expect(lost).toMatch(/if \(this\._chainOwner !== chainToken\) return;/);
    expect(lost).toMatch(/this\._releaseChannel\(\);/);
    expect(lost).toMatch(/unlockAI\?\.\(\)/);
    // taksonomi lost/completed tak diubah: satu-satunya nilai outcome bridge lama
    expect(brain).toMatch(/outcome === "lost"/);
  });
});
