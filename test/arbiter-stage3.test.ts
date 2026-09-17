/**
 * arbiter-stage3.test.ts — Phase 13 STAGE 3: native motion/expression gate
 * + blink fix.
 *
 * Yang dikunci:
 *   1. BLINK FIX: tickBlink men-submit intent dengan ROLE NAME ("eyeLOpen")
 *      — komit writeRoleNorm mengenali role (closed → open terbukti menulis).
 *      Tanpa pokeRoleNorm; rumus/fase tidak berubah.
 *   2. GERBANG NATIVE MOTION: window poseAuthority mengikuti
 *      motionManager.isFinished() (rolling +450 ms), tebakan lama menjadi
 *      window minimum; cleanup mereset clipUntil + clipGateUntil.
 *   3. INVARIANT arbiter (regression): role commit SEBELUM param commit
 *      (urutan terkunci — mengubahnya mengubah pemenang fisik), priority
 *      tertinggi menang dalam domain, empty submit/clearSource melepas
 *      ownership, teardown bersih.
 *   4. Expression: framework-owned (tanpa channel duplikat) — ownership
 *      arbiter pada param miliknya dibuktikan di Stage 1/2 + E2E.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { createParameterArbiter } from "../src/client/engine/parameter-arbiter";

const repoRoot = join(import.meta.dir, "..");
const appSrc = readFileSync(join(repoRoot, "static/js/app.js"), "utf8");

function extractFn(src: string, name: string): string | null {
  const m = src.match(new RegExp("\\bfunction\\s+" + name + "\\s*\\("));
  if (!m) return null;
  let i = src.indexOf("{", m.index), depth = 0, inStr: string | null = null, esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (!depth) return src.slice(src.lastIndexOf("function", m.index + 1), i + 1); }
  }
  return null;
}

describe("1. blink fix — role name, closed → open, tanpa pokeRoleNorm", () => {
  const blinkSrc = extractFn(appSrc, "tickBlink")!;
  test("tickBlink ada dan bebas pokeRoleNorm(", () => {
    expect(blinkSrc).toBeTruthy();
    expect(blinkSrc).not.toMatch(/pokeRoleNorm\(/);
  });

  test("key intent = ROLE NAME (eyeLOpen/eyeROpen), bukan param id", () => {
    expect(blinkSrc).toContain('role: "eyeLOpen"');
    expect(blinkSrc).toContain('role: "eyeROpen"');
    expect(blinkSrc).toContain("blinkIntent[e.role]");
    expect(blinkSrc).not.toContain("blinkIntent[id]");
  });

  test("perilaku vm: closed → open menulis intent role name dengan urutan fase", () => {
    // roleId memetakan role name → param id (seperti caps.ids); writeNorm
    // nyata mengenali ROLE NAME (bukti probe Stage 3) — mock mengikuti itu.
    const state: any = {
      model: {},
      blinkEnabled: true,
      frozen: false,
      clipUntil: 0,
      blinkState: null,
      blinkNext: 0.05, // kedip segera
      __blinkIntent: null,
    };
    const sandbox: any = {
      state,
      roleId: (role: string) => (role === "eyeLOpen" ? "ParamEyeLOpen" : role === "eyeROpen" ? "ParamEyeROpen" : null),
      performance: { now: () => 1000 },
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(blinkSrc, sandbox);
    const runs: Array<{ keys: string[]; vals: Record<string, number> }> = [];
    const step = (dt: number) => {
      vm.runInContext(`tickBlink(${dt})`, sandbox);
      const bi = state.__blinkIntent;
      runs.push({ keys: bi ? Object.keys(bi) : [], vals: bi ? { ...bi } : {} });
    };
    step(0.05); // trigger kedip (blinkNext habis) — belum menulis
    step(0.03); // fase close: v = 1 - 30/100 = 0.7
    step(0.08); // close selesai → 0
    step(0.07); // closed → 0 lalu transisi open
    step(0.02); // open naik
    for (let i = 0; i < 10; i++) step(0.05); // selesai → pulih 1, channel kosong
    const nonEmpty = runs.filter((r) => r.keys.length);
    expect(nonEmpty.length).toBeGreaterThan(3);
    // SEMUA key = ROLE NAME (bukan param id) — inti blink fix
    for (const r of nonEmpty) expect(r.keys.sort()).toEqual(["eyeLOpen", "eyeROpen"]);
    // closed → 0, pulih → 1 (closed→open terbukti MENULIS)
    const vals = nonEmpty.map((r) => r.vals.eyeLOpen);
    expect(Math.min(...vals)).toBe(0);
    expect(vals[vals.length - 1]).toBe(1);
    expect(state.__blinkIntent).toEqual({}); // di antara kedip: ownership lepas
  });

  test("komit idle-blink lewat writeRoleNorm — parameter api boundary", () => {
    const normCalls: Array<[string, number]> = [];
    const arb = createParameterArbiter({
      writeRole: () => false,
      writeRoleNorm: (role, t) => { normCalls.push([role, t]); return true; },
      writeParam: () => false,
    });
    arb.submit({ channel: "idle-blink", priority: 3, domain: "role", mode: "norm", values: { eyeLOpen: 0 } });
    arb.commit();
    expect(normCalls).toEqual([["eyeLOpen", 0]]);
  });
});

describe("2. gerbang native motion (static app.js)", () => {
  test("gate membaca motionManager.isFinished dan rolling +450 ms", () => {
    expect(appSrc).toContain("mmGate.isFinished");
    expect(appSrc).toContain("state.clipGateUntil = nowG + 450");
    expect(appSrc).toContain("state.clipGateStartedAt = nowG");
    expect(appSrc).toContain("Math.max(\n        state.clipUntil || 0,\n        state.clipGateUntil || 0,\n      )");
  });

  test("gaze user segar → gate rolling TIDAK diperpanjang (mouse-follow menang atas idle native)", () => {
    // Regresi 2026-09-17: rolling gate +450 ms ikut memperpanjang poseAuthority
    // = 0 selama klip idle native (auto-start 7 dtk) → intent mouse dibuang.
    // Fix: gate hanya diperpanjang saat gaze user TIDAK segar.
    const gateIdx = appSrc.indexOf(
      "const motionPlaying = state.handle ? !state.handle.isMotionFinished() : false;",
    );
    expect(gateIdx).toBeGreaterThan(-1);
    const gateEnd = appSrc.indexOf("let poseAuthority = 1;", gateIdx);
    expect(gateEnd).toBeGreaterThan(gateIdx);
    const gateBody = appSrc.slice(gateIdx, gateEnd);

    // Deterministik: eksekusi blok gate persis seperti di app.js dengan waktu
    // dan state tiruan — tanpa browser, tanpa rAF.
    const runGate = (state: any, nowMs: number, dateNow: number) => {
      const sandbox: any = {
        state,
        performance: { now: () => nowMs },
        Date: { now: () => dateNow },
      };
      vm.createContext(sandbox);
      vm.runInContext(gateBody, sandbox);
    };
    const mkState = (lookUserAt: number | null) => ({
      handle: { isMotionFinished: () => false },
      clipGateUntil: 0,
      clipGateStartedAt: 0,
      lookUserAt,
    });

    // Gaze segar (mouse digerakkan 500 ms lalu) → gate TIDAK diperpanjang.
    const fresh: any = mkState(1_000_000 - 500);
    vm.runInContext(gateBody, vm.createContext({ state: fresh, performance: { now: () => 1_000_000 }, Date: { now: () => 1_000_000 } }));
    expect(fresh.clipGateUntil).toBe(0);
    expect(fresh.clipGateStartedAt).toBe(0);

    // Gaze basi (tidak pernah gerak) → rolling +450 ms tetap jalan.
    const stale: any = mkState(null);
    vm.runInContext(gateBody, vm.createContext({ state: stale, performance: { now: () => 1_000_000 }, Date: { now: () => 1_000_000 } }));
    expect(stale.clipGateUntil).toBe(1_000_450);
    expect(stale.clipGateStartedAt).toBe(1_000_000);
  });

  test("tebakan durasi lama menjadi window minimum (playNative/playEmotionClip tidak diubah)", () => {
    expect(appSrc).toContain("state.clipUntil = state.clipStartedAt + 2200 + 250;"); // playNative
    expect(appSrc).toContain("state.clipUntil = state.clipStartedAt + dur;"); // playEmotionClip
  });

  test("cleanup mereset kedua window; teardown model mereset gate", () => {
    expect(appSrc).toContain("state.clipGateUntil = 0;\n          state.clipName = null;");
    const teardownIdx = appSrc.indexOf("state.clipGateUntil = 0;\n      state.clipGateStartedAt = 0;");
    expect(teardownIdx).toBeGreaterThan(-1);
  });

  test("blink clipOwns tetap membaca clipUntil (scope — perubahan terdokumentasi)", () => {
    const blinkSrc = extractFn(appSrc, "tickBlink")!;
    expect(blinkSrc).toContain("state.clipUntil && performance.now() < state.clipUntil");
  });
});

describe("3. invariant arbiter (regression Stage 0–2)", () => {
  test("urutan komit terkunci: role SEBELUM param (mengubah urutan = mengubah pemenang fisik)", () => {
    const calls: string[] = [];
    const arb = createParameterArbiter({
      writeRole: (k) => { calls.push("role:" + k); return true; },
      writeRoleNorm: (k) => { calls.push("norm:" + k); return true; },
      writeParam: (k) => { calls.push("param:" + k); return true; },
    });
    arb.submit({ channel: "idle-pose-motion", priority: 3, domain: "role", mode: "ref", values: { angleY: 12 } });
    arb.submit({ channel: "sticky", priority: 10, domain: "param", values: { ParamAngleY: 8 } });
    arb.commit();
    // urutan inilah yang membuat sticky (param) menang atas pose (role) pada
    // param fisik yang sama — perilaku existing sejak Stage 1
    expect(calls).toEqual(["role:angleY", "param:ParamAngleY"]);
  });

  test("priority tertinggi menang dalam domain yang sama", () => {
    const arb = createParameterArbiter({
      writeRole: () => true, writeRoleNorm: () => true, writeParam: () => true,
    });
    arb.submit({ channel: "idle-pose", priority: 3, domain: "param", values: { PX: 1 } });
    arb.submit({ channel: "idle-emotion", priority: 5, domain: "param", values: { PX: 2 } });
    arb.submit({ channel: "sticky", priority: 10, domain: "param", values: { PX: 3 } });
    arb.submit({ channel: "lipsync", priority: 20, domain: "param", values: { PX: 4 } });
    arb.submit({ channel: "rawDrive", priority: 30, domain: "param", values: { PX: 5 } });
    expect(arb.resolve().param.PX).toBe(5);
    arb.clearSource("rawDrive");
    expect(arb.resolve().param.PX).toBe(4);
    arb.clearSource("lipsync");
    expect(arb.resolve().param.PX).toBe(3);
  });

  test("empty submit & clearSource melepas ownership; unknown/NaN aman", () => {
    const arb = createParameterArbiter({ writeRole: () => false, writeRoleNorm: () => false, writeParam: () => false });
    arb.submit({ channel: "idle-pose", priority: 3, domain: "param", values: { PX: 1 } });
    arb.submit({ channel: "idle-pose", priority: 3, domain: "param", values: {} }); // kosong = release
    expect(arb.hasSource("idle-pose")).toBe(true); // channel terdaftar, tanpa nilai
    expect(arb.resolve().param.PX).toBeUndefined();
    arb.submit({ channel: "idle-pose", priority: 3, domain: "param", values: { PX: NaN, PY: 2 } });
    expect(arb.resolve().param).toEqual({ PY: 2 }); // NaN ditolak per-key
    arb.clearSource("idle-pose");
    expect(arb.resolve().param).toEqual({});
  });
});

describe("4. expression — framework-owned (tanpa channel duplikat)", () => {
  test("tidak ada channel expression di arbiter wiring app.js; resetEmotion tetap jalur ekspresi", () => {
    expect(appSrc).not.toContain('channel: "expression"');
    expect(appSrc).toContain("resetExpression"); // lifecycle ekspresi tetap framework
  });
});
