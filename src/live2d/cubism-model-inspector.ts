/**
 * live2d/cubism-model-inspector.ts — adapter sumber data ModelProfile (Phase 9).
 *
 * Memetakan tiga objek Cubism 5.3 yang SUDAH dimuat ke ModelMetadataBacking:
 *  - CubismModel  → parts/drawables/offscreens (core, fakta struktur);
 *  - CubismModelSettingJson → textures/motions/expressions/eyeBlink/lipSync
 *    (manifest, apa adanya — TIDAK ada klasifikasi semantik di sini);
 *  - CubismUserModel → physics/pose dari state loader runtime (bukan
 *    keberadaan scheduler).
 *
 * Sama seperti cubism-parameter-backing.ts: kontrak sumber didefinisikan LOKAL
 * (duck-type) agar modul ini tidak menarik sumber framework ke type-check
 * (framework resmi tidak lolos strict null-check; ia di-build via Bun.build).
 * Semua method read-only dan hanya membaca getter — tidak ada setParameter,
 * tidak ada update(), tidak ada mutasi renderer.
 */

import type {
  CapabilityFlag,
  DrawableInfo,
  ExpressionInfo,
  ModelMetadataBacking,
  MotionInfo,
  OffscreenInfo,
  PartInfo,
  TextureInfo,
} from "./model-profile";

/** String Cubism (CubismId) punya getString() — cukup itu yang kita andalkan. */
interface CubismIdLike {
  getString(): string;
}

/** Getter CubismModel resmi yang kita pakai (versi framework 5.3). */
interface CubismModelInspectLike {
  getPartCount(): number;
  getPartId(index: number): CubismIdLike;
  /** Int32Array: parent part per part (-1 = akar). */
  getPartParentPartIndices(): ArrayLike<number>;
  getDrawableCount(): number;
  getDrawableId(index: number): CubismIdLike;
  getDrawableTextureIndex(index: number): number;
  /** Render order GABUNGAN era 5.3 (drawable lalu offscreen). */
  getRenderOrders(): ArrayLike<number>;
  getDrawableColorBlend(index: number): number;
  getDrawableAlphaBlend(index: number): number;
  /** PER drawable: masks[i] = daftar indeks drawable yang menjadi mask-nya
   * (bukan array rata kumulatif — diverifikasi di runtime golden Phase 9). */
  getDrawableMasks(): ArrayLike<ArrayLike<number> | null>;
  getDrawableInvertedMaskBit(index: number): boolean;
  getDrawableParentPartIndex(index: number): number;
  getDrawableVertexCount(index: number): number;
  getDrawableVertexIndexCount(index: number): number;
  getOffscreenCount(): number;
  getOffscreenOwnerIndices(): ArrayLike<number>;
  getOffscreenColorBlend(index: number): number;
  getOffscreenAlphaBlend(index: number): number;
  getOffscreenInvertedMask(index: number): boolean;
  getOffscreenMasks(): ArrayLike<ArrayLike<number> | null>;
}

/** Getter manifest yang kita pakai. */
interface CubismSettingLike {
  getModelFileName(): string;
  getTextureCount(): number;
  getTextureFileName(index: number): string;
  getMotionGroupCount(): number;
  getMotionGroupName(index: number): string;
  getMotionCount(group: string): number;
  getMotionFileName(group: string, index: number): string;
  getExpressionCount(): number;
  getExpressionName(index: number): string;
  getExpressionFileName(index: number): string;
  getEyeBlinkParameterCount(): number;
  getEyeBlinkParameterId(index: number): CubismIdLike;
  getLipSyncParameterCount(): number;
  getLipSyncParameterId(index: number): CubismIdLike;
  /** null bila manifest tidak mendeklarasikan physics/pose. */
  getPhysicsFileName(): string | null;
  getPoseFileName(): string | null;
}

/** State loader runtime CubismUserModel yang relevan (fakta, bukan asumsi). */
interface CubismUserLike {
  _physics?: unknown;
  _pose?: unknown;
}

export interface InspectorSources {
  model: CubismModelInspectLike;
  setting: CubismSettingLike;
  /** Opsional: TANPA ini, physics/pose tidak bisa dipastikan dari runtime →
   * fallback ke keberadaan file manifest, dan "not-verified" bila ambigu. */
  userModel?: CubismUserLike;
  /** Versi moc yang terdeteksi saat load (dari header — bukan tebakan). */
  mocVersion: number;
  /** Nama model; default: nama file moc dari manifest. */
  modelName?: string;
}

/** Salin daftar mask per-objek (Int32Array per drawable/offscreen) ke number[]. */
function maskListFor(
  masks: ArrayLike<ArrayLike<number> | null>,
  i: number,
): number[] {
  const m = masks[i];
  if (!m) return [];
  const out: number[] = [];
  for (let k = 0; k < m.length; k++) out.push(m[k]);
  return out;
}

export function createCubismInspectorBacking(
  src: InspectorSources,
): ModelMetadataBacking {
  const { model, setting } = src;

  const parts = (): PartInfo[] => {
    const n = model.getPartCount();
    const parents = model.getPartParentPartIndices();
    const out: PartInfo[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ id: model.getPartId(i).getString(), parentIndex: parents[i] });
    }
    return out;
  };

  const drawables = (): DrawableInfo[] => {
    const n = model.getDrawableCount();
    const orders = model.getRenderOrders();
    const masks = model.getDrawableMasks();
    const out: DrawableInfo[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        id: model.getDrawableId(i).getString(),
        textureIndex: model.getDrawableTextureIndex(i),
        renderOrder: orders[i],
        colorBlend: model.getDrawableColorBlend(i),
        alphaBlend: model.getDrawableAlphaBlend(i),
        maskIndices: maskListFor(masks, i),
        invertedMask: !!model.getDrawableInvertedMaskBit(i),
        parentPartIndex: model.getDrawableParentPartIndex(i),
        vertexCount: model.getDrawableVertexCount(i),
        indexCount: model.getDrawableVertexIndexCount(i),
      });
    }
    return out;
  };

  const offscreens = (): OffscreenInfo[] => {
    const n = model.getOffscreenCount();
    const owners = model.getOffscreenOwnerIndices();
    const masks = model.getOffscreenMasks();
    const out: OffscreenInfo[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        index: i,
        ownerIndices: [owners[i]],
        colorBlend: model.getOffscreenColorBlend(i),
        alphaBlend: model.getOffscreenAlphaBlend(i),
        invertedMask: !!model.getOffscreenInvertedMask(i),
        maskIndices: maskListFor(masks, i),
      });
    }
    return out;
  };

  const textures = (): TextureInfo[] => {
    const n = setting.getTextureCount();
    const out: TextureInfo[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ index: i, path: setting.getTextureFileName(i) });
    }
    return out;
  };

  const motions = (): MotionInfo[] => {
    const out: MotionInfo[] = [];
    const gN = setting.getMotionGroupCount();
    for (let g = 0; g < gN; g++) {
      const group = setting.getMotionGroupName(g);
      const mN = setting.getMotionCount(group);
      for (let i = 0; i < mN; i++) {
        out.push({ group, index: i, file: setting.getMotionFileName(group, i) });
      }
    }
    return out;
  };

  const expressions = (): ExpressionInfo[] => {
    const n = setting.getExpressionCount();
    const out: ExpressionInfo[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ name: setting.getExpressionName(i), file: setting.getExpressionFileName(i) });
    }
    return out;
  };

  const idList = (count: number, at: (i: number) => CubismIdLike): string[] => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(at(i).getString());
    return out;
  };

  /**
   * Capability dari STATE, bukan tebakan:
   *  - dengan userModel runtime: loader SUDAH memutuskan — _physics/_pose
   *    terisi hanya bila file ada DI manifest DAN berhasil dimuat;
   *  - tanpa userModel: hanya bisa lihat manifest — file dideklarasikan tapi
   *    belum tentu termuat → "not-verified" (bukan true);
   *  - manifest tanpa deklarasi → false (fakta aset).
   */
  const capability = (
    runtimeObj: unknown | undefined,
    fileName: string | null,
  ): CapabilityFlag => {
    if (src.userModel) return !!runtimeObj;
    return fileName ? "not-verified" : false;
  };

  return {
    modelName: () =>
      src.modelName ?? setting.getModelFileName().replace(/^.*[\\/]/, ""),
    mocVersion: () => src.mocVersion,
    parts,
    drawables,
    offscreens,
    textures,
    motions,
    expressions,
    eyeBlinkParameters: () =>
      idList(setting.getEyeBlinkParameterCount(), (i) => setting.getEyeBlinkParameterId(i)),
    lipSyncParameters: () =>
      idList(setting.getLipSyncParameterCount(), (i) => setting.getLipSyncParameterId(i)),
    physics: () =>
      capability(src.userModel ? src.userModel._physics : undefined, setting.getPhysicsFileName()),
    pose: () =>
      capability(src.userModel ? src.userModel._pose : undefined, setting.getPoseFileName()),
  };
}
