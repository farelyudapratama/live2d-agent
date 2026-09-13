/**
 * brain-apply-actions.test.ts — Phase 12: unit test langsung AgentBrain
 * applyActions() dengan engine API palsu (fake window.__live2dAgent).
 *
 * Yang dikunci (spesifikasi Phase 12 §3):
 *   - [MOTION:id]  → playMotion(id, {fromLLM:true, priority:80, fitToMs dari
 *                    estimateSpeechMs(teks segmen), intensity bila ada}).
 *   - Motion asing → playMotion false → hanya console.warn, TIDAK crash, dan
 *                    gesture fallback TETAP berjalan (perilaku existing).
 *   - [EMOTION:x]  → setExpression(x, intensity); default 0.85; emosi yang
 *                    tidak ada di vocab model → preset "user:<nama>".
 *   - [HEAD]/[EYES]/[MOUTH]/[BODY] → setAIPose NESTED {head,eyes,mouth,body}
 *                    dengan clamp skala referensi (±30 / ±1) — semantik
 *                    role space existing, bukan angka parameter mentah.
 *   - [GESTURE:x]  → playGesture(x).
 *   - [ACC:p:v]    → setAccessory(p, v) — JALUR LEGACY sengaja dipertahankan
 *                    (Phase 12 TIDAK memigrasi writer ACC).
 *   - Agent belum siap → tidak ada panggilan sama sekali.
 *
 * applyActions() private — dipanggil via (brain as any), pola yang sama dengan
 * guard legacy: menguji implementasi asli, bukan salinan.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { AgentBrain, estimateSpeechMs } from "../src/client/agent/brain";
import { parseSegments } from "../src/client/agent/directive-parser";

type Calls = Record<string, any[]>;

function makeAgent(overrides: Record<string, any> = {}) {
  const calls: Calls = { setExpression: [], setAIPose: [], setAccessory: [], playMotion: [], playGesture: [] };
  const agent: any = {
    isReady: () => true,
    getExpressibleEmotions: () => ({ senang: "param", sedih: "native" }),
    setExpression: (...a: any[]) => calls.setExpression.push(a),
    setAIPose: (...a: any[]) => calls.setAIPose.push(a),
    setAccessory: (...a: any[]) => calls.setAccessory.push(a),
    playMotion: (...a: any[]) => {
      calls.playMotion.push(a);
      return true;
    },
    playGesture: (...a: any[]) => calls.playGesture.push(a),
    ...overrides,
  };
  return { agent, calls };
}

// applyActions membaca window.__live2dAgent saat dipanggil — pasang fake
// window hanya selama test (module brain sudah diimpor tanpa window, jadi
// instalasi global browser-nya tidak jalan di Bun).
const origWindow = (globalThis as any).window;
function withAgent(agent: any): void {
  (globalThis as any).window = { __live2dAgent: agent };
}
afterEach(() => {
  (globalThis as any).window = origWindow;
});

function apply(brain: any, input: string, segmentIndex = 0): void {
  const segs = parseSegments(input);
  brain.applyActions(segs[0]?.actions ?? {}, segmentIndex, segs[0]?.text ?? "");
}

describe("applyActions — [MOTION:id] jalur LLM (priority 80)", () => {
  test("playMotion dipanggil dengan id, fromLLM, priority 80, fitToMs dari teks", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    const text = "Halo, senang bertemu!";
    apply(brain, `[MOTION:nod] ${text}`);
    expect(calls.playMotion.length).toBe(1);
    const [id, opts] = calls.playMotion[0];
    expect(id).toBe("nod");
    expect(opts.fromLLM).toBe(true);
    expect(opts.priority).toBe(80);
    expect(opts.fitToMs).toBe(estimateSpeechMs(text));
    expect(opts.fitToMs).toBeGreaterThan(0);
    expect(opts.intensity).toBeUndefined();
  });

  test("[INTENSITY:0.5] di segmen yang sama diteruskan ke playMotion", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[INTENSITY:0.5][MOTION:nod] teks segmen");
    expect(calls.playMotion[0][1].intensity).toBe(0.5);
  });

  test("motion + gesture di segmen sama: KEDUANYA dimainkan (layer 80 di atas 60)", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[MOTION:nod][GESTURE:wave_hi] teks");
    expect(calls.playMotion.length).toBe(1);
    expect(calls.playGesture.length).toBe(1);
    expect(calls.playGesture[0][0]).toBe("wave_hi");
  });
});

describe("applyActions — motion tidak dikenal gagal aman", () => {
  test("playMotion false → tidak crash, warn, gesture fallback tetap jalan", () => {
    const { agent, calls } = makeAgent({
      // playMotion mengembalikan false = id tidak ada di registry / ditolak
      playMotion: (...a: any[]) => {
        calls.playMotion.push(a);
        return false;
      },
    });
    withAgent(agent);
    const brain: any = new AgentBrain();
    // "senang" ada di vocab (via "param") → fallback gesture per-emosi jalan
    expect(() => apply(brain, "[EMOTION:senang][MOTION:tidak_ada_123] teks")).not.toThrow();
    expect(calls.playMotion[0][0]).toBe("tidak_ada_123");
    expect(calls.playMotion[0][1].priority).toBe(80);
    // gesture fallback emosi senang tetap dimainkan (EMOTION_GESTURE_FALLBACK)
    expect(calls.playGesture.length).toBe(1);
    expect(calls.playGesture[0][0]).toBe("lean_excited");
  });

  test("motion asing + [GESTURE] eksplisit → gesture eksplisit yang dimainkan", () => {
    const { agent, calls } = makeAgent({
      playMotion: () => false,
    });
    withAgent(agent);
    const brain: any = new AgentBrain();
    expect(() => apply(brain, "[GESTURE:nod][MOTION:ngawur] teks")).not.toThrow();
    expect(calls.playGesture[0][0]).toBe("nod");
  });
});

describe("applyActions — [EMOTION] & intensitas", () => {
  test("emosi di vocab model → setExpression(nama, intensity default 0.85)", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[EMOTION:senang] teks");
    expect(calls.setExpression[0]).toEqual(["senang", 0.85]);
  });

  test("intensity dari [INTENSITY:] dipertahankan (clamp parser 0.1..1)", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[EMOTION:senang][INTENSITY:0.4] teks");
    expect(calls.setExpression[0]).toEqual(["senang", 0.4]);
  });

  test("emosi asing → fallback preset user:<nama>", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[EMOTION:ngantuk] teks");
    expect(calls.setExpression[0][0]).toBe("user:ngantuk");
  });

  test("'normal' selalu diterima walau tidak ada di vocab", () => {
    const { agent, calls } = makeAgent({ getExpressibleEmotions: () => ({}) });
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[EMOTION:normal] teks");
    expect(calls.setExpression[0]).toEqual(["normal", 0.85]);
  });
});

describe("applyActions — pose semantik (nested, clamp skala referensi)", () => {
  test("HEAD/EYES/MOUTH/BODY → setAIPose nested, clamp ±30 / ±1", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[HEAD:50,-50][EYES:5,-5][MOUTH:3,0][BODY:100,-100,0] teks");
    expect(calls.setAIPose.length).toBe(1);
    const pose = calls.setAIPose[0][0];
    expect(pose.head.x).toBe(30);
    expect(pose.head.y).toBe(-30);
    expect(pose.eyes.x).toBe(1);
    expect(pose.eyes.y).toBe(-1);
    expect(pose.mouth.form).toBe(1);
    expect(pose.body.x).toBe(30);
    expect(pose.body.y).toBe(-30);
    // body.z: 0 + jitter organik (±2.5°, deterministik per segmentIndex) →
    // bukan tepat 0; yang dikunci hanya batas clamp-nya
    expect(Math.abs(pose.body.z)).toBeLessThanOrEqual(30);
    expect(pose.body.z).toBeCloseTo(Math.sin(0.4) * 2.5, 5);
  });

  test("pose TIDAK dikirim saat tidak ada directive pose & emosi via aset model", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    // "sedih" via "native" → TIDAK ada pose inferensi (aset model bawa geraknya)
    apply(brain, "[EMOTION:sedih] teks");
    expect(calls.setAIPose.length).toBe(0);
    expect(calls.setExpression[0][0]).toBe("sedih");
  });

  test("pose inferensi dari emosi sintetis (tidak ada di vocab) memakai skala role", () => {
    const { agent, calls } = makeAgent({ getExpressibleEmotions: () => ({}) });
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[EMOTION:kaget] teks");
    expect(calls.setAIPose.length).toBe(1);
    const pose = calls.setAIPose[0][0];
    // kaget: kepala mendongak (angleY negatif fraksi -0.33 → ×30), bukan angka mentah
    expect(pose.head.y).toBeLessThan(0);
    expect(Math.abs(pose.head.x)).toBeLessThanOrEqual(30);
    expect(Math.abs(pose.eyes.y)).toBeLessThanOrEqual(1);
  });
});

describe("applyActions — gesture, aksesoris (legacy), properti", () => {
  test("[GESTURE:x] → playGesture(x)", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[GESTURE:tilt_curious] teks");
    expect(calls.playGesture[0]).toEqual(["tilt_curious"]);
  });

  test("[ACC:Param:1] → setAccessory — JALUR LEGACY, sengaja tidak dimigrasi di Phase 12", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[ACC:ParamCheek:1] teks");
    expect(calls.setAccessory[0]).toEqual(["ParamCheek", 1]);
  });

  test("[PROP:nama] → setExpression tanpa intensity", () => {
    const { agent, calls } = makeAgent();
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[PROP:kacamata] teks");
    expect(calls.setExpression[0]).toEqual(["kacamata"]);
  });
});

describe("applyActions — agent tidak siap / tidak ada", () => {
  test("isReady false → tidak ada panggilan engine sama sekali", () => {
    const { agent, calls } = makeAgent({ isReady: () => false });
    withAgent(agent);
    const brain: any = new AgentBrain();
    apply(brain, "[EMOTION:senang][MOTION:nod][GESTURE:nod][HEAD:5,5] teks");
    expect(calls.setExpression.length).toBe(0);
    expect(calls.setAIPose.length).toBe(0);
    expect(calls.playMotion.length).toBe(0);
    expect(calls.playGesture.length).toBe(0);
  });

  test("window.__live2dAgent absen → tidak crash", () => {
    (globalThis as any).window = {};
    const brain: any = new AgentBrain();
    expect(() => apply(brain, "[MOTION:nod] teks")).not.toThrow();
  });
});
