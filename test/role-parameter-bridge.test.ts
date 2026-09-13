/**
 * role-parameter-bridge.test.ts — test Phase 10 (Role Mapping → Parameter API).
 *
 * Bridge diuji dengan ParameterApi NYATA (Phase 8) di atas backing mock —
 * jadi alur tulisnya persis: role → role-mapping.ts → id → ParameterApi.
 * Tolerant backing (engine legacy) diuji dengan fake dua generasi framework.
 *
 * Cakupan = Verification Matrix Phase 10:
 *  T2 role→param | T3 existence safe failure | T4 model-specific mapping |
 *  T5 role range | T6 role clamp | T7 model clamp | T8 write integration |
 *  T10 read path | T11 two-model isolation | + NaN + engine link + backing.
 */
import { describe, expect, it } from "bun:test";
import {
  buildTolerantParameterBacking,
  createEngineParameterLink,
  createRoleParameterBridge,
  type RoleParameterTarget,
} from "../src/client/engine/role-parameter-bridge";
import { mapRoles } from "../src/client/engine/role-mapping";
import { ParameterApi, type CubismParameterBacking } from "../src/live2d/parameter-api";

function makeBacking(
  spec: Record<string, { value: number; min: number; max: number; def: number }>,
): { backing: CubismParameterBacking; current: Record<string, number> } {
  const ids = Object.keys(spec);
  const current: Record<string, number> = {};
  for (const id of ids) current[id] = spec[id].value;
  return {
    current,
    backing: {
      getParameterCount: () => ids.length,
      getParameterId: (i) => ids[i],
      getParameterValue: (id) => current[id],
      getParameterMinimum: (id) => spec[id].min,
      getParameterMaximum: (id) => spec[id].max,
      getParameterDefault: (id) => spec[id].def,
      setParameterValue: (id, v) => { current[id] = v; },
      update: () => {},
    },
  };
}

const REN_PARAMS = {
  ParamAngleX: { value: 0, min: -30, max: 30, def: 0 },
  ParamEyeLOpen: { value: 1, min: 0, max: 1, def: 1 },
  ParamMouthOpenY: { value: 0, min: 0, max: 1, def: 0 },
  ParamHeart: { value: 0, min: 0, max: 1, def: 0 }, // bukan role apa pun
};
// model "gaya lain": id beda, range beda (skala ±100, bukan ±30)
const LUMI_PARAMS = {
  HeadYaw: { value: 0, min: -100, max: 100, def: 0 },
  EyeOpenL: { value: 1, min: 0, max: 1, def: 1 },
};

describe("Phase 10 — Role Parameter Bridge", () => {
  const renApi = () => new ParameterApi(makeBacking(REN_PARAMS).backing);

  // ── T2: role resolves parameter ──
  it("T2: role termapping → id aktual milik model, tulisan true", () => {
    const api = renApi();
    const ids = mapRoles(new Set(Object.keys(REN_PARAMS)), {
      eyeBlinkIds: ["ParamEyeLOpen"], lipSyncIds: ["ParamMouthOpenY"],
    });
    const b = createRoleParameterBridge(api, () => ids);
    expect(b.roleIdOf("angleX")).toBe("ParamAngleX");
    expect(b.hasRole("angleX")).toBe(true);
    // writeRef memakai SKALA REFERENSI ±30 — persis kontrak pokeRoleRef lama.
    // (Fraksi semantik 0.5 → 15 ref oleh scaleRoleFraction di atas bridge.)
    expect(b.writeRef("angleX", 15)).toBe(true);
    expect(api.getParameter("ParamAngleX")).toBe(15);
  });

  // ── T3: existence — safe failure, tanpa throw, tanpa mutasi ──
  it("T3: role tanpa mapping & parameter tak dikenal → false, model utuh", () => {
    const { backing, current } = makeBacking(REN_PARAMS);
    const api = new ParameterApi(backing);
    // getRoleIds sengaja memuat mapping palsu ke id yang TIDAK ada di model
    const b = createRoleParameterBridge(api, () => ({ angleX: "ParamDoesNotExist" }));
    const before = JSON.stringify(current);
    expect(b.writeRef("angleX", 5)).toBe(false);
    expect(b.writeRef("ear.rotation", 5)).toBe(false);
    expect(b.stats().misses).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(current)).toBe(before); // tidak ada mutasi
  });

  // ── T4: model-specific mapping tanpa cross-contamination ──
  it("T4: mapping beda antar model — bridge membaca getRoleIds terkini", () => {
    const api = renApi();
    let ids: Record<string, string> = { angleX: "ParamAngleX" };
    const b = createRoleParameterBridge(api, () => ids);
    expect(b.roleIdOf("angleX")).toBe("ParamAngleX");
    ids = { angleX: "HeadYaw" }; // "model lain"
    expect(b.roleIdOf("angleX")).toBe("HeadYaw");
    // id HeadYaw tidak ada di model ini → safe failure
    expect(b.writeRef("angleX", 1)).toBe(false);
  });

  // ── T5 + T7: role range & model range dua lapis ──
  it("T5/T7: nilai role dipetakan ke range model berbeda skala", () => {
    const { current, backing } = makeBacking(LUMI_PARAMS);
    const api = new ParameterApi(backing);
    const b = createRoleParameterBridge(api, () => ({ angleX: "HeadYaw" }));
    // HeadYaw range [-100,100] (half=100) → vRef 0.5 (RH=30):
    // toActual = 0 + (0.5/30)*100 ≈ 1.6667
    expect(b.writeRef("angleX", 0.5)).toBe(true);
    expect(Math.abs(current.HeadYaw - 1.6666666666666667)).toBeLessThan(1e-12);
    // vRef -30 (penuh negatif) → -100 (ujung range model)
    expect(b.writeRef("angleX", -30)).toBe(true);
    expect(current.HeadYaw).toBe(-100);
    // vRef +30 → 100
    expect(b.writeRef("angleX", 30)).toBe(true);
    expect(current.HeadYaw).toBe(100);
  });

  // ── T6: role clamp — input di luar skala referensi tetap aman ──
  it("T6: vRef di luar ±30 di-clamp semantik role sebelum ke model", () => {
    const { current, backing } = makeBacking(REN_PARAMS);
    const api = new ParameterApi(backing);
    const b = createRoleParameterBridge(api, () => ({ angleX: "ParamAngleX" }));
    expect(b.writeRef("angleX", 999)).toBe(true);
    expect(current.ParamAngleX).toBe(30); // clamp role → 30, model clamp idempoten
  });

  // ── T8: write integration — lewat ParameterApi NYATA, bukan jalur lain ──
  it("T8: bridge menulis via ParameterApi (canonical), pin tidak menyala", () => {
    const api = renApi();
    const b = createRoleParameterBridge(api, () => ({ eyeLOpen: "ParamEyeLOpen" }));
    expect(b.writeNorm("eyeLOpen", 0)).toBe(true);
    expect(api.getParameter("ParamEyeLOpen")).toBe(0);
    expect(api.pinnedIds()).toEqual([]); // bridge TIDAK memakai pin Phase 8
    expect(b.writeRef("eyeLOpen", 1)).toBe(true);
    expect(api.getParameter("ParamEyeLOpen")).toBe(1);
  });

  // ── T8b: normalized role (normToRange) ──
  it("writeNorm: t 0..1 → range model (mouthOpenY grup resmi)", () => {
    const api = renApi();
    const ids = mapRoles(new Set(Object.keys(REN_PARAMS)), {
      lipSyncIds: ["ParamMouthOpenY"],
    });
    const b = createRoleParameterBridge(api, () => ids);
    expect(ids.mouthOpenY).toBe("ParamMouthOpenY");
    expect(b.writeNorm("mouthOpenY", 1)).toBe(true);
    expect(api.getParameter("ParamMouthOpenY")).toBe(1);
    expect(b.resetRole("mouthOpenY")).toBe(true);
    expect(api.getParameter("ParamMouthOpenY")).toBe(0); // default milik model
  });

  // ── T10: read path — aktual → role-space konsisten dengan toActual ──
  it("T10: readRole kebalikan writeRef (roundtrip)", () => {
    const api = renApi();
    const b = createRoleParameterBridge(api, () => ({ angleX: "ParamAngleX" }));
    b.writeRef("angleX", 0.5);
    const back = b.readRole("angleX") ?? NaN;
    expect(Math.abs(back - 0.5)).toBeLessThan(1e-9);
    b.writeRef("angleX", -10);
    expect(Math.abs((b.readRole("angleX") ?? NaN) - -10)).toBeLessThan(1e-9);
    // role tak termapping → undefined (bukan 0 palsu)
    expect(b.readRole("ear.rotation")).toBeUndefined();
  });

  // ── T11: dua model instance terisolasi ──
  it("T11: dua bridge dua model — tulisan A tidak mengubah B", () => {
    const a = new ParameterApi(makeBacking(REN_PARAMS).backing);
    const bb = new ParameterApi(makeBacking(LUMI_PARAMS).backing);
    const ba = createRoleParameterBridge(a, () => ({ angleX: "ParamAngleX" }));
    const bbB = createRoleParameterBridge(bb, () => ({ angleX: "HeadYaw" }));
    expect(ba.writeRef("angleX", 15)).toBe(true);
    expect(bbB.writeRef("angleX", -15)).toBe(true);
    expect(a.getParameter("ParamAngleX")).toBe(15);
    // HeadYaw half=100 → 0 + (−15/30)·100 = −50
    expect(bb.getParameter("HeadYaw")).toBe(-50);
  });

  // ── NaN / input kotor ──
  it("NaN/Infinity vRef ditolak tanpa menulis", () => {
    const api = renApi();
    const b = createRoleParameterBridge(api, () => ({ angleX: "ParamAngleX" }));
    expect(b.writeRef("angleX", NaN)).toBe(false);
    expect(b.writeRef("angleX", Infinity)).toBe(false);
    expect(b.writeNorm("angleX", NaN)).toBe(false);
    expect(api.getParameter("ParamAngleX")).toBe(0);
  });

  // ── Engine link: tolerant backing dua generasi ──
  it("createEngineParameterLink: framework 5.3 (id handle) — write via setParameterValueById", () => {
    const values: Record<string, number> = { ParamAngleX: 0 };
    const written: Array<[string, number, number | undefined]> = [];
    // gaya Cubism 5.3 framework: getParameterId(i) → handle {getString}
    const cm53 = {
      getParameterCount: () => 1,
      getParameterId: (i: number) => ({ getString: () => ["ParamAngleX"][i] }),
      getParameterValueByIndex: () => values.ParamAngleX,
      getParameterMinimumValue: () => -30,
      getParameterMaximumValue: () => 30,
      getParameterDefaultValue: () => 0,
      setParameterValueById: (id: string, v: number, w?: number) => {
        written.push([id, v, w]);
        values.ParamAngleX = v;
      },
    };
    const link = createEngineParameterLink(cm53, () => ({ angleX: "ParamAngleX" }));
    expect(link).not.toBeNull();
    expect(link!.api.getParameters().length).toBe(1);
    expect(link!.bridge.writeRef("angleX", 15)).toBe(true);
    expect(values.ParamAngleX).toBe(15);
    expect(written[0][0]).toBe("ParamAngleX");
    expect(link!.stats().refWrites).toBe(1);
  });

  it("createEngineParameterLink: framework legacy (id string + raw struct) — tetap jalan", () => {
    const values: Record<string, number> = { HeadYaw: 0 };
    // gaya legacy: getParameterId → string, angka dari raw struct .parameters
    const cmLegacy = {
      setParameterValueById: (id: string, v: number) => { values[id] = v; },
      getParameterValueById: (id: string) => values[id] ?? 0,
      getModel: () => ({
        parameters: {
          count: 1,
          ids: ["HeadYaw"],
          values: [values.HeadYaw],
          minimums: [-100],
          maximums: [100],
          defaults: [0],
        },
      }),
    };
    const link = createEngineParameterLink(cmLegacy, () => ({ angleX: "HeadYaw" }));
    expect(link).not.toBeNull();
    expect(link!.api.getParameterInfo("HeadYaw")).toEqual({
      id: "HeadYaw", min: -100, max: 100, defaultValue: 0,
    });
    expect(link!.bridge.writeRef("angleX", 30)).toBe(true);
    expect(values.HeadYaw).toBe(100);
  });

  it("createEngineParameterLink: model kosong/rusak → null (tanpa throw)", () => {
    expect(createEngineParameterLink(null, () => ({}))).toBeNull();
    expect(createEngineParameterLink({}, () => ({}))).toBeNull();
    const dead = { getParameterCount: () => 0 };
    expect(createEngineParameterLink(dead, () => ({ a: "x" }))).toBeNull();
  });

  // ── buildTolerantParameterBacking langsung: tanpa id → null ──
  it("backing tanpa id yang bisa dibaca → null", () => {
    expect(buildTolerantParameterBacking({ getParameterCount: () => 2 })).toBeNull();
  });

  // ── Phase 11 — writeActual: canonical writer pin:false untuk param-drive ──
  it("writeActual: menulis via ParameterApi, TANPA pin, clamp model range", () => {
    const { current, backing } = makeBacking(REN_PARAMS);
    const api = new ParameterApi(backing);
    const link = createEngineParameterLink(
      {
        getParameterCount: () => Object.keys(REN_PARAMS).length,
        getParameterId: (i: number) => Object.keys(REN_PARAMS)[i],
        getParameterValueByIndex: (i: number) =>
          current[Object.keys(REN_PARAMS)[i]],
        getParameterMinimumValue: (i: number) =>
          REN_PARAMS[Object.keys(REN_PARAMS)[i]].min,
        getParameterMaximumValue: (i: number) =>
          REN_PARAMS[Object.keys(REN_PARAMS)[i]].max,
        getParameterDefaultValue: (i: number) =>
          REN_PARAMS[Object.keys(REN_PARAMS)[i]].def,
        setParameterValueById: (id: string, v: number) => {
          current[id] = v;
        },
      },
      () => ({}),
    )!;
    expect(link.writeActual("ParamAngleX", 999)).toBe(true);
    expect(current.ParamAngleX).toBe(30); // clamp range model oleh Phase 8
    expect(link.writeActual("ParamAngleX", -12.5)).toBe(true);
    expect(current.ParamAngleX).toBe(-12.5);
    // TANPA pin: applyOverrides ParameterApi tidak memegang nilai drive
    expect(api.pinnedIds()).toEqual([]);
    // id tak dikenal → false (safe failure)
    expect(link.writeActual("ParamDoesNotExist", 5)).toBe(false);
  });
});
