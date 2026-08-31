/**
 * test/motion-runtime.test.ts — Stretch playback (fitToMs) + arbitrase blend-out.
 * Waktu dikontrol penuh lewat bridge.now() palsu; rAF dimatikan agar tick
 * berjalan lewat setTimeout dan setiap sampel waktu deterministik.
 */
import { describe, it, expect, afterAll } from "bun:test";
import {
  MotionRuntime,
  computePlaybackPlan,
  STRETCH_MAX,
} from "../src/client/animation/motion-runtime";
import { MotionRegistry } from "../src/client/animation/motion-registry";
import { estimateSpeechMs } from "../src/client/agent/brain";
import type { MotionAsset } from "../src/shared/types";

const origRaf = (globalThis as any).requestAnimationFrame;
const origCaf = (globalThis as any).cancelAnimationFrame;
(globalThis as any).requestAnimationFrame = undefined;
(globalThis as any).cancelAnimationFrame = undefined;
afterAll(() => {
  (globalThis as any).requestAnimationFrame = origRaf;
  (globalThis as any).cancelAnimationFrame = origCaf;
});

function makeAsset(id: string, overrides?: Partial<MotionAsset>): MotionAsset {
  return {
    version: 1, id, name: id, description: "test",
    tags: [], source: "user", type: "keyframe",
    duration: 1, loop: false,
    intensity: { min: 0.3, max: 1, default: 0.8 },
    emotionCompatibility: {}, cooldown: 0, priority: 80,
    aiEnabled: true, requires: [],
    tracks: [{ kind: "role", target: "ax", keys: [{ t: 0, v: 0 }, { t: 1, v: 30 }] }] as any,
    ...overrides,
  };
}

function makeHarness(reg?: MotionRegistry) {
  let fakeNow = 0;
  const applies: Record<string, number>[] = [];
  const bridge = {
    now: () => fakeNow,
    getPoseBase: () => ({}) as Record<string, number>,
    applyPoseDelta: (d: Record<string, number>) => { applies.push(d); },
    clearPoseDelta: () => { applies.push({}); },
    applyParamDrive: () => {},
    releaseParamDrive: () => {},
  };
  const runtime = new MotionRuntime(reg ?? new MotionRegistry(), bridge as any);
  return { runtime, setTime: (t: number) => { fakeNow = t; }, applies };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("computePlaybackPlan (stretch math)", () => {
  it("tanpa fitToMs: durasi asli, speed 1 (paritas perilaku lama)", () => {
    const p = computePlaybackPlan(makeAsset("a"), {});
    expect(p.fitMs).toBe(0);
    expect(p.speed).toBe(1);
    expect(p.fadeStartMs).toBe(1000);
    expect(p.totalMs).toBe(1250);
  });

  it("fitToMs > durasi dalam batas: playback dilar sampai tepat fitMs", () => {
    const p = computePlaybackPlan(makeAsset("a"), { fitToMs: 1600 });
    expect(p.fitMs).toBe(1600);
    expect(p.speed).toBeCloseTo(1000 / 1480, 5);
    expect(p.fadeStartMs).toBe(1600);
    expect(p.totalMs).toBe(1850);
  });

  it("fitToMs 4× durasi: speed di-clamp ke 1/STRETCH_MAX, sisanya hold", () => {
    const p = computePlaybackPlan(makeAsset("a"), { fitToMs: 4000 });
    expect(p.speed).toBeCloseTo(1 / STRETCH_MAX, 5);
    expect(p.fadeStartMs).toBe(4000);
    expect(p.totalMs).toBe(4250);
  });

  it("stretch dibatasi STRETCH_MAX — sisanya hold di keyframe terakhir", () => {
    const p = computePlaybackPlan(makeAsset("a"), { fitToMs: 10000 });
    expect(p.speed).toBeCloseTo(1 / STRETCH_MAX, 5);
    expect(p.fadeStartMs).toBe(10000);
    expect(p.totalMs).toBe(10250);
  });

  it("fitToMs lebih pendek dari durasi: tidak pernah dipercepat", () => {
    const p = computePlaybackPlan(makeAsset("a"), { fitToMs: 400 });
    expect(p.fitMs).toBe(0);
    expect(p.speed).toBe(1);
  });

  it("motion loop mengabaikan fitToMs (sudah mengisi waktu sendiri)", () => {
    const p = computePlaybackPlan(makeAsset("a", { loop: true }), { fitToMs: 4000 });
    expect(p.fitMs).toBe(0);
    expect(p.speed).toBe(1);
  });
});

describe("estimateSpeechMs", () => {
  it("teks kosong → 0 (tidak di-stretch)", () => {
    expect(estimateSpeechMs("")).toBe(0);
    expect(estimateSpeechMs("   ")).toBe(0);
  });
  it("skala ±16 karakter/detik + lead-in", () => {
    expect(estimateSpeechMs("halo")).toBe(500 + 4 * 62);
  });
  it("dibatasi 12 detik", () => {
    expect(estimateSpeechMs("a".repeat(500))).toBe(12000);
  });
});

describe("MotionRuntime stretch playback", () => {
  it("timeline berjalan lebih lambat, hold di akhir, lalu fade dan selesai", async () => {
    const reg = new MotionRegistry();
    reg.register(makeAsset("m"));
    const h = makeHarness(reg);
    let doneId = "";
    expect(h.runtime.play("m", { intensity: 1, fitToMs: 4000, onDone: (id) => (doneId = id) })).toBe(true);

    h.setTime(600);
    await settle();
    let ev = h.runtime.sampleForTest()!;
    // speed di-clamp 0.5 → tSec = (600-120)*0.5/1000 = 0.24 → ax = 7.2
    expect(ev.roles.ax).toBeCloseTo(7.2, 1);

    h.setTime(2000);
    await settle();
    ev = h.runtime.sampleForTest()!;
    // tSec = (2000-120)*0.5/1000 = 0.94 → ax = 28.2
    expect(ev.roles.ax).toBeCloseTo(28.2, 1);

    // Playback selesai ±3997 ms; fade mulai 4000 → amp 0.6 di 4100, hold di v=30
    h.setTime(4100);
    await settle();
    ev = h.runtime.sampleForTest()!;
    expect(ev.roles.ax).toBeCloseTo(18, 1);

    h.setTime(4300);
    await settle();
    expect(h.runtime.isPlaying()).toBe(false);
    expect(doneId).toBe("m");
    // Delta terakhir yang diterapkan kosong → pose kembali penuh ke dasar
    const last = h.applies[h.applies.length - 1] || {};
    expect(Object.keys(last).length).toBe(0);
  });

  it("setelah clamp, keyframe terakhir ditahan penuh sampai akhir omongan", async () => {
    const reg = new MotionRegistry();
    reg.register(makeAsset("m"));
    const h = makeHarness(reg);
    expect(h.runtime.play("m", { intensity: 1, fitToMs: 10000 })).toBe(true);

    // Playback (speed 0.5) selesai di 120+2000 = 2120 ms → di 3000 sudah hold
    h.setTime(3000);
    await settle();
    expect(h.runtime.sampleForTest()!.roles.ax).toBeCloseTo(30, 1);

    h.setTime(10100);
    await settle();
    expect(h.runtime.sampleForTest()!.roles.ax).toBeCloseTo(18, 1);
  });

  it("tanpa fitToMs perilaku lama tidak berubah", async () => {
    const reg = new MotionRegistry();
    reg.register(makeAsset("m"));
    const h = makeHarness(reg);
    expect(h.runtime.play("m", { intensity: 1 })).toBe(true);

    h.setTime(500);
    await settle();
    expect(h.runtime.sampleForTest()!.roles.ax).toBeCloseTo(11.4, 1);

    h.setTime(1100);
    await settle();
    expect(h.runtime.sampleForTest()!.roles.ax).toBeCloseTo(18, 1);

    h.setTime(1300);
    await settle();
    expect(h.runtime.isPlaying()).toBe(false);
  });
});

describe("MotionRuntime arbitrase multi-layer", () => {
  it("layer prioritas lebih rendah IKUT sebagai lapisan di bawah motion yang masih main", async () => {
    const reg = new MotionRegistry();
    reg.register(makeAsset("m", { priority: 80 }));
    reg.register(makeAsset("g", { priority: 60 }));
    const h = makeHarness(reg);
    expect(h.runtime.play("m", { intensity: 1, fitToMs: 4000 })).toBe(true);

    h.setTime(2000);
    await settle();
    expect(h.runtime.play("g")).toBe(true);
    expect(h.runtime.getActive()!.id).toBe("g");
    // Ownership: ax masih dipegang m (nilainya positif dari track m, bukan g)
    expect(h.runtime.sampleForTest()!.roles.ax).toBeGreaterThan(0);
  });

  it("ownership berpindah setelah layer tinggi selesai fade", async () => {
    const reg = new MotionRegistry();
    reg.register(makeAsset("m", { priority: 80 })); // ax: 0 → 30
    reg.register(
      makeAsset("g", {
        priority: 60,
        tracks: [{ kind: "role", target: "ax", keys: [{ t: 0, v: 0 }, { t: 1, v: -30 }] }] as any,
      })
    );
    const h = makeHarness(reg);
    expect(h.runtime.play("m", { intensity: 1, fitToMs: 4000 })).toBe(true);
    h.setTime(4100); // m di jendela fade, masih memegang ax
    await settle();
    expect(h.runtime.play("g", { intensity: 1 })).toBe(true);
    expect(h.runtime.sampleForTest()!.roles.ax).toBeGreaterThan(0);

    h.setTime(4300); // m sudah selesai (totalMs 4250) → ax milik g (negatif)
    await settle();
    expect(h.runtime.sampleForTest()!.roles.ax).toBeLessThan(0);
  });

  it("layer bebas field bergerak BERSAMAAN: ax dari motion, ey dari layer rendah", async () => {
    const reg = new MotionRegistry();
    reg.register(makeAsset("m", { priority: 80 }));
    reg.register(
      makeAsset("e", {
        priority: 60,
        tracks: [{ kind: "role", target: "ey", keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }] as any,
      })
    );
    const h = makeHarness(reg);
    expect(h.runtime.play("m", { intensity: 1 })).toBe(true);
    h.setTime(500);
    await settle();
    expect(h.runtime.play("e", { intensity: 1 })).toBe(true);
    h.setTime(1000);
    await settle();
    const ev = h.runtime.sampleForTest()!;
    expect(ev.roles.ax).toBeCloseTo(26.4, 1); // m: (1000-120)/1000 * 30
    expect(ev.roles.ey).toBeCloseTo(0.38, 2); // e: (1000-500)/1000 * 1
  });

  it("play band sama MENGGANTIKAN layer lama (paritas cut perilaku lama)", async () => {
    const reg = new MotionRegistry();
    reg.register(makeAsset("m1", { priority: 80 }));
    reg.register(
      makeAsset("m2", {
        priority: 80,
        tracks: [{ kind: "role", target: "ay", keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }] }] as any,
      })
    );
    const h = makeHarness(reg);
    expect(h.runtime.play("m1", { intensity: 1 })).toBe(true);
    h.setTime(300);
    await settle();
    expect(h.runtime.play("m2", { intensity: 1 })).toBe(true);
    expect(h.runtime.isPlaying("m1")).toBe(false);
    expect(h.runtime.isPlaying("m2")).toBe(true);
    h.setTime(800);
    await settle();
    const ev = h.runtime.sampleForTest()!;
    expect(ev.roles.ax).toBeUndefined(); // kontribusi m1 hilang
    expect(ev.roles.ay).toBeCloseTo(3.8, 1); // m2: (800-300-120)/1000 * 10
  });

  it("param dilepas hanya saat tak lagi dimiliki layer mana pun", async () => {
    const released: string[] = [];
    let fakeNow = 0;
    const bridge = {
      now: () => fakeNow,
      getPoseBase: () => ({}),
      applyPoseDelta: () => {},
      clearPoseDelta: () => {},
      applyParamDrive: () => {},
      releaseParamDrive: (ids: string[]) => released.push(...ids),
      readParam: () => 5,
    };
    const reg = new MotionRegistry();
    reg.register(
      makeAsset("a", {
        priority: 80,
        duration: 0.6,
        tracks: [{ kind: "param", param: "ParamA", keys: [{ t: 0, v: 0 }, { t: 0.5, v: 10 }] }] as any,
      })
    );
    reg.register(
      makeAsset("b", {
        priority: 60,
        duration: 3,
        tracks: [{ kind: "param", param: "ParamB", keys: [{ t: 0, v: 0 }, { t: 2, v: 10 }] }] as any,
      })
    );
    const runtime = new MotionRuntime(reg, bridge as any);
    expect(runtime.play("a")).toBe(true);
    expect(runtime.play("b")).toBe(true);

    fakeNow = 900; // a selesai (totalMs 850), b masih main
    await settle();
    expect(runtime.isPlaying("a")).toBe(false);
    expect(runtime.isPlaying("b")).toBe(true);
    expect(released).toContain("ParamA");
    expect(released).not.toContain("ParamB");

    fakeNow = 3300; // b juga selesai
    await settle();
    expect(released).toContain("ParamB");
  });

  it("cap MAX_LAYERS: play lebih rendah ditolak saat penuh, band sama tetap menggantikan", async () => {
    const reg = new MotionRegistry();
    for (const [id, prio] of [["l1", 90], ["l2", 60], ["l3", 40], ["l4", 30]] as const) {
      reg.register(makeAsset(id, { priority: prio }));
    }
    reg.register(makeAsset("l0", { priority: 20 }));
    reg.register(makeAsset("l2b", { priority: 60 }));
    const h = makeHarness(reg);
    for (const id of ["l1", "l2", "l3", "l4"]) {
      expect(h.runtime.play(id)).toBe(true); // menurun: 4 layer menumpuk
    }
    expect(h.runtime.play("l0")).toBe(false); // penuh oleh 4 band lebih tinggi
    expect(h.runtime.play("l2b")).toBe(true); // band sama menggantikan l2 + di bawahnya
    expect(h.runtime.isPlaying("l1")).toBe(true);
    expect(h.runtime.isPlaying("l2")).toBe(false);
    expect(h.runtime.isPlaying("l2b")).toBe(true);
    expect(h.runtime.isPlaying("l3")).toBe(false); // band 40 ikut tergantikan
    expect(h.runtime.isPlaying("l4")).toBe(false); // band 30 ikut tergantikan
  });

  it("native clip tidak mengganggu layer DSL (paritas)", async () => {
    const reg = new MotionRegistry();
    reg.register(makeAsset("m", { priority: 80 }));
    reg.register(
      makeAsset("motion_idle", { source: "native", type: "motion3", tracks: [] })
    );
    let nativeGroup = "";
    let fakeNow = 0;
    const bridge = {
      now: () => fakeNow,
      getPoseBase: () => ({}),
      applyPoseDelta: () => {},
      clearPoseDelta: () => {},
      applyParamDrive: () => {},
      releaseParamDrive: () => {},
      playNative: (g: string) => { nativeGroup = g; },
    };
    const runtime = new MotionRuntime(reg, bridge as any);
    expect(runtime.play("m")).toBe(true);
    expect(runtime.play("motion_idle")).toBe(true);
    expect(nativeGroup).toBe("idle");
    expect(runtime.isPlaying("m")).toBe(true); // layer DSL tetap ada
  });
});
