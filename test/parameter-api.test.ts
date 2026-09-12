/**
 * parameter-api.test.ts — test Phase 8 (Parameter API).
 *
 * Seluruh logika ParameterApi diuji dengan backing MOCK (tanpa WASM/Cubism
 * asli), supaya test bun jalan headless dan cepat. Adapter ke CubismModel
 * diuji dengan duck-typed fake model (tanpa impor framework asli).
 *
 * Cakupan = Testing Matrix spesifikasi Phase 8 (Test 1..10) + lifecycle +
 * sinkronisasi model.update() + override pin + adapter backing.
 */
import { describe, expect, it } from "bun:test";
import {
  ParameterApi,
  formatParameterTable,
  type CubismParameterBacking,
} from "../src/live2d/parameter-api";
import { createCubismModelBacking } from "../src/live2d/cubism-parameter-backing";
import type { CubismModel } from "../src/live2d/cubismframework/model/cubismmodel";

interface ParamSpec {
  value: number;
  min: number;
  max: number;
  def: number;
}
interface MockState {
  current: Record<string, number>;
  written: string[];
  updateCount: number;
  alive: boolean;
}

/**
 * Bangun backing in-memory yang meniru Cubism Model: menyimpan nilai per-id,
 * mencatat tiap tulisan, dan menghitung pemanggilan update().
 */
function makeMockBacking(
  spec: Record<string, ParamSpec>,
): { backing: CubismParameterBacking; state: MockState } {
  const ids = Object.keys(spec);
  const current: Record<string, number> = {};
  for (const id of ids) current[id] = spec[id].value;
  const state: MockState = { current, written: [], updateCount: 0, alive: true };
  const backing: CubismParameterBacking = {
    getParameterCount: () => ids.length,
    getParameterId: (i) => ids[i],
    getParameterValue: (id) => current[id],
    getParameterMinimum: (id) => spec[id].min,
    getParameterMaximum: (id) => spec[id].max,
    getParameterDefault: (id) => spec[id].def,
    setParameterValue: (id, v) => {
      current[id] = v;
      state.written.push(id);
    },
    update: () => {
      state.updateCount++;
    },
    isAlive: () => state.alive,
  };
  return { backing, state };
}

const REN_LIKE = {
  ParamAngleX: { value: 0, min: -30, max: 30, def: 0 },
  ParamAngleY: { value: 0, min: -30, max: 30, def: 0 },
  ParamEyeLOpen: { value: 1, min: 0, max: 1, def: 1 },
};

describe("Phase 8 — Parameter API", () => {
  // ── Test 1: Discovery ──
  it("discovery: getParameters() mengembalikan >0 param dengan id+range", () => {
    const { backing } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    const params = api.getParameters();
    expect(params.length).toBeGreaterThan(0);
    expect(params.length).toBe(Object.keys(REN_LIKE).length);
    for (const p of params) {
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.min)).toBe(true);
      expect(Number.isFinite(p.max)).toBe(true);
      expect(Number.isFinite(p.defaultValue)).toBe(true);
      expect(p.max).toBeGreaterThanOrEqual(p.min);
    }
  });

  // ── Test 2: Read ──
  it("read: getParameter() mengembalikan nilai aktual / undefined bila tak dikenal", () => {
    const { backing } = makeMockBacking({
      ParamAngleX: { value: 12.5, min: -30, max: 30, def: 0 },
    });
    const api = new ParameterApi(backing);
    expect(api.getParameter("ParamAngleX")).toBe(12.5);
    expect(api.getParameter("ParamDoesNotExist")).toBeUndefined();
  });

  // ── Test 3: Metadata ──
  it("metadata: getParameterInfo() benar (id/min/max/default)", () => {
    const { backing } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    expect(api.getParameterInfo("ParamAngleX")).toEqual({
      id: "ParamAngleX",
      min: -30,
      max: 30,
      defaultValue: 0,
    });
    expect(api.getParameterInfo("ParamEyeLOpen")).toEqual({
      id: "ParamEyeLOpen",
      min: 0,
      max: 1,
      defaultValue: 1,
    });
    expect(api.getParameterInfo("Nope")).toBeUndefined();
  });

  // ── Test 4: Write ──
  it("write: setParameter() mengubah Cubism & terbaca balik", () => {
    const { backing, state } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    expect(api.setParameter("ParamAngleX", 15)).toBe(true);
    // §8.13: nilai benar-benar sampai ke backing (bukan cuma internal API)
    expect(state.current.ParamAngleX).toBe(15);
    expect(api.getParameter("ParamAngleX")).toBe(15);
    // §8.10: setParameter sendiri TIDAK memanggil update() per setter
    expect(state.updateCount).toBe(0);
    expect(state.written).toEqual(["ParamAngleX"]);
  });

  // ── Test 5: Clamp ──
  it("clamp: out-of-range dibatasi ke [min,max] model", () => {
    const { backing, state } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    expect(api.setParameter("ParamAngleX", 999)).toBe(true);
    expect(state.current.ParamAngleX).toBe(30);
    expect(api.setParameter("ParamAngleX", -999)).toBe(true);
    expect(state.current.ParamAngleX).toBe(-30);
  });

  // ── Test 6: Invalid number ──
  it("invalid: NaN/Infinity/-Infinity ditolak, nilai lama lestari", () => {
    const { backing, state } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    state.current.ParamAngleX = 5;
    state.written.length = 0;
    expect(api.setParameter("ParamAngleX", NaN)).toBe(false);
    expect(state.current.ParamAngleX).toBe(5);
    expect(api.setParameter("ParamAngleX", Infinity)).toBe(false);
    expect(api.setParameter("ParamAngleX", -Infinity)).toBe(false);
    expect(state.current.ParamAngleX).toBe(5);
    expect(state.written).not.toContain("ParamAngleX");
  });

  // ── Test 7: Unknown id ──
  it("unknown: id tak dikenal → false tanpa throw / tanpa mutasi lain", () => {
    const { backing, state } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    const before = JSON.stringify(state.current);
    expect(api.setParameter("DOES_NOT_EXIST", 10)).toBe(false);
    expect(JSON.stringify(state.current)).toBe(before);
    expect(state.written).not.toContain("DOES_NOT_EXIST");
  });

  // ── Test 8: Multiple writes ──
  it("multiple: beberapa parameter diterapkan sekaligus", () => {
    const { backing } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    expect(api.setParameter("ParamAngleX", 15)).toBe(true);
    expect(api.setParameter("ParamAngleY", -10)).toBe(true);
    expect(api.setParameter("ParamEyeLOpen", 0)).toBe(true);
    expect(api.getParameter("ParamAngleX")).toBe(15);
    expect(api.getParameter("ParamAngleY")).toBe(-10);
    expect(api.getParameter("ParamEyeLOpen")).toBe(0);
  });

  // ── Test 9: Two models isolation ──
  it("isolation: dua instance model tidak saling pengaruh", () => {
    const ma = makeMockBacking(REN_LIKE);
    const mb = makeMockBacking(REN_LIKE);
    const a = new ParameterApi(ma.backing);
    const b = new ParameterApi(mb.backing);
    a.setParameter("ParamAngleX", 15);
    b.setParameter("ParamAngleX", -15);
    expect(a.getParameter("ParamAngleX")).toBe(15);
    expect(b.getParameter("ParamAngleX")).toBe(-15);
    expect(ma.state.current.ParamAngleX).toBe(15);
    expect(mb.state.current.ParamAngleX).toBe(-15);
  });

  // ── Test 10: Regression — read tidak mengubah state ──
  it("regression: operasi read-only tidak memutasi model", () => {
    const { backing, state } = makeMockBacking({
      ParamAngleX: { value: 7, min: -30, max: 30, def: 0 },
    });
    const api = new ParameterApi(backing);
    const before = JSON.stringify(state.current);
    api.getParameters();
    api.getParameter("ParamAngleX");
    api.getParameterInfo("ParamAngleX");
    expect(JSON.stringify(state.current)).toBe(before);
    expect(state.written).toEqual([]);
  });

  // ── Lifecycle (§8.12) ──
  it("lifecycle: dispose membuat semua panggilan aman (tidak throw)", () => {
    const { backing } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    api.setParameter("ParamAngleX", 15);
    api.dispose();
    expect(api.isDisposed()).toBe(true);
    expect(api.getParameter("ParamAngleX")).toBeUndefined();
    expect(api.getParameterInfo("ParamAngleX")).toBeUndefined();
    expect(api.getParameters()).toEqual([]);
    expect(api.setParameter("ParamAngleX", 5)).toBe(false);
  });

  it("lifecycle: model mati (isAlive=false) → setParameter aman gagal", () => {
    const { backing, state } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    state.alive = false;
    expect(api.setParameter("ParamAngleX", 15)).toBe(false);
    expect(api.getParameter("ParamAngleX")).toBeUndefined();
  });

  // ── Sinkronisasi (§8.13) ──
  it("sinkronisasi: setParameter → backing → applyOverrides → update()", () => {
    const { backing, state } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    expect(api.setParameter("ParamAngleX", 15)).toBe(true);
    expect(api.setParameter("ParamAngleY", -10)).toBe(true);
    expect(state.current.ParamAngleX).toBe(15);
    expect(state.current.ParamAngleY).toBe(-10);
    // Tiap frame: applyOverrides() LALU backing.update()
    api.applyOverrides();
    backing.update();
    expect(state.updateCount).toBe(1);
  });

  it("applyOverrides menahan nilai pin melawan overwrite tiap frame", () => {
    const { backing, state } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    api.setParameter("ParamAngleX", 15); // pin default true
    // frame 1: motion menulis 0, lalu override → 15
    state.current.ParamAngleX = 0;
    api.applyOverrides();
    expect(state.current.ParamAngleX).toBe(15);
    // frame 2: motion menulis -5, lalu override → 15
    state.current.ParamAngleX = -5;
    api.applyOverrides();
    expect(state.current.ParamAngleX).toBe(15);
  });

  it("pin:false → tulis sekali, tidak di-pin (applyOverrides tak mengembalikan)", () => {
    const { backing, state } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    expect(api.setParameter("ParamAngleX", 15, { pin: false })).toBe(true);
    expect(state.current.ParamAngleX).toBe(15);
    expect(api.hasOverride("ParamAngleX")).toBe(false);
    state.current.ParamAngleX = 0;
    api.applyOverrides();
    expect(state.current.ParamAngleX).toBe(0);
  });

  it("clearOverride melepas pin", () => {
    const { backing, state } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    api.setParameter("ParamAngleX", 15); // pin
    expect(api.hasOverride("ParamAngleX")).toBe(true);
    api.clearOverride("ParamAngleX");
    expect(api.hasOverride("ParamAngleX")).toBe(false);
    state.current.ParamAngleX = 0;
    api.applyOverrides();
    expect(state.current.ParamAngleX).toBe(0);
  });

  // ── Debug instrumentation (§8.16) ──
  it("formatParameterTable menghasilkan tabel debug", () => {
    const { backing } = makeMockBacking(REN_LIKE);
    const api = new ParameterApi(backing);
    api.setParameter("ParamAngleX", 15);
    api.setParameter("ParamAngleY", -10);
    api.setParameter("ParamEyeLOpen", 0);
    const table = formatParameterTable(api.getParameters());
    expect(table).toContain("ParamAngleX");
    expect(table).toContain("15.00");
    expect(table).toContain("[-30,30]");
    expect(table).toContain("ParamEyeLOpen");
    expect(table).toContain("[0,1]");
  });

  // ── Adapter CubismModel (tanpa framework asli) ──
  it("createCubismModelBacking memetakan CubismModel ke backing", () => {
    const ids = ["ParamAngleX", "ParamAngleY", "ParamEyeLOpen"];
    const mins = [-30, -30, 0];
    const maxs = [30, 30, 1];
    const defs = [0, 0, 1];
    const values = [0, 0, 1];
    const fakeModel = {
      getParameterCount: () => ids.length,
      getParameterId: (i: number) => ({ getString: () => ids[i] }),
      getParameterValueByIndex: (i: number) => values[i],
      getParameterMinimumValue: (i: number) => mins[i],
      getParameterMaximumValue: (i: number) => maxs[i],
      getParameterDefaultValue: (i: number) => defs[i],
      setParameterValueByIndex: (i: number, v: number) => {
        values[i] = v;
      },
      update: () => {},
      getModel: () => ({}),
    };
    const backing = createCubismModelBacking(
      fakeModel as unknown as CubismModel,
    );
    const api = new ParameterApi(backing);
    const params = api.getParameters();
    expect(params.length).toBe(3);
    expect(params[0]).toEqual({
      id: "ParamAngleX",
      value: 0,
      min: -30,
      max: 30,
      defaultValue: 0,
    });
    expect(api.setParameter("ParamAngleY", -10)).toBe(true);
    expect(values[1]).toBe(-10);
    // unknown id → safe
    expect(api.setParameter("Nope", 5)).toBe(false);
    // clamp lewat backing nyata
    expect(api.setParameter("ParamAngleX", 999)).toBe(true);
    expect(values[0]).toBe(30);
  });
});
