/**
 * live2d/production-handle.ts — STAGE R2: implementasi produksi
 * Live2DModelHandle di atas pipeline Cubism 5.3 proven (loadProductionModel).
 *
 * Batas arsitektur (mengikat):
 *  - Handle = PUBLIC CAPABILITY BOUNDARY. Pemanggil (app.js kelak, R3+) TIDAK
 *    melihat CubismUserModel / CubismRenderer_WebGL / motion manager /
 *    GL context — semuanya internal adapter.
 *  - TIDAK ADA loop tersembunyi: update(dt) dipanggil pemilik lifecycle
 *    (R3+ yang menentukan); host.render() dipanggil pemilik render. Handle
 *    tidak pernah memulai rAF/ticker/interval sendiri.
 *  - beforeModelUpdate = SEAM, bukan pemilik: update() menjalankan framework
 *    writers (motion → scheduler efek) lalu menyalakan callback SEBELUM
 *    `model.update()` — posisi kontrak identik slot beforeModelUpdate stack
 *    lama (framework writers → ARBITER commit → coreModel.update). Handle
 *    TIDAK tahu arbiter; komit tetap milik engine.
 *  - Single-owner blink (invariant Phase 13): framework EyeBlink updater
 *    pemilik kedip SAAT IA ADA (manifest grup EyeBlink). Handle TIDAK punya
 *    blink kedua — fallback custom tetap milik engine lewat channel arbiter.
 *  - Destroy bersih: release moc/model/managers/renderer + GL texture + callback
 *    registry. Setelah destroy semua method publik fail-safe (tanpa resource
 *    write ke model mati, tanpa throw di jalur baca).
 */

import type {
  ParameterInfo,
  ParameterSnapshot,
} from "./parameter-api";
import type { ModelProfile } from "./model-profile";
import type {
  CoreModelSnapshot,
  MocVersion,
} from "./cubism-core";
import type {
  Live2DEffect,
  Live2DPoint,
} from "./types";
import type { ProductionModel } from "./production-model";
import type {
  FrameworkModelLike,
  FrameworkMotionLike,
  Matrix44Like,
  ProductionEnv,
  RendererLike,
} from "./production-env";
import type { GLHostBinding } from "./production-host";
import { Live2DLoadError } from "./types";

/** R6 — PARITAS TRANSFORM: skala-1 produksi kini identik stack legacy era-4:
 * natural size = `canvasinfo.CanvasWidth/Height` RAW PX
 * dari core, dan px-per-unit = `canvasinfo.PixelsPerUnit`. Dengan itu
 * `getScale()/setScale()` dan `getNaturalSize()` bersemantik PERSIS
 * `model.scale`/`model.width` legacy — framing ENGINE MAIN (R7) bisa dipetakan
 * 1:1 tanpa konversi. (Sebelumnya: tinggi dasar tetap 900 px, gaya golden.) */
function rawCanvasInfo(model: FrameworkModelLike):
  | { widthPx: number; heightPx: number; pixelsPerUnit: number }
  | null {
  try {
    const info = (model.getModel() as { canvasinfo?: {
      CanvasWidth: number; CanvasHeight: number; PixelsPerUnit: number;
    } }).canvasinfo;
    if (info && info.PixelsPerUnit > 0) {
      return { widthPx: info.CanvasWidth, heightPx: info.CanvasHeight, pixelsPerUnit: info.PixelsPerUnit };
    }
  } catch { /* core tanpa canvasinfo — tidak diharapkan; fail di bawah */ }
  return null;
}

export interface ProductionHandleOptions {
  /** Daftar moc yang diterima (untuk diagnostik; loader yang menolak). */
  supportedMocVersions?: readonly MocVersion[];
}

/** Handle produksi — implementasi kontrak Live2DModelHandle (R1+R2). */
export interface ProductionHandle extends Live2DHandleShape {
  /** Internal adapter: sambungkan ke host GL (renderer + tekstur). Dipanggil
   * production.ts dalam loadModel — BUKAN bagian kontrak publik. */
  bindHost(binding: GLHostBinding): void;
  /** Internal adapter: gambar frame ke GL host yang ter-bind. */
  draw(): void;
  /** Internal adapter: ukuran kanvas host berubah. */
  notifyResize(width: number, height: number): void;
  /** Internal adapter: data produksi (untuk diagnostik host). */
  readonly data: ProductionModel;
}

/** Bentuk publik = persis kontrak Live2DModelHandle (types.ts) + update(dt).
 * Didefinisikan ulang di sini agar file tidak meng-import types dua arah
 * (handle ini mengimplementasikan kontrak; types.ts tetap bebas import
 * balik). Guard test membandingkan keys dengan daftar kontrak resmi. */
export interface Live2DHandleShape {
  getMocVersion(): MocVersion | number;
  uses53Pipeline(): boolean;
  getPosition(): Live2DPoint;
  setPosition(x: number, y: number): void;
  getScale(): number;
  setScale(scale: number): void;
  setAnchor(x: number, y: number): void;
  getNaturalSize(): { width: number; height: number };
  setRotation(radian: number): void;
  toGlobal(point: Live2DPoint): Live2DPoint;
  toLocal(point: Live2DPoint): Live2DPoint;
  readParam(id: string): number;
  writeParam(id: string, value: number, weight?: number): void;
  getParameters(): ParameterSnapshot[];
  getParameter(id: string): number | undefined;
  getParameterInfo(id: string): ParameterInfo | undefined;
  setParameter(id: string, value: number): boolean;
  getProfile(): ModelProfile;
  getPartIds(): string[];
  getPartOpacity(id: string): number;
  setPartOpacity(id: string, opacity: number): void;
  onBeforeModelUpdate(cb: () => void): () => void;
  motionGroups(): string[];
  playNativeMotion(group: string, index?: number, priority?: number): boolean;
  isMotionFinished(): boolean;
  stopAllMotions(): void;
  resetExpression(): void;
  playExpression(name: string): boolean;
  setFocus(x: number, y: number): void;
  resetFocus(): void;
  setEffectEnabled(effect: Live2DEffect, enabled: boolean): boolean;
  getName(): string;
  getEyeBlinkParameters(): string[];
  getLipSyncParameters(): string[];
  snapshotCore(): CoreModelSnapshot;
  /** STAGE R2 — lifecycle update: jalankan framework writers + seam
   * beforeModelUpdate + coreModel.update() SATU langkah. Dipanggil pemilik
   * loop (R3+). TIDAK ada loop internal. */
  update(dt: number): void;
  destroy(): void;
}

const VALID_EFFECTS: readonly Live2DEffect[] = ["eyeBlink", "breath", "physics"];

export function createProductionHandle(
  data: ProductionModel,
  env: ProductionEnv,
  _options: ProductionHandleOptions = {},
): ProductionHandle {
  // ── State lifecycle ──
  let destroyed = false;
  let binding: GLHostBinding | null = null;
  const beforeModelUpdateCbs = new Set<() => void>();
  // STEP2 BREATH PARITY — gate breath pasca-seam (default ON, paritas
  // pendaftaran scheduler era sebelumnya yang selalu menambah breath).
  let breathActive = true;

  // ── State transform (R7 yang menyempurnakan parity; R2 = fit golden PPU) ──
  let scale = 1;
  let anchorX = 0.5;
  let anchorY = 0.5;
  /** Posisi titik anchor relatif PUSAT kanvas (px). Default (0,0) = center. */
  let posX = 0;
  let posY = 0;
  let rotation = 0;

  const model = (): FrameworkModelLike => data.user.getModel()!;
  const canvasInfo = rawCanvasInfo(model());
  if (!canvasInfo) {
    throw new Live2DLoadError("unknown", "canvasinfo core tidak terbaca — transform parity R6 butuh PixelsPerUnit");
  }
  const ppuBase = canvasInfo.pixelsPerUnit;
  const naturalSize = () => ({
    width: canvasInfo.widthPx,
    height: canvasInfo.heightPx,
  });
  /** Posisi pusat model di px kanvas: titik anchor + offset anchor. */
  const modelCenter = () => ({
    x: posX + (0.5 - anchorX) * naturalSize().width * scale,
    y: posY + (0.5 - anchorY) * naturalSize().height * scale,
  });

  // ── MVP (pola golden: PPU konstan, seragam) + rotasi via komposisi matriks ──
  const projection: Matrix44Like = env.framework()!.CubismMatrix44
    ? new (env.framework()!.CubismMatrix44)()
    : (null as never);
  const applyProjection = (canvasW: number, canvasH: number) => {
    const ppu = ppuBase * scale;
    const c = modelCenter();
    // clip-space offset (center kanvas → posisi model)
    const tx = c.x / (canvasW / 2);
    const ty = -c.y / (canvasH / 2); // y flip: model y-up → layar y-down
    const sx = (2 * ppu) / canvasW;
    const sy = (2 * ppu) / canvasH;
    if (rotation === 0) {
      projection.loadIdentity();
      projection.scaleRelative(sx, sy);
      projection.translate(tx, ty);
      return;
    }
    // R*S kolom-major (pola tr[] CubismMatrix44): col0=(cos*sx, sin*sx),
    // col1=(-sin*sy, cos*sy), translasi kolom ke-4.
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const tr = new Float32Array(16);
    tr[0] = cos * sx;
    tr[1] = sin * sx;
    tr[4] = -sin * sy;
    tr[5] = cos * sy;
    tr[10] = 1;
    tr[12] = tx;
    tr[13] = ty;
    tr[15] = 1;
    projection.setMatrix(tr);
  };

  const guardLive = (): boolean => !destroyed && !!data.user.getModel();

  // ── Id part (id manager framework — internal) ──
  const partIdOf = (id: string) =>
    env.framework()!.CubismFramework.getIdManager().getId(id);

  const handle: ProductionHandle = {
    data,

    // ── Versi & pipeline (fakta load) ──
    getMocVersion: () => data.mocVersion,
    uses53Pipeline: () => data.mocVersion === 6,

    // ── Transform & framing ──
    getPosition: () => ({ x: posX, y: posY }),
    setPosition(x, y) {
      posX = x;
      posY = y;
    },
    getScale: () => scale,
    setScale(next) {
      scale = next;
    },
    setAnchor(x, y) {
      anchorX = x;
      anchorY = y;
    },
    getNaturalSize: () => ({ ...naturalSize() }),
    setRotation(radian) {
      rotation = radian;
    },
    toGlobal(point) {
      const ppu = ppuBase * scale;
      const c = modelCenter();
      return {
        x: c.x + point.x * ppu,
        y: c.y - point.y * ppu, // y flip
      };
    },
    toLocal(point) {
      const ppu = ppuBase * scale;
      const c = modelCenter();
      return {
        x: (point.x - c.x) / ppu,
        y: -(point.y - c.y) / ppu, // y flip balik
      };
    },

    // ── Parameter Cubism (by-ID; fail-safe tervalidasi) ──
    readParam(id) {
      if (!guardLive()) return 0;
      return data.paramApi.getParameter(id) ?? 0;
    },
    writeParam(id, value, _weight) {
      if (!guardLive()) return;
      data.paramApi.setParameter(id, value, { pin: false });
    },
    getParameters: () => (guardLive() ? data.paramApi.getParameters() : []),
    getParameter(id) {
      if (!guardLive()) return undefined;
      return data.paramApi.getParameter(id);
    },
    getParameterInfo(id) {
      if (!guardLive()) return undefined;
      return data.paramApi.getParameterInfo(id);
    },
    // setParameter: default Phase 8 (pin) — nilai bertahan melawan revert
    // buffer tiap frame (uji manual/panel); tulisan engine per-frame lewat
    // writeParam / arbiter (pin:false).
    setParameter(id, value) {
      if (!guardLive()) return false;
      return data.paramApi.setParameter(id, value);
    },

    // ── Profil (frozen snapshot Phase 9 — fakta load, aman pasca-destroy) ──
    getProfile: () => data.profile,

    // ── Part ──
    getPartIds: () => data.profile.parts.map((p) => p.id),
    getPartOpacity(id) {
      if (!guardLive()) return 0;
      try {
        return model().getPartOpacityById(partIdOf(id));
      } catch {
        return 0;
      }
    },
    setPartOpacity(id, opacity) {
      if (!guardLive()) return;
      try {
        model().setPartOpacityById(partIdOf(id), Math.max(0, Math.min(1, opacity)));
      } catch {
        /* part tidak ada di model — fail-safe */
      }
    },

    // ── Seam beforeModelUpdate (handle hanya menyediakan — tidak komit apa pun) ──
    onBeforeModelUpdate(cb) {
      if (destroyed) return () => {};
      beforeModelUpdateCbs.add(cb);
      return () => beforeModelUpdateCbs.delete(cb);
    },

    // ── Motion native ──
    motionGroups: () => [...data.motionGroups],
    playNativeMotion(group, index = -1, priority = 1) {
      if (!guardLive()) return false;
      const candidates: Array<[string, FrameworkMotionLike]> = [];
      for (const [key, motion] of data.motions) {
        if (key.startsWith(group + "#")) candidates.push([key, motion]);
      }
      if (!candidates.length) return false;
      const pick =
        index >= 0
          ? candidates.find(([key]) => key === group + "#" + index)
          : candidates[Math.floor(Math.random() * candidates.length)];
      if (!pick) return false;
      data.user._motionManager.startMotionPriority(pick[1], false, priority);
      return true;
    },
    isMotionFinished() {
      if (!guardLive()) return true;
      return data.user._motionManager.isFinished();
    },
    stopAllMotions() {
      if (!guardLive()) return;
      data.user._motionManager.stopAllMotions();
    },

    // ── Ekspresi native (.exp3) — framework-owned; synthetic BUKAN di sini ──
    resetExpression() {
      if (!guardLive()) return;
      data.user._expressionManager.stopAllMotions();
    },
    playExpression(name) {
      if (!guardLive()) return false;
      const expr = data.expressions.get(name);
      if (!expr) return false; // nama tak dikenal / model tanpa ekspresi
      data.user._expressionManager.startMotion(expr, false);
      return true;
    },

    // ── Focus (framework drag manager — tanpa parameter write engine) ──
    setFocus(x, y) {
      if (!guardLive()) return;
      try {
        (data.user as unknown as { setDragging(x: number, y: number): void }).setDragging(x, y);
      } catch {
        /* framework tanpa drag manager — fail-safe */
      }
    },
    resetFocus() {
      handle.setFocus(0, 0);
    },

    // ── Gate efek (state updater disimpan — restore = persis sebelumnya) ──
    setEffectEnabled(effect, enabled) {
      if (!guardLive()) return false;
      if (!VALID_EFFECTS.includes(effect)) return false;
      // STEP2 BREATH PARITY — breath kini slot PASCA-SEAM milik handle
      // (bukan anggota scheduler): dieksekusi SETELAH commit arbiter,
      // SEBELUM coreModel.update. Alasan: commit engine absolut menimpa
      // output breath yang ditambah scheduler pra-seam (baseline 3ff89bc
      // mengomposisinya sebaliknya — tulisan absolut engine berada di buffer
      // dasar dan breath ditambah di atasnya tepat sebelum core.update).
      // Gate = flag pada closure handle; updater tetap tersimpan di
      // data.updaters agar destroy/restore semantik R1 tetap.
      if (effect === "breath") {
        if (!data.updaters.breath) return false;
        breathActive = enabled;
        return true;
      }
      const updater = data.updaters[effect];
      if (!updater) return false; // efek tak tersedia di model ini
      const inList = data.scheduler.hasUpdatable(updater);
      if (enabled && !inList) data.scheduler.addUpdatableList(updater);
      if (!enabled && inList) data.scheduler.removeUpdatableList(updater);
      return true;
    },

    // ── Introspeksi (fakta manifest — aman pasca-destroy) ──
    getName: () => data.profile.modelName,
    getEyeBlinkParameters: () => [...data.profile.eyeBlinkParameters],
    getLipSyncParameters: () => [...data.profile.lipSyncParameters],

    // ── Snapshot diagnostik (nilai live dari core; struktur dari profil) ──
    snapshotCore(): CoreModelSnapshot {
      if (!guardLive()) {
        return {
          mocVersion: data.mocVersion,
          combinedRenderOrders: [],
          drawables: [],
          parts: [],
          offscreens: [],
          textureCount: data.profile.textures.length,
          parameterIds: [],
          parameterValues: [],
          parameterRanges: [],
        };
      }
      const m = model();
      const drawables = data.profile.drawables.map((d) => {
        const i = indexOfDrawable(m, d.id);
        return {
          id: d.id,
          textureIndex: d.textureIndex,
          renderOrder: d.renderOrder,
          opacity: safeOp(() =>
            (m as unknown as { getDrawableOpacity(n: number): number }).getDrawableOpacity(i),
          ),
          blendMode: { color: d.colorBlend, alpha: d.alphaBlend },
          multiplyColor: rgbOf(m, i, "getDrawableMultiplyColor"),
          screenColor: rgbOf(m, i, "getDrawableScreenColor"),
          maskIndices: d.maskIndices,
          isInvertedMask: d.invertedMask,
          parentPartIndex: d.parentPartIndex,
          vertexCount: d.vertexCount,
          indexCount: d.indexCount,
        };
      });
      return {
        mocVersion: data.mocVersion,
        combinedRenderOrders: Array.from(m.getRenderOrders()),
        drawables,
        parts: data.profile.parts.map((p) => ({
          id: p.id,
          parentIndex: p.parentIndex,
          opacity: handle.getPartOpacity(p.id),
        })),
        offscreens: data.profile.offscreens.map((o) => ({
          index: o.index,
          ownerIndices: o.ownerIndices,
          opacity: 1,
        })),
        textureCount: data.profile.textures.length,
        parameterIds: data.paramApi.getParameters().map((p) => p.id),
        parameterValues: data.paramApi.getParameters().map((p) => p.value),
        parameterRanges: data.paramApi.getParameters().map((p) => ({
          min: p.min, max: p.max, def: p.defaultValue,
        })),
      };
    },

    // ── Lifecycle update (pemanggil = pemilik loop; TIDAK ada loop internal) ──
    update(dt) {
      if (!guardLive()) return;
      const m = model();
      const st = data.stats;
      st.frames++;
      // Pola golden / resmi: load → motion → save → efek → overrides → seam →
      // breath (pasca-seam) → update
      m.loadParameters();
      const updated = data.user._motionManager.updateMotion(m, dt);
      st.motionUpdates++;
      data.motionUpdated.value = updated; // gate framework EyeBlink (single-owner)
      m.saveParameters();
      data.scheduler.onLateUpdate(m, dt);
      st.schedulerRuns++;
      data.paramApi.applyOverrides();
      // SEAM — posisi kontrak: framework writers SELESAI, core BELUM update.
      // Engine (R3+) memasang arbiter commit di sini. Handle tidak tahu arbiter.
      for (const cb of beforeModelUpdateCbs) {
        cb();
        st.seamCalls++;
      }
      // STEP2 BREATH PARITY — breath ADDITIF dieksekusi SETELAH commit
      // absolut engine, SEBELUM coreModel.update. Bukan writer kedua untuk
      // intent engine dan bukan bypass arbiter: arbiter tetap penulis
      // absolut engine terakhir; breath adalah efek framework yang — seperti
      // baseline 3ff89bc — mengomposisi nilai akhir = nilai engine + sway
      // breath pada ParamAngleX/Y/Z, ParamBodyAngleX, ParamBreath. Satu
      // pemanggilan per frame, tergerbang flag setEffectEnabled("breath").
      if (breathActive && data.updaters.breath) {
        data.updaters.breath.onLateUpdate(m, dt);
      }
      m.update();
      st.coreUpdates++;
    },

    // ── Destroy (bersih; aman dua kali) ──
    destroy() {
      if (destroyed) return;
      destroyed = true;
      beforeModelUpdateCbs.clear();
      if (binding) {
        binding.releaseGLTextures();
        binding = null;
      }
      data.release();
    },

    // ── Internal adapter ──
    bindHost(b) {
      if (destroyed) {
        throw new Live2DLoadError("unknown", "model sudah destroyed — tidak bisa di-bind");
      }
      binding = b;
    },
    draw() {
      if (!guardLive() || !binding) return;
      // R6: MVP di ruang CSS logis (bukan piksel perangkat) — clip space
      // dinormalisasi terhadap viewport; pada res≠1 piksel = res×CSS.
      applyProjection(binding.cssWidth(), binding.cssHeight());
      const renderer = data.user.getRenderer();
      if (!renderer) return;
      binding.beforeDraw();
      renderer.setMvpMatrix(projection);
      renderer.drawModel();
    },
    notifyResize(width, height) {
      if (!guardLive() || !binding) return;
      data.user.setRenderTargetSize(width, height);
    },
  };

  return handle;
}

// ── Helper snapshot (tolan getter framework yang opsional) ─────
function indexOfDrawable(m: FrameworkModelLike, id: string): number {
  const n = m.getDrawableCount();
  for (let i = 0; i < n; i++) {
    if (m.getDrawableId(i).getString() === id) return i;
  }
  return -1;
}

function safeOp(fn: () => number): number {
  try {
    return fn();
  } catch {
    return 0;
  }
}

function rgbOf(
  m: FrameworkModelLike,
  index: number,
  method: "getDrawableMultiplyColor" | "getDrawableScreenColor",
): { r: number; g: number; b: number } {
  try {
    const c = (m as unknown as {
      getDrawableMultiplyColor(n: number): { r: number; g: number; b: number };
      getDrawableScreenColor(n: number): { r: number; g: number; b: number };
    })[method](index);
    return { r: c.r, g: c.g, b: c.b };
  } catch {
    return { r: 1, g: 1, b: 1 };
  }
}

// RendererLike dipakai via data.user.getRenderer() — re-export tipe agar
// import tidak jadi unused (batas duck-type tetap terdokumentasi).
export type { RendererLike };
