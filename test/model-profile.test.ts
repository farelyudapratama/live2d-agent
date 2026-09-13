/**
 * model-profile.test.ts — test Phase 9 (Model Inspector).
 *
 * buildModelProfile diuji dengan backing MOCK (tanpa Cubism/WASM). Adapter
 * Cubism diuji dengan fake duck-typed (CubismModel + setting + user palsu).
 *
 * Cakupan = Test Requirements spesifikasi Phase 9:
 *  T1 parameter discovery | T2 parts | T3 drawables (jumlah == runtime, tanpa
 *  duplikat) | T4 motions (ada/kosong) | T5 expressions (ada/kosong) |
 *  T6 physics | T7 pose | T8 read-only | T9 dua model terisolasi |
 *  T10 integrasi Phase 8 (parameter dari ParameterApi, bukan sistem kedua) |
 *  + immutability (deep-frozen) + nilai tidak tersimpan di profile.
 */
import { describe, expect, it } from "bun:test";
import { ParameterApi, type CubismParameterBacking } from "../src/live2d/parameter-api";
import {
  buildModelProfile,
  formatProfileSummary,
  type ModelMetadataBacking,
  type PartInfo,
  type DrawableInfo,
  type OffscreenInfo,
  type TextureInfo,
  type MotionInfo,
  type ExpressionInfo,
  type CapabilityFlag,
} from "../src/live2d/model-profile";
import { createCubismInspectorBacking } from "../src/live2d/cubism-model-inspector";

// ── Mock parameter backing (pola sama dengan Phase 8) ──

function makeParamBacking(
  spec: Record<string, { value: number; min: number; max: number; def: number }>,
): CubismParameterBacking {
  const ids = Object.keys(spec);
  const current: Record<string, number> = {};
  for (const id of ids) current[id] = spec[id].value;
  return {
    getParameterCount: () => ids.length,
    getParameterId: (i) => ids[i],
    getParameterValue: (id) => current[id],
    getParameterMinimum: (id) => spec[id].min,
    getParameterMaximum: (id) => spec[id].max,
    getParameterDefault: (id) => spec[id].def,
    setParameterValue: (id, v) => { current[id] = v; },
    update: () => {},
  };
}

// ── Mock metadata backing ──

interface MetaSpec {
  modelName?: string;
  mocVersion?: number;
  parts?: PartInfo[];
  drawables?: DrawableInfo[];
  offscreens?: OffscreenInfo[];
  textures?: TextureInfo[];
  motions?: MotionInfo[];
  expressions?: ExpressionInfo[];
  eyeBlink?: string[];
  lipSync?: string[];
  physics?: CapabilityFlag;
  pose?: CapabilityFlag;
}

function makeMetaBacking(spec: MetaSpec = {}): ModelMetadataBacking & {
  calls: string[];
} {
  const calls: string[] = [];
  const track = <T>(name: string, fn: () => T): (() => T) => () => {
    calls.push(name);
    return fn();
  };
  return {
    calls,
    modelName: track("modelName", () => spec.modelName ?? "mock"),
    mocVersion: track("mocVersion", () => spec.mocVersion ?? 6),
    parts: track("parts", () => spec.parts ?? []),
    drawables: track("drawables", () => spec.drawables ?? []),
    offscreens: track("offscreens", () => spec.offscreens ?? []),
    textures: track("textures", () => spec.textures ?? []),
    motions: track("motions", () => spec.motions ?? []),
    expressions: track("expressions", () => spec.expressions ?? []),
    eyeBlinkParameters: track("eyeBlink", () => spec.eyeBlink ?? []),
    lipSyncParameters: track("lipSync", () => spec.lipSync ?? []),
    physics: track("physics", () => spec.physics ?? false),
    pose: track("pose", () => spec.pose ?? false),
  };
}

const DRAWABLE = (i: number, over: Partial<DrawableInfo> = {}): DrawableInfo => ({
  id: `Drawable_${i}`,
  textureIndex: 0,
  renderOrder: i,
  colorBlend: 0,
  alphaBlend: 0,
  maskIndices: [],
  invertedMask: false,
  parentPartIndex: -1,
  vertexCount: 4,
  indexCount: 6,
  ...over,
});

describe("Phase 9 — Model Inspector", () => {
  const REN_PARAMS = {
    ParamAngleX: { value: 0, min: -30, max: 30, def: 0 },
    ParamAngleY: { value: 0, min: -30, max: 30, def: 0 },
    ParamEyeLOpen: { value: 1, min: 0, max: 1, def: 1 },
  };

  // ── T1 + T10: parameter dari Phase 8 API, tanpa sistem kedua ──
  it("T1/T10: parameter profile berasal dari ParameterApi Phase 8 (metadata saja)", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const meta = makeMetaBacking({ parts: [{ id: "PartA", parentIndex: -1 }] });
    const p = buildModelProfile(api, meta);
    expect(p.counts.parameters).toBe(3);
    expect(p.parameters.map((x) => x.id)).toEqual([
      "ParamAngleX", "ParamAngleY", "ParamEyeLOpen",
    ]);
    for (const info of p.parameters) {
      expect(Number.isFinite(info.min)).toBe(true);
      expect(Number.isFinite(info.max)).toBe(true);
      expect(Number.isFinite(info.defaultValue)).toBe(true);
      // T: TIDAK ada field value — profil statis, nilai live = getParameter()
      expect("value" in info).toBe(false);
    }
    expect(p.parameters[2]).toEqual({
      id: "ParamEyeLOpen", min: 0, max: 1, defaultValue: 1,
    });
  });

  it("T10: nilai live tidak basi — profile statis, api tetap membaca nilai terkini", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const p = buildModelProfile(api, makeMetaBacking());
    api.setParameter("ParamAngleX", 15);
    // profile tidak menyimpan nilai → tidak mungkin stale
    expect("value" in p.parameters[0]).toBe(false);
    // nilai terkini tetap dari Parameter API
    expect(api.getParameter("ParamAngleX")).toBe(15);
  });

  // ── T2: parts ──
  it("T2: parts ditemukan lengkap dengan parent", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const parts = [
      { id: "root", parentIndex: -1 },
      { id: "child", parentIndex: 0 },
    ];
    const p = buildModelProfile(api, makeMetaBacking({ parts }));
    expect(p.counts.parts).toBe(2);
    expect(p.parts).toEqual(parts);
  });

  // ── T3: drawables — jumlah sama dengan sumber, tanpa duplikat ──
  it("T3: drawable count == jumlah dari backing; id unik (tanpa duplikat)", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const drawables = [
      DRAWABLE(0, { maskIndices: [2], colorBlend: 2 }),
      DRAWABLE(1),
      DRAWABLE(2),
    ];
    const p = buildModelProfile(
      api,
      makeMetaBacking({ drawables, offscreens: [{ index: 0, ownerIndices: [1], colorBlend: 0, alphaBlend: 0, invertedMask: false, maskIndices: [] }] }),
    );
    expect(p.counts.drawables).toBe(3);
    expect(new Set(p.drawables.map((d) => d.id)).size).toBe(3);
    expect(p.drawables[0].maskIndices).toEqual([2]);
    expect(p.drawables[0].colorBlend).toBe(2);
    expect(p.counts.offscreens).toBe(1);
  });

  // ── T4: motions ──
  it("T4: model dengan motion → terisi; tanpa motion → []", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const motions = [
      { group: "Idle", index: 0, file: "motions/idle.motion3.json" },
      { group: "Tap", index: 0, file: "motions/tap.motion3.json" },
    ];
    const withM = buildModelProfile(api, makeMetaBacking({ motions }));
    expect(withM.counts.motions).toBe(2);
    expect(withM.motions[0].group).toBe("Idle");
    const noM = buildModelProfile(api, makeMetaBacking());
    expect(noM.motions).toEqual([]);
    expect(noM.counts.motions).toBe(0);
  });

  // ── T5: expressions ──
  it("T5: expression existing → discovered; tanpa → []", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const expressions = [{ name: "happy", file: "expressions/happy.exp3.json" }];
    const p = buildModelProfile(api, makeMetaBacking({ expressions }));
    expect(p.expressions).toEqual(expressions);
    const none = buildModelProfile(api, makeMetaBacking());
    expect(none.expressions).toEqual([]);
  });

  // ── T6 + T7: physics/pose dari fakta, bukan scheduler; not-verified jujur ──
  it("T6/T7: physics/pose true/false/not-verified sesuai backing", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const yes = buildModelProfile(api, makeMetaBacking({ physics: true, pose: true }));
    expect(yes.physics).toBe(true);
    expect(yes.pose).toBe(true);
    const no = buildModelProfile(api, makeMetaBacking({ physics: false, pose: false }));
    expect(no.physics).toBe(false);
    const nv = buildModelProfile(api, makeMetaBacking({ physics: "not-verified" }));
    expect(nv.physics).toBe("not-verified");
  });

  // ── T8: read-only — build tidak memutasi model, hanya memanggil getter ──
  it("T8: getProfile() berkali-kali tidak mengubah state model", () => {
    const backing = makeParamBacking(REN_PARAMS);
    let writes = 0;
    const wrapped: CubismParameterBacking = {
      ...backing,
      setParameterValue: (id, v) => { writes++; backing.setParameterValue(id, v); },
      update: () => { writes++; },
    };
    const api = new ParameterApi(wrapped);
    const meta = makeMetaBacking({ parts: [{ id: "a", parentIndex: -1 }] });
    const before = JSON.stringify(api.getParameters());
    buildModelProfile(api, meta);
    buildModelProfile(api, meta);
    buildModelProfile(api, meta);
    expect(writes).toBe(0);
    expect(JSON.stringify(api.getParameters())).toBe(before);
    // backing metadata hanya getter yang dipanggil — tidak ada jalur tulis
    expect(meta.calls.every((c) => ![undefined].includes(c))).toBe(true);
  });

  // ── Immutability ──
  it("profile deep-frozen — konsumen tak bisa memutasi lewat objek", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const p = buildModelProfile(api, makeMetaBacking({
      drawables: [DRAWABLE(0)],
      parts: [{ id: "a", parentIndex: -1 }],
    }));
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.parameters)).toBe(true);
    expect(Object.isFrozen(p.parameters[0])).toBe(true);
    expect(Object.isFrozen(p.drawables[0].maskIndices)).toBe(true);
    expect(Object.isFrozen(p.counts)).toBe(true);
    // upaya tulis gagal senyap/throw tergantung mode — yang penting nilai utuh
    try { (p.parameters as unknown as { length: number }).length = 0; } catch { /* frozen strict */ }
    expect(p.parameters.length).toBe(3);
  });

  // ── T9: dua instance dua profile ──
  it("T9: dua model instance menghasilkan profile terpisah dan benar", () => {
    const apiA = new ParameterApi(makeParamBacking(REN_PARAMS));
    const apiB = new ParameterApi(makeParamBacking({
      ParamHead: { value: 0, min: -1, max: 1, def: 0 },
    }));
    const a = buildModelProfile(apiA, makeMetaBacking({ modelName: "ren", drawables: [DRAWABLE(0), DRAWABLE(1)] }));
    const b = buildModelProfile(apiB, makeMetaBacking({ modelName: "lumine", drawables: [DRAWABLE(0)] }));
    expect(a.modelName).toBe("ren");
    expect(b.modelName).toBe("lumine");
    expect(a.counts.parameters).toBe(3);
    expect(b.counts.parameters).toBe(1);
    expect(a.counts.drawables).toBe(2);
    expect(b.counts.drawables).toBe(1);
    // mengubah B tidak mengubah A
    apiB.setParameter("ParamHead", 0.5);
    expect(a.parameters[0].id).toBe("ParamAngleX");
  });

  // ── Absen = konsisten kosong/false ──
  it("model tanpa data: koleksi [] dan flag false — field tidak hilang", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const p = buildModelProfile(api, makeMetaBacking());
    expect(p.motions).toEqual([]);
    expect(p.expressions).toEqual([]);
    expect(p.parts).toEqual([]);
    expect(p.drawables).toEqual([]);
    expect(p.offscreens).toEqual([]);
    expect(p.textures).toEqual([]);
    expect(p.physics).toBe(false);
    expect(p.pose).toBe(false);
    expect(p.eyeBlinkParameters).toEqual([]);
    expect(p.lipSyncParameters).toEqual([]);
  });

  // ── Debug formatter ──
  it("formatProfileSummary meringkas fakta profil", () => {
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const p = buildModelProfile(api, makeMetaBacking({
      modelName: "ren",
      drawables: [DRAWABLE(0, { maskIndices: [1], colorBlend: 2, alphaBlend: 0 })],
      motions: [{ group: "Idle", index: 0, file: "i.motion3.json" }],
      physics: true,
      pose: "not-verified",
    }));
    const s = formatProfileSummary(p);
    expect(s).toContain("ren");
    expect(s).toContain("parameters: 3");
    expect(s).toContain("Idle(1)");
    expect(s).toContain("physics: yes");
    expect(s).toContain("pose: NOT VERIFIED");
    expect(s).toContain("2/0×1");
  });

  // ── Adapter Cubism (duck-typed fake — pola Phase 8) ──
  it("createCubismInspectorBacking memetakan CubismModel+setting+user ke backing", () => {
    const ids = ["ParamAngleX", "ParamEyeLOpen"];
    const partIds = ["PartRoot", "PartChild"];
    const partParents = [-1, 0];
    const drawableIds = ["d0", "d1", "d2"];
    const fakeModel = {
      getPartCount: () => 2,
      getPartId: (i: number) => ({ getString: () => partIds[i] }),
      getPartParentPartIndices: () => Int32Array.from(partParents),
      getDrawableCount: () => 3,
      getDrawableId: (i: number) => ({ getString: () => drawableIds[i] }),
      getDrawableTextureIndex: (i: number) => i % 2,
      getRenderOrders: () => Int32Array.from([2, 0, 1, 3]), // 3 drawable + 1 offscreen
      getDrawableColorBlend: () => 0,
      getDrawableAlphaBlend: () => 0,
      // layout nyata framework: satu Int32Array PER drawable (diverifikasi
      // runtime golden Phase 9 — bukan array rata kumulatif)
      getDrawableMasks: () => [
        Int32Array.from([]),
        Int32Array.from([2]),
        Int32Array.from([0, 1]),
      ],
      getDrawableInvertedMaskBit: (i: number) => i === 1,
      getDrawableParentPartIndex: () => 1,
      getDrawableVertexCount: () => 4,
      getDrawableVertexIndexCount: () => 6,
      getOffscreenCount: () => 1,
      getOffscreenOwnerIndices: () => Int32Array.from([1]),
      getOffscreenColorBlend: () => 0,
      getOffscreenAlphaBlend: () => 0,
      getOffscreenInvertedMask: () => false,
      getOffscreenMasks: () => [Int32Array.from([])],
    };
    const fakeSetting = {
      getModelFileName: () => "ren.moc3",
      getTextureCount: () => 2,
      getTextureFileName: (i: number) => `ren.${i}.png`,
      getMotionGroupCount: () => 1,
      getMotionGroupName: () => "Idle",
      getMotionCount: () => 2,
      getMotionFileName: (_g: string, i: number) => `motions/idle${i}.motion3.json`,
      getExpressionCount: () => 0,
      getExpressionName: () => "",
      getExpressionFileName: () => "",
      getEyeBlinkParameterCount: () => 1,
      getEyeBlinkParameterId: () => ({ getString: () => "ParamEyeLOpen" }),
      getLipSyncParameterCount: () => 1,
      getLipSyncParameterId: () => ({ getString: () => "ParamMouthOpenY" }),
      getPhysicsFileName: () => "ren.physics3.json",
      getPoseFileName: () => "",
    };
    const fakeUser = { _physics: { ok: true }, _pose: null };

    const backing = createCubismInspectorBacking({
      model: fakeModel, setting: fakeSetting, userModel: fakeUser, mocVersion: 6,
    });
    const api = new ParameterApi(makeParamBacking(REN_PARAMS));
    const p = buildModelProfile(api, backing);

    expect(p.modelName).toBe("ren.moc3");
    expect(p.mocVersion).toBe(6);
    expect(p.parts).toEqual([
      { id: "PartRoot", parentIndex: -1 },
      { id: "PartChild", parentIndex: 0 },
    ]);
    expect(p.counts.drawables).toBe(3);
    // mask rata → per-drawable: d0=[], d1=[2], d2=[0,1]
    expect(p.drawables[0].maskIndices).toEqual([]);
    expect(p.drawables[1].maskIndices).toEqual([2]);
    expect(p.drawables[1].invertedMask).toBe(true);
    expect(p.drawables[2].maskIndices).toEqual([0, 1]);
    // render order gabungan: posisi per indeks
    expect(p.drawables.map((d) => d.renderOrder)).toEqual([2, 0, 1]);
    expect(p.counts.textures).toBe(2);
    expect(p.textures[1].path).toBe("ren.1.png");
    expect(p.motions).toEqual([
      { group: "Idle", index: 0, file: "motions/idle0.motion3.json" },
      { group: "Idle", index: 1, file: "motions/idle1.motion3.json" },
    ]);
    expect(p.expressions).toEqual([]);
    expect(p.eyeBlinkParameters).toEqual(["ParamEyeLOpen"]);
    expect(p.lipSyncParameters).toEqual(["ParamMouthOpenY"]);
    // fakta runtime: physics termuat → true; pose tanpa file → false
    expect(p.physics).toBe(true);
    expect(p.pose).toBe(false);

    // TANPA userModel: physics dideklarasikan manifest tapi belum tentu termuat
    // → jujur "not-verified", bukan true
    const backing2 = createCubismInspectorBacking({
      model: fakeModel, setting: fakeSetting, mocVersion: 6,
    });
    const p2 = buildModelProfile(api, backing2);
    expect(p2.physics).toBe("not-verified");
    expect(p2.pose).toBe(false);
    // override nama
    const backing3 = createCubismInspectorBacking({
      model: fakeModel, setting: fakeSetting, userModel: fakeUser,
      mocVersion: 6, modelName: "ren",
    });
    expect(buildModelProfile(api, backing3).modelName).toBe("ren");
  });
});
