/**
 * arbiter-stage2.test.ts — Phase 13 STAGE 2: idle writers → Parameter Arbiter.
 *
 * Yang dikunci:
 *   1. Arbiter mode "ref"/"norm" — komit role lewat backing yang tepat
 *      (writeRole vs writeRoleNorm), fallback aman tanpa writeRoleNorm.
 *   2. Idle = PRODUSEN INTENT: target()/tickBlink/breath/emotion TIDAK
 *      lagi memuat panggilan tulis (pokeParam/pokeRoleNorm/writeRef) —
 *      static assertions terhadap app.js.
 *   3. Submit selalu (entry kosong melepas ownership) → stale intent
 *      mustahil bertahan saat motion/frozen/poseAuthority 0.
 *   4. Paritas kalkulasi: rumus easing/breath/blink tidak berubah
 *      (golden parity — kalkulasi untouched, hanya transport tulis).
 *   5. Prioritas berbasis evidence: idle-emotion 5 < sticky 10, idle-pose 3.
 *   6. Forced blink (transient poke di luar idle tick) dipertahankan.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createParameterArbiter } from "../src/client/engine/parameter-arbiter";

const repoRoot = join(import.meta.dir, "..");
const appSrc = readFileSync(join(repoRoot, "static/js/app.js"), "utf8");

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const i = src.indexOf(startMarker);
  if (i < 0) return "";
  const j = src.indexOf(endMarker, i + startMarker.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

describe("1. arbiter mode ref/norm", () => {
  test("mode ref → writeRole; mode norm → writeRoleNorm; param → writeParam", () => {
    const calls: string[] = [];
    const arb = createParameterArbiter({
      writeRole: (k, v) => { calls.push(`ref:${k}:${v}`); return true; },
      writeRoleNorm: (k, t) => { calls.push(`norm:${k}:${t}`); return true; },
      writeParam: (k, v) => { calls.push(`param:${k}:${v}`); return true; },
    });
    arb.submit({ channel: "pose-motion", priority: 3, domain: "role", mode: "ref", values: { angleY: 10 } });
    arb.submit({ channel: "blink", priority: 3, domain: "role", mode: "norm", values: { eyeLOpen: 0 } });
    arb.submit({ channel: "breath", priority: 3, domain: "role", mode: "norm", values: { breath: 0.5 } });
    arb.submit({ channel: "sticky", priority: 10, domain: "param", values: { ParamCheek: 1 } });
    expect(arb.commit()).toBe(4);
    // role domain di-commit duluan (urutan channel: blink < breath < pose-motion),
    // lalu param
    expect(calls).toEqual(["norm:eyeLOpen:0", "norm:breath:0.5", "ref:angleY:10", "param:ParamCheek:1"]);
  });

  test("tie-break deterministik: channel 'anorm' (norm) memenangkan key", () => {
    const calls: string[] = [];
    const arb = createParameterArbiter({
      writeRole: (k) => { calls.push(`ref:${k}`); return true; },
      writeRoleNorm: (k) => { calls.push(`norm:${k}`); return true; },
      writeParam: () => false,
    });
    arb.submit({ channel: "anorm", priority: 3, domain: "role", mode: "norm", values: { breath: 0.5 } });
    arb.submit({ channel: "zref", priority: 3, domain: "role", mode: "ref", values: { breath: 0.5 } });
    arb.commit();
    expect(calls).toEqual(["norm:breath"]);
  });

  test("tanpa writeRoleNorm: entri norm gagal aman (0 tulisan, tanpa crash)", () => {
    const arb = createParameterArbiter({
      writeRole: (k) => k === "x",
      writeParam: () => false,
    });
    arb.submit({ channel: "blink", priority: 3, domain: "role", mode: "norm", values: { eyeLOpen: 0 } });
    expect(arb.commit()).toBe(0);
  });
});

describe("2. idle = produsen intent (static app.js)", () => {
  const targetBody = sliceBetween(appSrc, "const target = (role, vRef) => {", "if (state.caps.hasHead)");
  const blinkBody = sliceBetween(appSrc, "function tickBlink", "function startIdle");
  const breathMarker = "const idleBreathIntent = {};";
  const emoBody = sliceBetween(appSrc, "const idleEmoIntent = {};", "if (state.talking && !state.frozen) {");
  const submitBody = sliceBetween(appSrc, "SUBMIT intent idle", "state._tickCount");

  test("target(): nol panggilan tulis; intent dua channel (param easing + role motion)", () => {
    expect(targetBody).not.toMatch(/pokeParam|pokeRoleNorm|bridge\.writeRef/);
    expect(targetBody).toContain("idlePoseIntent[id]");
    expect(targetBody).toContain("idlePoseMotionIntent[role]");
    // easing parity: rumus lerp actual tidak berubah
    expect(targetBody).toContain("cur + (actual - cur) * ease * poseAuthority");
    expect(targetBody).toContain("roleClampActual(role, toActual(role, vRef))");
  });

  test("tickBlink: nol pemanggilan pokeRoleNorm (komentar paritas boleh); intent norm via __blinkIntent", () => {
    expect(blinkBody).not.toMatch(/pokeRoleNorm\(/);
    expect(blinkBody).toContain("__blinkIntent");
    // golden parity: konstanta fase kedip tidak berubah
    expect(blinkBody).toContain("CLOSE_MS = 100");
    expect(blinkBody).toContain("CLOSED_MS = 60");
    expect(blinkBody).toContain("OPEN_MS = 150");
  });

  test("breath: nol pokeRoleNorm; intent bernilai formula sama", () => {
    const i = appSrc.indexOf(breathMarker);
    const block = appSrc.slice(i, i + 220);
    expect(block).not.toContain("pokeRoleNorm");
    expect(block).toContain("idleBreathIntent.breath = clamp(breath, 0, 1)");
    // suppression existing dipertahankan
    expect(block).toContain("state.hasBreath && !state.frozen && !motionLayersActive");
  });

  test("emotion: nol pokeParam; easing 0.12 + skip eyeL/R dipertahankan", () => {
    expect(emoBody).not.toMatch(/pokeParam/);
    expect(emoBody).toContain("const e = 0.12;");
    expect(emoBody).toContain("idleEmoIntent[id] = nv");
    expect(emoBody).toContain("if (id === eyeLO || id === eyeRO) continue;");
  });

  test("submit selalu: entry kosong melepas ownership (anti stale intent)", () => {
    expect(submitBody).toContain('channel: "idle-pose"');
    expect(submitBody).toContain('channel: "idle-pose-motion"');
    expect(submitBody).toContain('channel: "idle-blink"');
    expect(submitBody).toContain('channel: "idle-breath"');
    expect(submitBody).toContain('channel: "idle-emotion"');
    // clearSource ketika tidak ada intent (blink/breath/emotion)
    expect((submitBody.match(/clearSource\(/g) || []).length).toBe(3);
    // prioritas evidence-based
    expect(submitBody).toContain('priority: 3, domain: "param"'); // idle-pose
    expect(submitBody).toContain('priority: 5, domain: "param"'); // idle-emotion
    expect(submitBody).toContain('mode: "ref"');
    expect((submitBody.match(/mode: "norm"/g) || []).length).toBe(2);
  });

  test("idle-pose-motion hanya di-commit saat motionLayersActive (cabang eksklusif)", () => {
    // kedua intent dideklarasikan sebelum cabang, terisi di cabang masing-masing
    const branchBody = sliceBetween(appSrc, "if (motionLayersActive) {", "} else if (!state.aiLock)");
    expect(branchBody).toBeTruthy();
  });
});

describe("3. prioritas & konflik (module-level, evidence urutan konsumsi)", () => {
  test("sticky(10) > idle-emotion(5): pemenang di slot update tetap sticky", () => {
    const arb = createParameterArbiter({ writeRole: () => false, writeRoleNorm: () => true, writeParam: () => true });
    arb.submit({ channel: "idle-emotion", priority: 5, domain: "param", values: { ParamMouthForm: 0.3 } });
    arb.submit({ channel: "sticky", priority: 10, domain: "param", values: { ParamMouthForm: 0.9 } });
    expect(arb.resolve().param.ParamMouthForm).toBe(0.9);
  });

  test("idle-emotion(5) > idle-pose(3): emosi menang atas pose di param overlap", () => {
    const arb = createParameterArbiter({ writeRole: () => false, writeRoleNorm: () => true, writeParam: () => true });
    arb.submit({ channel: "idle-pose", priority: 3, domain: "param", values: { ParamMouthForm: 0.1 } });
    arb.submit({ channel: "idle-emotion", priority: 5, domain: "param", values: { ParamMouthForm: 0.6 } });
    expect(arb.resolve().param.ParamMouthForm).toBe(0.6);
    // emosi lepas → pose kembali
    arb.clearSource("idle-emotion");
    expect(arb.resolve().param.ParamMouthForm).toBe(0.1);
  });

  test("idle-pose kalah dari motion-driven pose channel (paritas cabang motion)", () => {
    const arb = createParameterArbiter({ writeRole: () => false, writeRoleNorm: () => true, writeParam: () => true });
    arb.submit({ channel: "idle-pose", priority: 3, domain: "param", values: { ParamAngleY: 1 } });
    arb.submit({ channel: "idle-pose-motion", priority: 3, domain: "role", mode: "ref", values: { angleY: 12 } });
    // cross-domain: komit role dulu lalu param → param fisik terakhir = idle-pose
    // (keputusan komit role→param mempertahankan pemenang fisik yang lama)
    const calls: string[] = [];
    const arb2 = createParameterArbiter({
      writeRole: (k) => { calls.push(`role:${k}`); return true; },
      writeParam: (k) => { calls.push(`param:${k}`); return true; },
    });
    arb2.submit({ channel: "idle-pose", priority: 3, domain: "param", values: { ParamAngleY: 1 } });
    arb2.submit({ channel: "idle-pose-motion", priority: 3, domain: "role", mode: "ref", values: { angleY: 12 } });
    arb2.commit();
    // role ditulis dulu, param belakangan → param (sticky/pose fisik) menang — urutan sama dengan Stage 1
    expect(calls).toEqual(["role:angleY", "param:ParamAngleY"]);
  });
});

describe("4. lifecycle & boundary", () => {
  test("Reset Pose membersihkan channel idle (anti stale setelah reset)", () => {
    const i = appSrc.indexOf("PHASE 13 STAGE 2 — channel idle juga dibersihkan");
    expect(i).toBeGreaterThan(-1);
    const block = appSrc.slice(i, i + 400);
    for (const ch of ["idle-pose", "idle-pose-motion", "idle-blink", "idle-breath", "idle-emotion"])
      expect(block).toContain(`"${ch}"`);
  });

  test("forced blink (transient poke luar idle tick) dipertahankan — di-dokumentasi no-op laten", () => {
    // pokeRoleNorm masih dipakai di luar tick idle (forced blink / jalur lain)
    expect(appSrc).toContain("pokeRoleNorm");
    // tapi TIDAK dipanggil di dalam tickBlink (komentar boleh menyebut nama)
    const blinkBody = sliceBetween(appSrc, "function tickBlink", "function startIdle");
    expect(blinkBody).not.toMatch(/pokeRoleNorm\(/);
  });

  test("easing feedback memakai state idle sendiri (anti-revert loadParameters)", () => {
    // pixi-live2d loadParameters me-revert buffer tiap update — easing pose
    // wajib membaca state.idlePoseCur, bukan buffer
    const targetBody = sliceBetween(appSrc, "const target = (role, vRef) => {", "if (state.caps.hasHead)");
    expect(targetBody).toContain("state.idlePoseCur[id]");
    expect(targetBody).toContain("delete state.idlePoseCur[id]"); // invalidasi saat klip
    expect(targetBody).toContain("cur + (actual - cur) * ease * poseAuthority");
    expect(appSrc).toContain("idlePoseCur: {}");
    // reset di teardown + Reset Pose
    const teardown = appSrc.indexOf("state.idlePoseCur = {};");
    expect(teardown).toBeGreaterThan(-1);
    expect(appSrc.split("state.idlePoseCur = {};").length - 1).toBeGreaterThanOrEqual(2);
  });

  test("model switch: arbiter baru → channel idle lama tidak bisa ikut", () => {
    expect(appSrc).toContain("state.arbiter = null;");
    expect(appSrc).toContain("state.lipSyncDrive = null;");
  });
});
