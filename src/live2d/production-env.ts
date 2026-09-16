/**
 * live2d/production-env.ts — batas lingkungan untuk adapter produksi R2.
 *
 * Adapter produksi hidup DI ATAS dua sumber global halaman (pola yang sama
 * dengan halaman golden renderer resmi (official.html) — proven pipeline):
 *
 *   window.Live2DCubismCore      → Cubism Core (WASM) — dimuat script tag
 *   window.CubismFrameworkBundle → framework resmi 5.3 (cubism-framework.js)
 *
 * Modul ini mendefinisikan DUA hal:
 *  1. Kontrak duck-type MINIMAL dari kedua sumber itu — hanya member yang
 *     benar-benar dipanggil adapter. Tidak ada import statis ke folder
 *     `cubismframework/` (file itu sengaja di-exclude dari tsc — melihat
 *     tsconfig.json), sehingga type-check tetap bersih dan batas modul
 *     tetap jelas.
 *  2. `ProductionEnv` — penyedia lingkungan yang bisa disuntik. Default
 *     membaca global halaman; test Bun menyuntik core hasil vm (WASM nyata)
 *     dan namespace framework hasil import dinamis. TIDAK ada fallback
 *     diam-diam: kalau core/framework tidak ada, pemanggil gagal LOUD
 *     (Live2DLoadError "core-missing" / Error) — sesuai budaya fail-loud.
 *
 * BEBAS-RENDERER: tidak ada satu pun tipe pustaka scene-graph di sini.
 */

// ── Duck-type: Cubism Core (global Live2DCubismCore) ───────────
export interface CoreVersionLike {
  csmGetVersion(): number;
  csmGetLatestMocVersion(): number;
  csmGetMocVersion(moc: ArrayBuffer, mocSize: number): number;
}

export interface CoreLike {
  Version: CoreVersionLike;
}

// ── Duck-type: objek runtime framework yang dipakai adapter ────
/** CubismIdHandle (framework) — hanya getString() yang diandalkan. */
export interface CubismIdLike {
  getString(): string;
}

/** CubismModel (framework) — lapisan di atas core model. */
export interface FrameworkModelLike {
  loadParameters(): void;
  saveParameters(): void;
  update(): void;
  getCanvasWidth(): number;
  getCanvasHeight(): number;
  getParameterCount(): number;
  getParameterId(index: number): CubismIdLike;
  getParameterMinimumValue(index: number): number;
  getParameterMaximumValue(index: number): number;
  getParameterDefaultValue(index: number): number;
  getParameterValueByIndex(index: number): number;
  setParameterValueByIndex(index: number, value: number, weight: number): void;
  getPartCount(): number;
  getPartId(index: number): CubismIdLike;
  getPartOpacityById(partId: CubismIdLike): number;
  setPartOpacityById(partId: CubismIdLike, opacity: number): void;
  // kebutuhan inspector (createCubismInspectorBacking):
  getPartParentPartIndices(): ArrayLike<number>;
  getDrawableCount(): number;
  getDrawableId(index: number): CubismIdLike;
  getDrawableTextureIndex(index: number): number;
  getRenderOrders(): ArrayLike<number>;
  getDrawableColorBlend(index: number): number;
  getDrawableAlphaBlend(index: number): number;
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
  getModel(): unknown;
}

/** CubismMotion (hasil loadMotion) — cukup setEffectIds. */
export interface FrameworkMotionLike {
  setEffectIds(eyeBlinkIds: unknown[], lipSyncIds: unknown[]): void;
}

/** Ekspresi (hasil loadExpression) — ACubismMotion; tidak ada method yang
 * dipanggil adapter selain meneruskan ke manager. */
export interface FrameworkExpressionLike {
  readonly _sourceFrameRate?: number;
}

export interface MotionManagerLike {
  startMotionPriority(
    motion: unknown,
    autoDelete: boolean,
    priority: number,
  ): unknown;
  updateMotion(model: FrameworkModelLike, deltaTimeSeconds: number): boolean;
  isFinished(): boolean;
  stopAllMotions(): void;
}

export interface ExpressionManagerLike {
  startMotion(motion: unknown, autoDelete: boolean): unknown;
  updateMotion(model: FrameworkModelLike, deltaTimeSeconds: number): boolean;
  isFinished(): boolean;
  stopAllMotions(): void;
}

/** CubismUserModel — bidang protected diakses lewat duck-type (pola sandbox:
 * `user._model`, `user._motionManager`, dst. — sengaja dipertahankan karena
 * begitulah pipeline golden terbukti). */
export interface UserModelLike {
  loadModel(buffer: ArrayBuffer, shouldCheckMocConsistency?: boolean): void;
  loadMotion(
    buffer: ArrayBuffer,
    size: number,
    name: string,
    onFinishedMotionHandler?: unknown,
    onBeganMotionHandler?: unknown,
    modelSetting?: unknown,
    group?: string,
    index?: number,
  ): FrameworkMotionLike | null;
  loadExpression(
    buffer: ArrayBuffer,
    size: number,
    name: string,
  ): FrameworkExpressionLike | null;
  loadPhysics(buffer: ArrayBuffer, size: number): void;
  loadPose(buffer: ArrayBuffer, size: number): void;
  getModel(): FrameworkModelLike | null;
  createRenderer(width: number, height: number, maskBufferCount?: number): void;
  deleteRenderer(): void;
  getRenderer(): RendererLike | null;
  setRenderTargetSize(width: number, height: number): void;
  release(): void;
  readonly _model: FrameworkModelLike | null;
  readonly _motionManager: MotionManagerLike;
  readonly _expressionManager: ExpressionManagerLike;
  readonly _physics: unknown;
  readonly _pose: unknown;
  /** R5 — target fokus framework (CubismTargetPoint): di konsumsi
   * CubismLookUpdater (Drag) → parameter pandangan. */
  readonly _dragManager: {
    set(x: number, y: number): void;
    getX(): number;
    getY(): number;
  };
}

/** CubismModelSettingJson. */
export interface SettingLike {
  getModelFileName(): string;
  getTextureCount(): number;
  getTextureFileName(index: number): string;
  getMotionGroupCount(): number;
  getMotionGroupName(index: number): string;
  getMotionCount(group: string): number;
  getMotionFileName(group: string, index: number): string;
  getMotionFadeInTimeValue(group: string, index: number): number;
  getMotionFadeOutTimeValue(group: string, index: number): number;
  getExpressionCount(): number;
  getExpressionName(index: number): string;
  getExpressionFileName(index: number): string;
  getEyeBlinkParameterCount(): number;
  getEyeBlinkParameterId(index: number): CubismIdLike;
  getLipSyncParameterCount(): number;
  getLipSyncParameterId(index: number): CubismIdLike;
  getPhysicsFileName(): string | null;
  getPoseFileName(): string | null;
  isExistPhysicsFile(): boolean;
  isExistPoseFile(): boolean;
}

/** CubismRenderer_WebGL. */
export interface RendererLike {
  startUp(gl: unknown): void;
  loadShaders(shaderPath?: string): void;
  /** Paritas baseline (3ff89bc) & sample resmi: tekstur diupload
   * premultiplied, jadi renderer WAJIB beroperasi dengan invariant yang sama. */
  setIsPremultipliedAlpha(enable: boolean): void;
  bindTexture(modelTextureNo: number, glTexture: unknown): void;
  setMvpMatrix(matrix44: unknown): void;
  drawModel(shaderPath?: string): void;
  setRenderTargetSize(width: number, height: number): void;
  release(): void;
}

/** ICubismUpdater (physics/eyeblink/breath/expression/pose updater). */
export interface UpdaterLike {
  onLateUpdate(model: FrameworkModelLike, deltaTimeSeconds: number): void;
}

/** CubismUpdateScheduler. */
export interface SchedulerLike {
  addUpdatableList(updatable: UpdaterLike): void;
  removeUpdatableList(updatable: UpdaterLike): boolean;
  hasUpdatable(updatable: UpdaterLike): boolean;
  sortUpdatableList(): void;
  onLateUpdate(model: FrameworkModelLike, deltaTimeSeconds: number): void;
  getUpdatableCount(): number;
  release(): void;
}

export interface Matrix44Like {
  loadIdentity(): void;
  scaleRelative(x: number, y: number): void;
  translate(x: number, y: number): void;
  setMatrix(tr: Float32Array): void;
}

export interface EyeBlinkLike {
  readonly _parameterIds: CubismIdLike[];
}

export interface BreathLike {
  setParameters(params: unknown[]): void;
}

// ── Duck-type: compositor v8 (namespace terisolasi window.__compositor8) ────
/** STAGE R3 — composite "canvas-texture": kanvas GL Cubism offscreen →
 * Texture.from(canvas) → Sprite penuh kanvas. Kontrak duck-type minimal;
 * init dengan autoStart:false WAJIB (tanpa ticker tersembunyi — render
 * selalu eksplisit lewat renderer.render). */
export interface CompositorAppLike {
  init(options: {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    backgroundAlpha?: number;
    background?: number | string;
    antialias?: boolean;
    resolution?: number;
    autoStart?: boolean;
  }): Promise<void>;
  canvas: HTMLCanvasElement;
  stage: unknown;
  /** Diagnostik R3-G: ticker harus started=false (autoStart:false). */
  ticker?: { started: boolean };
  renderer: {
    render(container: unknown): void;
    resize(width: number, height: number): void;
    destroy(rendererDestroyOptions?: unknown): void;
  };
  destroy(rendererDestroyOptions?: unknown, stageDestroyOptions?: unknown): void;
}

export interface CompositorLike {
  /** Versi compositor (string semver) — bukti namespace di smoke. */
  readonly VERSION?: string;
  Application: new () => CompositorAppLike;
  Texture: { from(source: unknown): { source?: { update?(): void } } };
  Sprite: new (texture: unknown) => {
    width: number;
    height: number;
    destroy(): void;
  };
}

// ── Duck-type: namespace framework (CubismFrameworkBundle) ─────
/**
 * Permukaan publik framework yang dipakai adapter. Anggota = persis yang
 * halaman golden pakai (proven) + updater pose/expression (arsitektur resmi
 * 5.3 — CubismUpdateOrder). Tidak ada yang lain.
 */
export interface FrameworkBundleLike {
  CubismFramework: {
    startUp(option?: unknown): number;
    initialize(): void;
    getIdManager(): { getId(id: string | CubismIdLike): CubismIdLike };
  };
  Option: new () => {
    logFunction?: (message: string) => void;
    loggingLevel?: number;
  };
  CubismUserModel: new () => UserModelLike;
  CubismModelSettingJson: new (buffer: ArrayBuffer, size: number) => SettingLike;
  CubismMatrix44: new () => Matrix44Like;
  CubismEyeBlink: { create(setting: SettingLike): EyeBlinkLike | null };
  CubismBreath: { create(): BreathLike };
  BreathParameterData: new (
    parameterId: CubismIdLike,
    offset: number,
    peak: number,
    cycle: number,
    weight: number,
  ) => unknown;
  CubismEyeBlinkUpdater: new (
    motionUpdated: () => boolean,
    eyeBlink: EyeBlinkLike,
  ) => UpdaterLike;
  CubismBreathUpdater: new (breath: BreathLike) => UpdaterLike;
  CubismPhysicsUpdater: new (physics: unknown) => UpdaterLike;
  CubismPoseUpdater: new (pose: unknown) => UpdaterLike;
  CubismExpressionUpdater: new (expressionManager: ExpressionManagerLike) => UpdaterLike;
  CubismLookUpdater: new (look: unknown, dragManager: unknown) => UpdaterLike;
  CubismLook: { create(): { setParameters(params: unknown[]): void }; delete(i: unknown): void };
  LookParameterData: new (
    parameterId: CubismIdLike,
    factorX?: number,
    factorY?: number,
    factorXY?: number,
  ) => unknown;
  CubismUpdateScheduler: new () => SchedulerLike;
  CubismDefaultParameterId: Record<string, string>;
}

// ── Lingkungan produksi (penyedia yang bisa disuntik) ──────────
export interface ProductionEnv {
  /** Core Cubism — WAJIB ada (gagal loud bila null saat dipakai). */
  core(): CoreLike | null;
  /** Framework resmi 5.3 — WAJIB ada (gagal loud bila null saat dipakai). */
  framework(): FrameworkBundleLike | null;
  /** Ambil bytes dari URL model aset. */
  fetchBytes(url: string): Promise<ArrayBuffer>;
  /** Decode gambar tekstur → TexImageSource (browser: createImageBitmap). */
  fetchImage(url: string): Promise<TexImageSource>;
  /** Gabung URL relatif dengan URL manifest. */
  resolveUrl(base: string, relative: string): string;
  /** Akar URL situs untuk ModelSource {kind:"path"} (diakhiri "/"). */
  rootUrl(): string;
  /** Compositor v8 untuk composite "canvas-texture" — null bila namespace
   * terisolasi tidak dimuat halaman (mode "direct" tidak memanggil ini). */
  compositor?(): CompositorLike | null;
}

// ── Env default halaman browser — global script tag (pola halaman golden) ──
export function createDefaultProductionEnv(): ProductionEnv {
  const g = globalThis as {
    Live2DCubismCore?: CoreLike;
    CubismFrameworkBundle?: FrameworkBundleLike;
    __compositor8?: CompositorLike;
  };
  return {
    core: () => g.Live2DCubismCore ?? null,
    framework: () => g.CubismFrameworkBundle ?? null,
    compositor: () => g.__compositor8 ?? null,
    fetchBytes: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error("fetch gagal " + res.status + ": " + url);
      return res.arrayBuffer();
    },
    fetchImage: async (url) => {
      const blob = await (await fetch(url)).blob();
      return createImageBitmap(blob);
    },
    resolveUrl: (base, relative) => new URL(relative, base).href,
    rootUrl: () => new URL("./", location.href).href,
  };
}
