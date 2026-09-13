/**
 * parameter-arbiter.test.ts — Phase 13 STAGE 0: fondasi Parameter Arbiter.
 *
 * Yang dikunci:
 *   1–9.  Semantik resolusi: priority menang per target, tie-break
 *         deterministik (nama channel), nilai 0 tetap owner, isolasi per
 *         parameter, dua domain (role vs raw param) terpisah, clear.
 *   11–14. Sanitasi (NaN/Infinity ditolak), resolve deterministik.
 *   15–16. commit HANYA lewat backing yang disuntik (ParameterApi) — nol
 *         tulis core langsung di modul.
 *   17.  Kontrak frame-order: framework writers → arbiter commit →
 *        coreModel.update → render (mock pipeline + static wiring app.js).
 *   PR.  Paritas ownership MotionRuntime `combinedDelta` (60 vs 80,
 *        same-band replace, multi layer, field bernilai 0, layer removal).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createParameterArbiter } from "../src/client/engine/parameter-arbiter";
import { MotionRegistry } from "../src/client/animation/motion-registry";
import { MotionRuntime } from "../src/client/animation/motion-runtime";
import type { MotionAsset } from "../src/shared/types";

const repoRoot = join(import.meta.dir, "..");

function makeBacking() {
  const writes: { kind: "role" | "param"; key: string; v: number }[] = [];
  const backing = {
    writeRole: (k: string, v: number) => {
      writes.push({ kind: "role", key: k, v });
      return true;
    },
    writeParam: (k: string, v: number) => {
      writes.push({ kind: "param", key: k, v });
      return true;
    },
  };
  return { backing, writes };
}

describe("resolusi dasar (param domain)", () => {
  test("1–2. priority lebih tinggi menang; lebih rendah kalah", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "idle", priority: 20, domain: "param", values: { ParamBreath: 0.5 } });
    arb.submit({ channel: "motion", priority: 80, domain: "param", values: { ParamBreath: 0.9 } });
    expect(arb.resolve().param["ParamBreath"]).toBe(0.9);
    // balik urutan submit — hasil sama (priority, bukan urutan)
    const arb2 = createParameterArbiter(makeBacking().backing);
    arb2.submit({ channel: "motion", priority: 80, domain: "param", values: { ParamBreath: 0.9 } });
    arb2.submit({ channel: "idle", priority: 20, domain: "param", values: { ParamBreath: 0.5 } });
    expect(arb2.resolve().param["ParamBreath"]).toBe(0.9);
  });

  test("3. priority sama → tie-break deterministik (nama channel)", () => {
    const a = createParameterArbiter(makeBacking().backing);
    a.submit({ channel: "zeta", priority: 60, domain: "param", values: { P: 1 } });
    a.submit({ channel: "alpha", priority: 60, domain: "param", values: { P: 2 } });
    expect(a.resolve().param.P).toBe(2); // "alpha" < "zeta"
    const b = createParameterArbiter(makeBacking().backing);
    b.submit({ channel: "alpha", priority: 60, domain: "param", values: { P: 2 } });
    b.submit({ channel: "zeta", priority: 60, domain: "param", values: { P: 1 } });
    expect(b.resolve().param.P).toBe(2);
    expect(a.resolve()).toEqual(b.resolve());
  });

  test("4. nilai 0 tetap pemilik valid", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "top", priority: 80, domain: "param", values: { P: 0 } });
    arb.submit({ channel: "low", priority: 20, domain: "param", values: { P: 0.7 } });
    expect(arb.resolve().param.P).toBe(0);
  });

  test("5. isolasi per parameter — channel lain di param sama tak menimpa yang lebih tinggi", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "a", priority: 80, domain: "param", values: { PX: 1, PY: 1 } });
    arb.submit({ channel: "b", priority: 40, domain: "param", values: { PY: 2, PZ: 2 } });
    const r = arb.resolve().param;
    expect(r.PX).toBe(1);
    expect(r.PY).toBe(1);
    expect(r.PZ).toBe(2);
  });

  test("same-band replace: resubmit channel sama menggantikan penuh", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "motion", priority: 80, domain: "param", values: { PX: 1, PY: 1 } });
    arb.submit({ channel: "motion", priority: 80, domain: "param", values: { PX: 9 } });
    const r = arb.resolve().param;
    expect(r.PX).toBe(9);
    expect(r.PY).toBeUndefined(); // entry lama diganti seluruhnya
  });
});

describe("dua domain: role vs raw param", () => {
  test("6–7. role dan param namespace terpisah; keduanya resolve", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "aiPose", priority: 40, domain: "role", values: { angleX: 12 } });
    arb.submit({ channel: "sticky", priority: 100, domain: "param", values: { ParamMouthOpenY: 0.7 } });
    const r = arb.resolve();
    expect(r.role.angleX).toBe(12);
    expect(r.param.ParamMouthOpenY).toBe(0.7);
    // role 40 kalah dari role 80 di domain role, tapi tak terpengaruh param
    arb.submit({ channel: "motion", priority: 80, domain: "role", values: { angleX: -5 } });
    expect(arb.resolve().role.angleX).toBe(-5);
    expect(arb.resolve().param.ParamMouthOpenY).toBe(0.7);
  });

  test("8. multiple parameters satu channel", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({
      channel: "idle",
      priority: 20,
      domain: "role",
      values: { angleX: 1, angleY: 2, eyeBallX: 0.3, bodyAngleZ: -4 },
    });
    const r = arb.resolve().role;
    expect(r).toEqual({ angleX: 1, angleY: 2, eyeBallX: 0.3, bodyAngleZ: -4 });
  });
});

describe("clear / teardown", () => {
  test("9. clearSource menghapus channel dan ownership-nya", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "motion", priority: 80, domain: "role", values: { angleX: 9 } });
    arb.submit({ channel: "idle", priority: 20, domain: "role", values: { angleX: 1 } });
    expect(arb.resolve().role.angleX).toBe(9);
    expect(arb.clearSource("motion")).toBe(true);
    expect(arb.hasSource("motion")).toBe(false);
    expect(arb.resolve().role.angleX).toBe(1); // kembali ke channel di bawahnya
  });

  test("10. clearAll mengosongkan semua channel (model switch)", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "a", priority: 80, domain: "role", values: { angleX: 1 } });
    arb.submit({ channel: "b", priority: 90, domain: "param", values: { PX: 2 } });
    arb.clearAll();
    expect(arb.sourceCount()).toBe(0);
    expect(arb.resolve()).toEqual({ role: {}, param: {} });
  });

  test("clearTarget menghapus satu key; channel kosong ikut hilang", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "c", priority: 50, domain: "param", values: { PX: 1, PY: 2 } });
    expect(arb.clearTarget("c", "param", "PX")).toBe(true);
    expect(arb.resolve().param.PX).toBeUndefined();
    expect(arb.resolve().param.PY).toBe(2);
    expect(arb.clearTarget("c", "param", "PY")).toBe(true);
    expect(arb.hasSource("c")).toBe(false);
  });
});

describe("sanitasi & determinisme", () => {
  test("12–13. NaN dan Infinity ditolak per-key (owner tidak tercemar)", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    const res = arb.submit({
      channel: "llm",
      priority: 80,
      domain: "role",
      values: { angleX: NaN, angleY: Infinity, angleZ: -Infinity, bodyAngleZ: 3 },
    });
    expect(res.accepted).toBe(1);
    expect(res.rejected.sort()).toEqual(["angleX", "angleY", "angleZ"]);
    expect(arb.resolve().role).toEqual({ bodyAngleZ: 3 });
  });

  test("14. resolve deterministik — panggil ulang hasil identik, commit tidak mengubah state", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "b", priority: 60, domain: "param", values: { PX: 1 } });
    arb.submit({ channel: "a", priority: 60, domain: "param", values: { PX: 2, PY: 5 } });
    const r1 = arb.resolve();
    arb.commit();
    const r2 = arb.resolve();
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(arb.orderedChannels("param")).toEqual(["a", "b"]); // tie-break stabil
  });

  test("submit invalid (channel kosong / domain asing / priority NaN) ditolak keras", () => {
    const arb = createParameterArbiter(makeBacking().backing);
    expect(() => arb.submit({ channel: "", priority: 1, domain: "param", values: {} })).toThrow();
    expect(() => arb.submit({ channel: "x", priority: NaN, domain: "param", values: {} })).toThrow();
    expect(() =>
      arb.submit({ channel: "x", priority: 1, domain: "walau" as any, values: {} }),
    ).toThrow();
  });
});

describe("commit — single write point via backing (15–16)", () => {
  test("15. commit menulis final value lewat backing (ParameterApi), role & param", () => {
    const { backing, writes } = makeBacking();
    const arb = createParameterArbiter(backing);
    arb.submit({ channel: "motion", priority: 80, domain: "role", values: { angleX: -5 } });
    arb.submit({ channel: "sticky", priority: 100, domain: "param", values: { ParamCheek: 1 } });
    const n = arb.commit();
    expect(n).toBe(2);
    // urutan tulis deterministik: key terurut
    expect(writes[0]).toEqual({ kind: "role", key: "angleX", v: -5 });
    expect(writes[1]).toEqual({ kind: "param", key: "ParamCheek", v: 1 });
  });

  test("16. arbiter tanpa backing tulis tidak menyentuh apa pun; backing gagal = safe", () => {
    const arb = createParameterArbiter({ writeRole: () => false, writeParam: () => false });
    arb.submit({ channel: "x", priority: 80, domain: "param", values: { ParamUnknown: 5 } });
    expect(arb.commit()).toBe(0); // unknown param → backing false → no crash
    // modul sumber bebas tulis core langsung (komentar bebas token setter juga)
    const src = readFileSync(join(repoRoot, "src/client/engine/parameter-arbiter.ts"), "utf8");
    expect(src.match(/setParameterValue|setPartOpacity|addParameterValue/g)).toBeNull();
  });
});

describe("17. kontrak frame-order (mock pipeline)", () => {
  test("framework writers → arbiter commit → coreModel.update → render", () => {
    const order: string[] = [];
    const core: Record<string, number> = {};
    const arb = createParameterArbiter({
      writeRole: (k, v) => {
        order.push(`arbiter:role:${k}`);
        core["role:" + k] = v;
        return true;
      },
      writeParam: (k, v) => {
        order.push(`arbiter:param:${k}`);
        core["param:" + k] = v;
        return true;
      },
    });
    arb.submit({ channel: "motion", priority: 80, domain: "param", values: { ParamMouthOpenY: 0.7 } });
    arb.submit({ channel: "aiPose", priority: 40, domain: "role", values: { angleX: 12 } });

    // ── satu frame sesuai kontrak pipeline internalModel.update ──
    order.push("framework:native-motion");
    core["param:ParamMouthOpenY"] = 0.1; // native menulis dulu
    core["param:ParamAngleX"] = 5; // param yang TIDAK dimiliki arbiter
    order.push("framework:physics");
    arb.commit(); // slot beforeModelUpdate
    order.push("coreModel.update");
    order.push("render");

    const iFrame = order.indexOf("framework:native-motion");
    const iCommit = order.findIndex((s) => s.startsWith("arbiter:"));
    const iUpdate = order.indexOf("coreModel.update");
    const iRender = order.indexOf("render");
    expect(iFrame).toBeLessThan(iCommit);
    expect(iCommit).toBeLessThan(iUpdate);
    expect(iUpdate).toBeLessThan(iRender);
    // arbiter menimpa nilai framework untuk target miliknya
    expect(core["param:ParamMouthOpenY"]).toBe(0.7);
    expect(core["role:angleX"]).toBe(12);
    // param yang tidak dimiliki arbiter tidak disentuh
    expect(core["param:ParamAngleX"]).toBe(5);
  });

  test("wiring app.js: commit terpasang di slot beforeModelUpdate, SETELAH re-apply rawDrive", () => {
    const src = readFileSync(join(repoRoot, "static/js/app.js"), "utf8");
    const guardStart = src.indexOf('im.on("beforeModelUpdate"');
    expect(guardStart).toBeGreaterThan(-1);
    const guardBody = src.slice(guardStart, src.indexOf("});", guardStart + 10) + 3);
    const iWriteActual = guardBody.indexOf("link.writeActual(id, v)");
    const iCommit = guardBody.indexOf("state.arbiter.commit()");
    expect(iWriteActual).toBeGreaterThan(-1);
    expect(iCommit).toBeGreaterThan(iWriteActual); // commit SETELAH rawDrive re-apply
    expect(guardBody.split("state.arbiter.commit()").length).toBe(2); // tepat satu
    // instance dibuat per model load, delegasi ke roleLink (ParameterApi)
    expect(src).toContain("window.__l2dArbiter.createArbiter");
    expect(src).toContain("state.roleLink.bridge.writeRef(role, v)");
    expect(src).toContain("state.roleLink.writeActual(id, v)");
    // teardown: arbiter dibuang saat model switch
    const iNull = src.indexOf("state.arbiter = null;");
    const iAttach = src.indexOf("state.roleLink = window.__engineRoleLink");
    expect(iNull).toBeGreaterThan(-1);
    expect(iNull).toBeLessThan(iAttach);
  });
});

// ── PR. Paritas ownership MotionRuntime combinedDelta ────────────────────────
const origRaf = (globalThis as any).requestAnimationFrame;
const origCaf = (globalThis as any).cancelAnimationFrame;
(globalThis as any).requestAnimationFrame = undefined;
(globalThis as any).cancelAnimationFrame = undefined;

function makeAsset(id: string, priority: number, target: string, keys: { t: number; v: number }[]): MotionAsset {
  return {
    version: 1,
    id,
    name: id,
    description: "test",
    tags: [],
    source: "user",
    type: "keyframe",
    duration: 1,
    loop: false,
    intensity: { min: 0.3, max: 1, default: 1 },
    emotionCompatibility: {},
    cooldown: 0,
    priority,
    aiEnabled: true,
    requires: [],
    tracks: [{ kind: "role", target, keys }] as any,
  };
}

function makeRuntimeHarness() {
  let fakeNow = 0;
  const bridge = {
    now: () => fakeNow,
    getPoseBase: () => ({}) as Record<string, number>,
    applyPoseDelta: () => {},
    clearPoseDelta: () => {},
    applyParamDrive: () => {},
    releaseParamDrive: () => {},
  };
  const registry = new MotionRegistry();
  const runtime = new MotionRuntime(registry, bridge as any);
  return { runtime, registry, setTime: (t: number) => { fakeNow = t; } };
}

describe("MotionRuntime parity — ownership combinedDelta vs arbiter", () => {
  test("priority 80 vs 60: dua layer aktif, field masing-masing (parity)", async () => {
    const { runtime, registry, setTime } = makeRuntimeHarness();
    // track KONSTAN — nilai tidak bergantung tSec (timeline runtime memotong
    // blendIn 120 ms), sample jadi deterministik terhadap waktu fake.
    registry.register(makeAsset("hi80", 80, "ay", [{ t: 0, v: 10 }, { t: 1, v: 10 }]));
    registry.register(makeAsset("g60", 60, "ax", [{ t: 0, v: 30 }, { t: 1, v: 30 }]));
    runtime.play("hi80", { priority: 80 });
    runtime.play("g60", { priority: 60 });
    setTime(500); // > blendIn 120 ms → envelope penuh
    await new Promise((r) => setTimeout(r, 30));
    const sample = runtime.sampleForTest();
    expect(sample).not.toBeNull();
    expect(sample!.roles.ax).toBeCloseTo(30, 5);
    expect(sample!.roles.ay).toBeCloseTo(10, 5);

    // arbiter dengan channel ekuivalen → hasil per-field identik
    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "motion:hi80", priority: 80, domain: "role", values: { ay: 10 } });
    arb.submit({ channel: "motion:g60", priority: 60, domain: "role", values: { ax: 30 } });
    expect(arb.resolve().role).toEqual(sample!.roles);
  });

  test("same priority replacement: play baru menggantikan band sama (parity)", async () => {
    const { runtime, registry, setTime } = makeRuntimeHarness();
    // nilai dalam skala referensi role (ax dibatasi ±30 oleh runtime)
    registry.register(makeAsset("a1", 80, "ax", [{ t: 0, v: 10 }, { t: 1, v: 10 }]));
    registry.register(makeAsset("a2", 80, "ax", [{ t: 0, v: 25 }, { t: 1, v: 25 }]));
    runtime.play("a1", { priority: 80 });
    runtime.play("a2", { priority: 80 }); // same-band replace
    setTime(500);
    await new Promise((r) => setTimeout(r, 30));
    const sample = runtime.sampleForTest();
    expect(sample!.roles.ax).toBeCloseTo(25, 5);

    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "motion", priority: 80, domain: "role", values: { ax: 10 } });
    arb.submit({ channel: "motion", priority: 80, domain: "role", values: { ax: 25 } }); // resubmit = replace
    expect(arb.resolve().role.ax).toBeCloseTo(25, 5);
  });

  test("field bernilai 0 tetap owned oleh layer prioritas lebih tinggi (parity)", async () => {
    const { runtime, registry, setTime } = makeRuntimeHarness();
    registry.register(makeAsset("z80", 80, "ax", [{ t: 0, v: 0 }, { t: 0.5, v: 0 }, { t: 1, v: 10 }]));
    registry.register(makeAsset("g60", 60, "ax", [{ t: 0, v: 0 }, { t: 1, v: 30 }]));
    runtime.play("z80", { priority: 80 });
    runtime.play("g60", { priority: 60 });
    setTime(250); // layer 80 sedang di nilai 0 — ownership TIDAK lepas
    await new Promise((r) => setTimeout(r, 30));
    const sample = runtime.sampleForTest();
    expect(sample!.roles.ax).toBe(0);

    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "z80", priority: 80, domain: "role", values: { ax: 0 } });
    arb.submit({ channel: "g60", priority: 60, domain: "role", values: { ax: 15 } });
    expect(arb.resolve().role.ax).toBe(0);
  });

  test("layer removal: stop runtime == clearSource arbiter (parity)", async () => {
    const { runtime, registry, setTime } = makeRuntimeHarness();
    registry.register(makeAsset("g60", 60, "ax", [{ t: 0, v: 0 }, { t: 1, v: 30 }]));
    runtime.play("g60", { priority: 60 });
    setTime(500);
    await new Promise((r) => setTimeout(r, 30));
    expect(runtime.sampleForTest()).not.toBeNull();
    runtime.stop("g60");
    await new Promise((r) => setTimeout(r, 30));
    expect(runtime.sampleForTest()).toBeNull();

    const arb = createParameterArbiter(makeBacking().backing);
    arb.submit({ channel: "g60", priority: 60, domain: "role", values: { ax: 15 } });
    arb.clearSource("g60");
    expect(arb.resolve().role.ax).toBeUndefined();
  });
});
