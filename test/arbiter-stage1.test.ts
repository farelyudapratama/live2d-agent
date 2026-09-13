/**
 * arbiter-stage1.test.ts — Phase 13 STAGE 1: writer override-guard
 * (sticky / rawDrive / lipsync) dimigrasi ke Parameter Arbiter.
 *
 * Yang dikunci:
 *   A. Guard `beforeModelUpdate` DENGAN arbiter: NOL tulis core langsung;
 *      state plane disubmit sebagai channel sticky(10)/lipsync(20)/
 *      rawDrive(30); commit tepat sekali. (vm extraction — pola guard legacy.)
 *   B. Guard TANPA arbiter: fallback legacy menulis langsung (perilaku
 *      fallback identik — harness test-override-guard tetap sah).
 *   C. Precedence antar-channel dari urutan tulis existing:
 *      rawDrive(30) > lipsync(20) > sticky(10).
 *   D. setSticky bukan penulis core lagi (state plane saja).
 *   E. Lifecycle lipsync: release di markDone/mouthTimer/Reset Pose membersihkan
 *      channel + restore via ParameterApi (link) dengan fallback pokeParam.
 *   F. Wiring: idle tidak lagi memanggil applyOverrides() (legacy-only).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { createParameterArbiter } from "../src/client/engine/parameter-arbiter";

const repoRoot = join(import.meta.dir, "..");
const appSrc = readFileSync(join(repoRoot, "static/js/app.js"), "utf8");

// Ambil sumber fungsi top-level by name dengan kurung seimbang (string-aware)
// — pola sama dengan test/legacy/test-override-guard.js.
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

function makeSandbox(withArbiter: boolean) {
  const cmWrites: { id: string; v: unknown; w: unknown }[] = [];
  const cm = {
    setParameterValueById(id: string, v: unknown, w: unknown) {
      cmWrites.push({ id, v, w });
    },
  };
  const commits: number[] = [];
  const arb = createParameterArbiter({
    writeRole: () => false,
    writeParam: () => true,
  });
  const origCommit = arb.commit.bind(arb);
  (arb as any).commit = () => {
    const n = origCommit();
    commits.push(n);
    return n;
  };
  const state: any = {
    overrides: {},
    rawDrive: null,
    lipSyncDrive: null,
    paramRange: {},
    roleLink: null,
    arbiter: withArbiter ? arb : null,
  };
  const listeners: Record<string, Array<() => void>> = {};
  const sandbox: any = {
    state,
    coreModel: () => cm,
    console,
    Number,
    Math,
    Object,
    __listeners: listeners,
    emitBeforeModelUpdate() {
      for (const fn of listeners.beforeModelUpdate || []) fn();
    },
  };
  vm.createContext(sandbox);
  const syncSrc = extractFn(appSrc, "syncGuardChannelsToArbiter")!;
  const guardSrc = extractFn(appSrc, "installOverrideGuard")!;
  vm.runInContext(syncSrc, sandbox);
  vm.runInContext(guardSrc, sandbox);
  vm.runInContext(
    `(function(){
      const im = { __overrideGuard:false, on(ev, fn){ __listeners[ev] = (__listeners[ev]||[]).concat(fn); return im; } };
      installOverrideGuard(im);
    })()`,
    sandbox,
  );
  return { sandbox, state, cmWrites, arb, commits };
}

describe("A. guard + arbiter: nol tulis core, channel tersubmit, commit sekali", () => {
  const s = makeSandbox(true);
  s.state.overrides.ParamCheek = 1;
  s.state.overrides.ParamSkirt = { value: 0.5, weight: 0.7 }; // bentuk objek → .value
  s.state.overrides.ParamBad = NaN;
  s.state.lipSyncDrive = { id: "ParamMouthOpenY", value: 0.6 };
  s.state.rawDrive = { ParamBreath: 0.9, ParamBad2: NaN };
  vm.runInContext("emitBeforeModelUpdate()", s.sandbox);

  test("tidak ada tulisan core langsung dari guard", () => {
    expect(s.cmWrites).toEqual([]);
  });

  test("channel sticky/lipsync/rawDrive tersubmit dengan priority evidence-based", () => {
    expect(s.arb.resolve().param).toEqual({
      ParamCheek: 1,
      ParamSkirt: 0.5,
      ParamMouthOpenY: 0.6,
      ParamBreath: 0.9,
    });
    // NaN tidak masuk channel
    expect(s.arb.resolve().param.ParamBad).toBeUndefined();
    expect(s.arb.resolve().param.ParamBad2).toBeUndefined();
  });

  test("commit dipanggil tepat sekali per frame", () => {
    expect(s.commits).toHaveLength(1);
    vm.runInContext("emitBeforeModelUpdate()", s.sandbox);
    expect(s.commits).toHaveLength(2); // frame berikutnya juga sekali
  });

  test("prioritas: rawDrive(30) > lipsync(20) > sticky(10) — urutan tulis existing", () => {
    // bentrok rawDrive vs sticky di param sama → rawDrive menang
    s.state.rawDrive = { ParamBreath: 0.9 };
    s.state.overrides.ParamBreath = 0.1;
    vm.runInContext("emitBeforeModelUpdate()", s.sandbox);
    expect(s.arb.resolve().param.ParamBreath).toBe(0.9);
    // lipsync menang atas sticky (dulu: last-write-wins di map yang sama)
    s.state.overrides.ParamMouthOpenY = 0.1;
    vm.runInContext("emitBeforeModelUpdate()", s.sandbox);
    expect(s.arb.resolve().param.ParamMouthOpenY).toBe(0.6);
  });
});

describe("B. guard tanpa arbiter: fallback legacy menulis langsung (parity fallback)", () => {
  const s = makeSandbox(false);
  s.state.overrides.ParamCheek = 1;
  s.state.overrides.ParamSkirt = { value: 0.5, weight: 0.7 };
  s.state.rawDrive = { ParamBreath: 0.9 };
  s.state.paramRange = { ParamBreath: { min: 0, max: 1 } };
  vm.runInContext("emitBeforeModelUpdate()", s.sandbox);

  test("sticky + rawDrive fallback menulis core langsung seperti semula", () => {
    const ids = s.cmWrites.map((w) => w.id).sort();
    expect(ids).toEqual(["ParamBreath", "ParamCheek", "ParamSkirt"]);
    const skirt = s.cmWrites.find((w) => w.id === "ParamSkirt");
    expect(skirt).toMatchObject({ v: 0.5, w: 0.7 }); // weight≠1 dipertahankan di jalur legacy
  });
});

describe("C. precedence antar-channel (module-level, evidence urutan tulis)", () => {
  test("sticky vs lipsync: lipsync menang saat bicara", () => {
    const arb = createParameterArbiter({ writeRole: () => false, writeParam: () => true });
    arb.submit({ channel: "sticky", priority: 10, domain: "param", values: { ParamMouthOpenY: 0.2 } });
    arb.submit({ channel: "lipsync", priority: 20, domain: "param", values: { ParamMouthOpenY: 0.8 } });
    expect(arb.resolve().param.ParamMouthOpenY).toBe(0.8);
    // setelah bicara selesai (clearSource) → sticky kembali tampil
    arb.clearSource("lipsync");
    expect(arb.resolve().param.ParamMouthOpenY).toBe(0.2);
  });

  test("sticky vs rawDrive: rawDrive menang (ditulis terakhir di jalur lama)", () => {
    const arb = createParameterArbiter({ writeRole: () => false, writeParam: () => true });
    arb.submit({ channel: "sticky", priority: 10, domain: "param", values: { ParamBreath: 0.2 } });
    arb.submit({ channel: "rawDrive", priority: 30, domain: "param", values: { ParamBreath: 0.9 } });
    expect(arb.resolve().param.ParamBreath).toBe(0.9);
    arb.clearSource("rawDrive");
    expect(arb.resolve().param.ParamBreath).toBe(0.2); // restore = kehilangan ownership
  });

  test("equal priority antar channel tetap deterministik (nama channel)", () => {
    const arb = createParameterArbiter({ writeRole: () => false, writeParam: () => true });
    arb.submit({ channel: "zraw", priority: 30, domain: "param", values: { PX: 1 } });
    arb.submit({ channel: "araw", priority: 30, domain: "param", values: { PX: 2 } });
    expect(arb.resolve().param.PX).toBe(2);
  });
});

describe("D. setSticky bukan penulis core lagi", () => {
  test("setSticky hanya mengisi state.overrides — pokeParam tidak dipanggil", () => {
    const setStickySrc = extractFn(appSrc, "setSticky")!;
    expect(setStickySrc).toContain("state.overrides[id]");
    expect(setStickySrc).not.toContain("pokeParam");
    const pokes: unknown[] = [];
    const sandbox: any = { state: { overrides: {} }, pokeParam: (...a: unknown[]) => pokes.push(a), Number };
    vm.createContext(sandbox);
    vm.runInContext(setStickySrc, sandbox);
    vm.runInContext("setSticky('ParamX', 5, 1)", sandbox);
    expect(sandbox.state.overrides.ParamX).toBe(5);
    expect(pokes).toHaveLength(0);
  });
});

describe("E. lifecycle lipsync — release membersihkan channel + restore ParameterApi", () => {
  test("markDone/mouthTimer: lipSyncDrive dibersihkan + restore via pokeActual (Parameter API dulu)", () => {
    // blok release markDone ditandai komentar Stage 1 (kemunculan pertama
    // "lipSyncDrive = null" adalah teardown loadModel). STAGE 4: restore
    // lewat helper pokeActual (writeActual dulu, pokeParam fallback).
    const markDoneIdx = appSrc.indexOf("PHASE 13 STAGE 1/4 — release lipsync");
    expect(markDoneIdx).toBeGreaterThan(-1);
    const markDoneBlock = appSrc.slice(markDoneIdx, markDoneIdx + 500);
    expect(markDoneBlock).toContain("state.lipSyncDrive = null;");
    expect(markDoneBlock).toContain("pokeActual(mId, rest)");
    // total pembersihan: teardown model + releasePresetPose + markDone + mouthTimer
    const occurrences = appSrc.split("state.lipSyncDrive = null;").length - 1;
    expect(occurrences).toBe(4);
  });

  test("releasePresetPose membersihkan lipsync channel (paritas dengan penghapus map lama)", () => {
    const clearIdx = appSrc.indexOf("for (const id in state.overrides) delete state.overrides[id];");
    const around = appSrc.slice(clearIdx, clearIdx + 300);
    expect(around).toContain("state.lipSyncDrive = null");
  });

  test("getMouth membaca channel lipsync baru", () => {
    const i = appSrc.indexOf("getMouth: () => {");
    const body = appSrc.slice(i, i + 300);
    expect(body).toContain("state.lipSyncDrive");
    expect(body).not.toContain("state.overrides[mId]");
  });
});

describe("F. boundary — jalur runtime tidak lagi memanggil applyOverrides", () => {
  test("applyOverrides hanya definisi legacy + komentar; tidak ada pemanggilan runtime", () => {
    // tidak ada STATEMENT pemanggilan (komentar yang menyebut nama boleh)
    expect(/^\s*applyOverrides\(\);\s*$/m.test(appSrc)).toBe(false);
    expect(extractFn(appSrc, "applyOverrides")).not.toBeNull(); // definisi dipertahankan (guard vm)
  });

  test("idle lipsync menulis state.lipSyncDrive, bukan state.overrides", () => {
    const i = appSrc.indexOf("if (state.talking && !state.frozen) {");
    const block = appSrc.slice(i, i + 900);
    expect(block).toContain("state.lipSyncDrive = {");
    expect(block).not.toContain("state.overrides[mId]");
  });
});
