/**
 * arbiter-stage4.test.ts — Phase 13 STAGE 4: final arbiter enforcement +
 * legacy write cleanup.
 *
 * Yang dikunci:
 *   1. pokeActual: satu titik restore/reset engine — Parameter API dulu
 *      (roleLink.writeActual), pokeParam legacy hanya fallback tanpa link.
 *   2. Semua writer restore/reset (toggle aksesori, release pose default,
 *      reset mulut) memakai pokeActual — bukan cm langsung.
 *   3. clipIsPlaying = window gabungan (clipUntil + clipGateUntil).
 *   4. INVARIANT kontrak: commit role → param. Urutan ini menentukan
 *      pemenang fisik pada param overlap — diuji bahwa urutan terbalik
 *      MEMBALIK pemenang (bukti urutan adalah kontrak, bukan kebetulan).
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

describe("1. pokeActual — satu titik restore/reset (link-first)", () => {
  const pokeActualSrc = extractFn(appSrc, "pokeActual")!;

  test("definisi ada: writeActual dulu, pokeParam hanya fallback", () => {
    expect(pokeActualSrc).toBeTruthy();
    const iActual = pokeActualSrc.indexOf("L.writeActual(id, value)");
    const iFallback = pokeActualSrc.indexOf("pokeParam(id, value, 1)");
    expect(iActual).toBeGreaterThan(-1);
    expect(iFallback).toBeGreaterThan(iActual); // fallback SETELAH jalur kanonik
  });

  test("perilaku vm: link ada → writeActual; link absen → pokeParam; writeActual throw → fallback", () => {
    const run = (link: any, actualThrows = false) => {
      const calls: string[] = [];
      const sandbox: any = {
        state: { roleLink: link },
        pokeParam: (id: string, v: number) => calls.push(`pokeParam:${id}:${v}`),
        console,
      };
      if (link) {
        link.writeActual = (id: string, v: number) => {
          if (actualThrows) throw new Error("boom");
          calls.push(`writeActual:${id}:${v}`);
        };
      }
      vm.createContext(sandbox);
      vm.runInContext(pokeActualSrc, sandbox);
      vm.runInContext("pokeActual('ParamX', 5)", sandbox);
      return calls;
    };
    expect(run({})).toEqual(["writeActual:ParamX:5"]); // link → ParameterApi
    expect(run(null)).toEqual(["pokeParam:ParamX:5"]); // tanpa link → fallback
    expect(run({}, true)).toEqual(["pokeParam:ParamX:5"]); // throw → fallback
  });

  test("semua writer restore/reset memakai pokeActual (bukan cm/pokeParam langsung)", () => {
    // toggle aksesori
    const iToggle = appSrc.indexOf("pokeActual(paramId, next);");
    expect(iToggle).toBeGreaterThan(-1);
    // release pose default (kedua cabang)
    expect(appSrc).toContain("pokeActual(id, def);");
    expect(appSrc).toContain("pokeActual(id, r.def);");
    // reset mulut (markDone + mouthTimer)
    expect((appSrc.match(/pokeActual\(mId, rest\);/g) || []).length).toBe(2);
    // tidak ada lagi cm langsung di kedua blok release default
    expect(appSrc).not.toContain("cm.setParameterValueById(id, def, 1)");
    expect(appSrc).not.toContain("cm.setParameterValueById(id, r.def, 1)");
  });
});

describe("2. clipIsPlaying = window gabungan (clipUntil + clipGateUntil)", () => {
  const clipSrc = extractFn(appSrc, "clipIsPlaying")!;

  test("definisi memakai Math.max kedua window", () => {
    expect(clipSrc).toContain("Math.max(state.clipUntil || 0, state.clipGateUntil || 0)");
  });

  test("perilaku vm: gate masa depan → true walau clipUntil lewat; keduanya lewat → false", () => {
    const run = (clipUntil: number, gate: number) => {
      const sandbox: any = { state: { clipUntil, clipGateUntil: gate }, performance: { now: () => 1000 } };
      vm.createContext(sandbox);
      vm.runInContext(clipSrc, sandbox);
      return vm.runInContext("clipIsPlaying()", sandbox);
    };
    expect(run(500, 2000)).toBe(true); // gerbang memperpanjang
    expect(run(2000, 500)).toBe(true); // tebakan lebih panjang tetap menang
    expect(run(500, 500)).toBe(false); // keduanya selesai
  });
});

describe("3. INVARIANT kontrak: commit role → param (urutan menentukan pemenang fisik)", () => {
  // "Physical core" mock: satu param fisik ParamAngleY ditulis dua jalur —
  // role (angleY via mapping) dan param langsung. Pemenang fisik = tulisan
  // TERAKHIR pada param itu.
  function physicalCommit(order: "actual" | "reversed") {
    const core: Record<string, number> = {};
    const calls: string[] = [];
    const writeRole = (role: string, v: number) => {
      const id = role === "angleY" ? "ParamAngleY" : role; // mapping mock
      core[id] = v;
      calls.push(`role:${id}`);
      return true;
    };
    const writeParam = (id: string, v: number) => {
      core[id] = v;
      calls.push(`param:${id}`);
      return true;
    };
    const arb = createParameterArbiter({ writeRole, writeRoleNorm: () => false, writeParam });
    arb.submit({ channel: "idle-pose-motion", priority: 3, domain: "role", mode: "ref", values: { angleY: 12 } });
    arb.submit({ channel: "sticky", priority: 10, domain: "param", values: { ParamAngleY: 8 } });
    if (order === "actual") {
      arb.commit(); // arbiter: iterasi role dulu, param belakangan
    } else {
      // simulasi urutan TERBALIK: tulis param dulu, role belakangan
      writeParam("ParamAngleY", 8);
      writeRole("angleY", 12);
    }
    return { winner: core.ParamAngleY, calls };
  }

  test("urutan AKTUAL (role → param): sticky menang di param fisik", () => {
    const { winner, calls } = physicalCommit("actual");
    expect(winner).toBe(8);
    expect(calls).toEqual(["role:ParamAngleY", "param:ParamAngleY"]);
  });

  test("urutan TERBALIK (param → role) MEMBALIK pemenang → bukti urutan adalah kontrak", () => {
    const { winner } = physicalCommit("reversed");
    expect(winner).toBe(12); // role menang — BUKAN behavior existing
    // karenanya urutan commit arbiter dikunci test aktual di atas
  });

  test("sumber arbiter: iterasi domain role terjadi sebelum param di commit()", () => {
    const src = readFileSync(join(repoRoot, "src/client/engine/parameter-arbiter.ts"), "utf8");
    const commitIdx = src.indexOf("commit(): number");
    const commitBody = src.slice(commitIdx, src.indexOf("},", commitIdx + 2000));
    const iRole = commitBody.indexOf('for (const domain of ["role", "param"] as const)');
    expect(iRole).toBeGreaterThan(-1);
    // domain role literal muncul sebelum param — urutan terkunci di sumber
    expect(commitBody.indexOf('"role"')).toBeLessThan(commitBody.indexOf('"param"'));
  });
});

describe("4. teardown & gate fields", () => {
  test("teardown model mereset clipGateUntil/clipGateStartedAt", () => {
    const i = appSrc.indexOf("state.clipGateUntil = 0;\n      state.clipGateStartedAt = 0;");
    expect(i).toBeGreaterThan(-1);
  });
});

describe("5. OWNERSHIP BLINK (regression fix pasca-Stage 3)", () => {
  // Root cause (eksperimen A/B/C in-frame): framework EyeBlink = pemilik
  // baseline (3 kedip/10 dtk, kurva 184 ms halus); mengaktifkan channel
  // idle-blink di sampingnya = 20 kedip/10 dtk + tabrakan fase (maxDelta 1.0).
  // Fix = Option 1: channel idle-blink HANYA untuk model TANPA framework
  // EyeBlink; kalau framework pemilik → channel selalu dikosongkan.
  test("submit idle-blink digate: framework EyeBlink pemilik → channel dikosongkan", () => {
    // marker unik blok submit (bukan komentar tickBlink)
    const i = appSrc.indexOf("const fwEyeBlinkOwns = !!(");
    expect(i).toBeGreaterThan(-1);
    const block = appSrc.slice(i, i + 700);
    expect(block).toContain("m.internalModel.eyeBlink");
    expect(block).toContain("blinkIntent = fwEyeBlinkOwns");
    expect(block).toContain('arb.clearSource("idle-blink")');
    expect(block).toContain('channel: "idle-blink"');
    expect(block).toContain('mode: "norm"');
  });

  test("channel idle-blink tetap tersedia untuk model tanpa framework EyeBlink", () => {
    const i = appSrc.indexOf("const fwEyeBlinkOwns = !!(");
    const block = appSrc.slice(i, i + 700);
    // gate: framework pemilik → intent kosong ({}); tanpa framework → intent
    expect(block).toContain("? {}");
    expect(block).toContain("state.__blinkIntent || {}");
  });

  test("tickBlink NONAKTIF total saat framework EyeBlink ada (kembali no-op baseline)", () => {
    const blinkSrc = extractFn(appSrc, "tickBlink")!;
    expect(blinkSrc).toContain("internalModel.eyeBlink) return;");
    // vm: framework EyeBlink ada + blinkNext habis → TIDAK ada intent
    const state: any = {
      model: { internalModel: { eyeBlink: { updateParameters() {} } } },
      blinkEnabled: true,
      frozen: false,
      clipUntil: 0,
      blinkState: null,
      blinkNext: 0.001,
      __blinkIntent: null,
    };
    const sandbox: any = {
      state,
      roleId: (role: string) => (role === "eyeLOpen" ? "ParamEyeLOpen" : null),
      performance: { now: () => 1000 },
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(blinkSrc, sandbox);
    vm.runInContext("tickBlink(0.016)", sandbox);
    expect(state.__blinkIntent).toBeNull(); // tidak ada intent → channel kosong
    expect(state.blinkState).toBeNull();    // state machine tidak jalan
  });

  test("tickBlink tetap JALAN untuk model tanpa framework EyeBlink", () => {
    const blinkSrc = extractFn(appSrc, "tickBlink")!;
    const state: any = {
      model: { internalModel: { eyeBlink: null } }, // tanpa framework blink
      blinkEnabled: true,
      frozen: false,
      clipUntil: 0,
      blinkState: null,
      blinkNext: 0.001,
      __blinkIntent: null,
    };
    const sandbox: any = {
      state,
      roleId: (role: string) => (role === "eyeLOpen" ? "ParamEyeLOpen" : null),
      performance: { now: () => 1000 },
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(blinkSrc, sandbox);
    vm.runInContext("tickBlink(0.016)", sandbox); // trigger
    vm.runInContext("tickBlink(0.05)", sandbox);  // fase close → intent
    expect(state.__blinkIntent && state.__blinkIntent.eyeLOpen).toBeDefined();
  });

  test("tickBlink sendiri tidak berubah (fase/rumus terkunci Stage 3)", () => {
    const blinkSrc = extractFn(appSrc, "tickBlink")!;
    expect(blinkSrc).toContain('role: "eyeLOpen"');
    expect(blinkSrc).toContain("blinkIntent[e.role]");
    expect(blinkSrc).toContain("CLOSE_MS = 100");
    expect(blinkSrc).not.toMatch(/pokeRoleNorm\(/);
  });
});
