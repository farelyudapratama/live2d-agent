/**
 * live2d/production-model.ts — STAGE R2: loader produksi Live2DModelHandle.
 *
 * Memindahkan pipeline halaman golden renderer resmi (official.html) (proven) ke modul
 * produksi yang bisa dipakai host/handle mana pun — tanpa mengubah satu pun
 * langkah proven-nya:
 *
 *   manifest → CubismModelSettingJson (parser resmi)
 *   → cek versi MOC dari header (fail-loud, tanpa stamp versi)
 *   → CubismUserModel.loadModel (Moc.fromArrayBuffer → Model.fromMoc)
 *   → ParameterApi(createCubismModelBacking(user._model))   (Phase 8, proven)
 *   → buildModelProfile(createCubismInspectorBacking(...))  (Phase 9, proven)
 *   → physics/pose/motion/ekspresi dimuat dari disk (fail-loud bila ada di
 *     manifest tetapi gagal dimuat)
 *   → updater 5.3 (physics/eyeblink/breath/expression/pose) di
 *     CubismUpdateScheduler — urutan resmi CubismUpdateOrder
 *
 * Semua file aset dimuat sekali saat load (motion/ekspresi di-cache supaya
 * playNativeMotion/playExpression sinkron dan tidak fetch saat frame).
 * Rendering (GL) BUKAN bagian modul ini — renderer dibuat host saat bind
 * (production-host.ts). TIDAK ada loop tersembunyi di sini.
 */

import { Live2DLoadError } from "./types";
import {
  SUPPORTED_MOC_VERSIONS,
  type MocVersion,
} from "./cubism-core";
import { ParameterApi } from "./parameter-api";
import { createCubismModelBacking } from "./cubism-parameter-backing";
import { buildModelProfile, type ModelProfile } from "./model-profile";
import { createCubismInspectorBacking } from "./cubism-model-inspector";
import type {
  CoreLike,
  FrameworkBundleLike,
  FrameworkExpressionLike,
  FrameworkModelLike,
  FrameworkMotionLike,
  ProductionEnv,
  SchedulerLike,
  SettingLike,
  UpdaterLike,
  UserModelLike,
} from "./production-env";

/** Hasil load produksi — input tunggal bagi handle/host. */
export interface ProductionModel {
  /** Objek user framework (CubismUserModel) — internal adapter, BUKAN kontrak publik. */
  user: UserModelLike;
  /** Manifest ter-parse — internal adapter. */
  setting: SettingLike;
  /** Versi MOC dari header (fakta load — bukan tebakan). */
  mocVersion: number;
  /** URL absolut manifest — dasar resolve aset relatif. */
  manifestUrl: string;
  /** Parameter API Phase 8 milik instance model ini. */
  paramApi: ParameterApi;
  /** Profil capability beku (Phase 9). */
  profile: ModelProfile;
  /** Cache motion native: key `${group}#${index}`. */
  motions: Map<string, FrameworkMotionLike>;
  /** Cache ekspresi native: key nama manifest. */
  expressions: Map<string, FrameworkExpressionLike>;
  /** Grup motion resmi (urutan manifest). */
  motionGroups: string[];
  /** Scheduler efek 5.3 (physics/eyeblink/breath/expression/pose). */
  scheduler: SchedulerLike;
  /** Updater per efek — referensi DISIMPAN agar gate on/off tidak kehilangan
   * state updater (kontrak setEffectEnabled R1: restore = persis sebelumnya). */
  updaters: {
    eyeBlink: UpdaterLike | null;
    breath: UpdaterLike | null;
    physics: UpdaterLike | null;
    pose: UpdaterLike | null;
    expression: UpdaterLike | null;
    /** R5 — fokus framework (CubismUpdateOrder_Drag): framework-owned, selalu
     * aktif (parity focusController stack lama); bukan bagian union
     * Live2DEffect (tidak ada caller gate). */
    look: UpdaterLike | null;
  };
  /** true bila main motion sedang memperbarui model frame ini — gate framework
   * EyeBlink (paritas sandbox: kedip framework hanya saat motion tidak main). */
  motionUpdated: { value: boolean };
  /** STAGE R4 — instrumen siklus update (exactly-once proof; bukan sumber
   * kebenaran perilaku). Semua counter di-increment TEPAT SEKALI per
   * handle.update() yang hidup. */
  stats: {
    /** panggilan handle.update() yang benar-benar memproses frame */
    frames: number;
    /** motionManager.updateMotion */
    motionUpdates: number;
    /** scheduler.onLateUpdate (semua updater berjalan di dalamnya) */
    schedulerRuns: number;
    /** total invokasi callback seam beforeModelUpdate */
    seamCalls: number;
    /** coreModel.update() */
    coreUpdates: number;
  };
  /** Lepas SEMUA resource model (moc/model/managers/renderer di `user.release()`
   * + scheduler). Aman dipanggil dua kali. */
  release(): void;
}

function requireEnv<T>(value: T | null, what: string, reason: "core-missing" | "unknown"): T {
  if (value == null) {
    throw new Live2DLoadError(reason, what + " tidak tersedia di halaman ini");
  }
  return value;
}

/** Rakit path URL aset relatif manifest. */
function assetUrl(env: ProductionEnv, manifestUrl: string, relative: string): string {
  return env.resolveUrl(manifestUrl, relative.split("\\").join("/"));
}

async function fetchBuffer(
  env: ProductionEnv,
  url: string,
  what: string,
): Promise<ArrayBuffer> {
  try {
    return await env.fetchBytes(url);
  } catch (e) {
    throw new Live2DLoadError(
      "texture-failed",
      what + " gagal dimuat: " + url + " — " + ((e as Error)?.message ?? e),
    );
  }
}

/**
 * Muat satu model dari sumber. Gagal = Live2DLoadError bertipe — TIDAK ADA
 * fallback diam-diam, TIDAK ADA stamp versi (moc di luar daftar didukung
 * ditolak loud, pesannya menyebut versi yang terbaca dari header).
 */
export async function loadProductionModel(
  source: { kind: "path"; path: string } | { kind: "settings"; settings: Record<string, unknown> },
  env: ProductionEnv,
  options: { supportedMocVersions?: readonly MocVersion[] } = {},
): Promise<ProductionModel> {
  const core = requireEnv(env.core(), "Cubism Core", "core-missing");
  const fw = requireEnv(env.framework(), "Cubism Framework 5.3", "unknown");

  // Framework startUp sekali per halaman (idempoten di framework resmi —
  // CubismFramework.startUp melempar bila sudah start; halaman golden juga
  // memanggilnya sekali). Guard sederhana: flag global.
  const gfw = globalThis as { __l2dFrameworkStarted?: boolean };
  if (!gfw.__l2dFrameworkStarted) {
    const option = new fw.Option();
    option.logFunction = (m: string) => console.log("[cubism]", m);
    fw.CubismFramework.startUp(option);
    fw.CubismFramework.initialize();
    gfw.__l2dFrameworkStarted = true;
  }

  // ── Manifest ──
  let manifestUrl: string;
  let manifestBytes: ArrayBuffer;
  if (source.kind === "settings") {
    if (!source.settings) {
      throw new Live2DLoadError("manifest-invalid", "settings kosong");
    }
    const json = JSON.stringify(source.settings);
    manifestBytes = new TextEncoder().encode(json).buffer as ArrayBuffer;
    // R7-1 COMPAT: ENGINE MAIN (buildModelSettings) memasang `settings.url`
    // sebagai basis resolve aset relatif — hormati field itu (parity adopsi
    // .exp3); tanpa url → root situs.
    const su = (source.settings as { url?: string }).url;
    manifestUrl = su ? env.resolveUrl(env.rootUrl(), su) : env.rootUrl();
  } else {
    manifestUrl = env.resolveUrl(env.rootUrl(), source.path.split("\\").join("/"));
    manifestBytes = await fetchBuffer(env, manifestUrl, "manifest");
  }

  let setting: SettingLike;
  try {
    setting = new fw.CubismModelSettingJson(manifestBytes, manifestBytes.byteLength);
  } catch (e) {
    throw new Live2DLoadError(
      "manifest-invalid",
      "manifest gagal di-parse: " + ((e as Error)?.message ?? e),
    );
  }

  // ── MOC: versi dari HEADER dulu, cek dukungan, baru load ──
  const mocUrl = assetUrl(env, manifestUrl, setting.getModelFileName());
  const mocBytes = await fetchBuffer(env, mocUrl, "moc");
  const supported = options.supportedMocVersions ?? SUPPORTED_MOC_VERSIONS;
  let mocVersion: number;
  try {
    mocVersion = core.Version.csmGetMocVersion(mocBytes, mocBytes.byteLength);
  } catch (e) {
    throw new Live2DLoadError(
      "moc-unsupported",
      "header moc tidak terbaca core ini: " + ((e as Error)?.message ?? e),
    );
  }
  if (!(supported as readonly number[]).includes(mocVersion)) {
    throw new Live2DLoadError(
      "moc-unsupported",
      "moc v" + mocVersion + " di luar daftar yang didukung adapter [" +
        supported.join(", ") + "] — SOLUSINYA UPDATE CORE, bukan stamp versi",
      mocVersion,
    );
  }

  // ── User model (proven: loadModel → CubismMoc.create → Model.fromMoc) ──
  const user = new fw.CubismUserModel();
  const mocHeadBefore = Array.from(new Uint8Array(mocBytes, 0, 8));
  user.loadModel(mocBytes);
  const model = user.getModel();
  if (!model) {
    throw new Live2DLoadError(
      "moc-unsupported",
      "moc v" + mocVersion + " ditolak core saat loadModel",
      mocVersion,
    );
  }
  // Bukti integritas byte (pola golden): core tidak boleh mengubah header.
  const mocHeadAfter = Array.from(new Uint8Array(mocBytes, 0, 8));
  if (mocHeadBefore.some((v, i) => v !== mocHeadAfter[i])) {
    throw new Live2DLoadError("unknown", "byte header MOC berubah selama load native", mocVersion);
  }

  // ── Parameter API Phase 8 (proven golden) ──
  const paramApi = new ParameterApi(createCubismModelBacking(model));

  // ── Physics / pose (fail-loud bila ada di manifest tetapi gagal) ──
  // SEBELUM profil: capability physics/pose di inspector dibaca dari state
  // runtime (user._physics/_pose) — profil yang dibangun sebelum load akan
  // salah melaporkan "false" untuk model yang physics-nya dimuat.
  if (setting.isExistPhysicsFile()) {
    const pUrl = assetUrl(env, manifestUrl, setting.getPhysicsFileName()!);
    const buf = await fetchBuffer(env, pUrl, "physics");
    user.loadPhysics(buf, buf.byteLength);
    if (!user._physics) {
      throw new Live2DLoadError("unknown", "physics ada di manifest tetapi gagal dimuat", mocVersion);
    }
  }
  if (setting.isExistPoseFile()) {
    const buf = await fetchBuffer(env, assetUrl(env, manifestUrl, setting.getPoseFileName()!), "pose");
    user.loadPose(buf, buf.byteLength);
    if (!user._pose) {
      throw new Live2DLoadError("unknown", "pose ada di manifest tetapi gagal dimuat", mocVersion);
    }
  }

  // ── Profil Phase 9 (fakta: physics/pose dari state runtime yang sudah final) ──
  const profile = buildModelProfile(
    paramApi,
    createCubismInspectorBacking({
      model: model,
      setting: setting,
      userModel: user,
      mocVersion,
      modelName: source.kind === "path" ? source.path.replace(/^.*[\\/]/, "").replace(/\.model3\.json$/i, "") : undefined,
    }),
  );

  // ── Motion native: preload semua grup (play sinkron, tanpa fetch di frame) ──
  const motions = new Map<string, FrameworkMotionLike>();
  const motionGroups: string[] = [];
  const eyeBlinkIds: unknown[] = [];
  const lipSyncIds: unknown[] = [];
  for (let i = 0; i < setting.getEyeBlinkParameterCount(); i++) {
    eyeBlinkIds.push(setting.getEyeBlinkParameterId(i));
  }
  for (let i = 0; i < setting.getLipSyncParameterCount(); i++) {
    lipSyncIds.push(setting.getLipSyncParameterId(i));
  }
  const gN = setting.getMotionGroupCount();
  for (let g = 0; g < gN; g++) {
    const group = setting.getMotionGroupName(g);
    motionGroups.push(group);
    const mN = setting.getMotionCount(group);
    for (let i = 0; i < mN; i++) {
      const url = assetUrl(env, manifestUrl, setting.getMotionFileName(group, i));
      const buf = await fetchBuffer(env, url, "motion " + group + "[" + i + "]");
      const motion = user.loadMotion(buf, buf.byteLength, group + "_" + i, undefined, undefined, setting, group, i);
      if (!motion) {
        throw new Live2DLoadError("unknown", "motion " + group + "[" + i + "] gagal di-parse", mocVersion);
      }
      motion.setEffectIds(eyeBlinkIds, lipSyncIds);
      motions.set(group + "#" + i, motion);
    }
  }

  // ── Ekspresi native: preload (nama manifest → motion ter-cache) ──
  const expressions = new Map<string, FrameworkExpressionLike>();
  const eN = setting.getExpressionCount();
  for (let i = 0; i < eN; i++) {
    const name = setting.getExpressionName(i);
    const url = assetUrl(env, manifestUrl, setting.getExpressionFileName(i));
    const buf = await fetchBuffer(env, url, "expression " + name);
    const expr = user.loadExpression(buf, buf.byteLength, name);
    if (!expr) {
      throw new Live2DLoadError("unknown", "expression " + name + " gagal di-parse", mocVersion);
    }
    expressions.set(name, expr);
  }

  // ── Updater 5.3 (urutan resmi CubismUpdateOrder) ──
  // eyeBlink = PEMILIK KEDIP SAAT ADA (single-owner invariant Phase 13);
  // updater-nya digerbang `motionUpdated` — paritas sandbox & stack legacy
  // (blink framework hanya saat main motion tidak memperbarui model).
  const scheduler = new fw.CubismUpdateScheduler();
  const motionUpdated = { value: false };
  const updaters: ProductionModel["updaters"] = {
    eyeBlink: null, breath: null, physics: null, pose: null, expression: null,
    look: null,
  };
  if (eyeBlinkIds.length) {
    const eyeBlink = fw.CubismEyeBlink.create(setting);
    if (eyeBlink) {
      updaters.eyeBlink = new fw.CubismEyeBlinkUpdater(() => motionUpdated.value, eyeBlink);
      scheduler.addUpdatableList(updaters.eyeBlink);
    }
  }
  if (eN > 0 && user._expressionManager) {
    updaters.expression = new fw.CubismExpressionUpdater(user._expressionManager);
    scheduler.addUpdatableList(updaters.expression);
  }
  // Breath: parameter default resmi Cubism (CubismDefaultParameterId — id
  // kanonik, bukan tebakan model; id yang tidak dimiliki model = no-op core).
  const breath = fw.CubismBreath.create();
  const idOf = (name: string) =>
    fw.CubismFramework.getIdManager().getId(fw.CubismDefaultParameterId[name] || name);
  breath.setParameters([
    new fw.BreathParameterData(idOf("ParamAngleX"), 0.0, 15.0, 6.5345, 0.5),
    new fw.BreathParameterData(idOf("ParamAngleY"), 0.0, 8.0, 3.5345, 0.5),
    new fw.BreathParameterData(idOf("ParamAngleZ"), 0.0, 10.0, 5.5345, 0.5),
    new fw.BreathParameterData(idOf("ParamBodyAngleX"), 0.0, 4.0, 15.5345, 0.5),
    new fw.BreathParameterData(idOf("ParamBreath"), 0.5, 0.5, 3.2345, 1.0),
  ]);
  updaters.breath = new fw.CubismBreathUpdater(breath);
  // STEP2 BREATH PARITY — breath TIDAK didaftarkan ke scheduler. Handle
  // memilikinya sebagai slot PASCA-SEAM (setelah commit absolut engine,
  // sebelum coreModel.update) — paritas komposisi baseline 3ff89bc yang
  // menambahkan breath di atas tulisan engine, bukan di bawahnya. Gate:
  // setEffectEnabled("breath") → flag di handle.
  if (user._physics) {
    updaters.physics = new fw.CubismPhysicsUpdater(user._physics);
    scheduler.addUpdatableList(updaters.physics);
  }
  if (user._pose) {
    updaters.pose = new fw.CubismPoseUpdater(user._pose);
    scheduler.addUpdatableList(updaters.pose);
  }
  // ── R5 FOCUS (framework-owned, CubismUpdateOrder_Drag) ──
  // CubismLook menulis parameter pandangan dari dragManager MILIK user —
  // jalur yang sama dengan focusController stack lama. Id kanonik Cubism via
  // CubismDefaultParameterId (param yang tidak dimiliki model = no-op core);
  // faktor = nilai standar sampel resmi (angle ±30, eyeball ±1, body ±4).
  const look = fw.CubismLook.create();
  const lookIdOf = (name: string) =>
    fw.CubismFramework.getIdManager().getId(fw.CubismDefaultParameterId[name] || name);
  look.setParameters([
    new fw.LookParameterData(lookIdOf("ParamAngleX"), 30, 0, 0),
    new fw.LookParameterData(lookIdOf("ParamAngleY"), 0, 30, 0),
    new fw.LookParameterData(lookIdOf("ParamAngleZ"), 0, -30, 0),
    new fw.LookParameterData(lookIdOf("ParamEyeBallX"), 1, 0, 0),
    new fw.LookParameterData(lookIdOf("ParamEyeBallY"), 0, 1, 0),
    new fw.LookParameterData(lookIdOf("ParamBodyAngleX"), 4, 0, 0),
  ]);
  updaters.look = new fw.CubismLookUpdater(look, user._dragManager);
  scheduler.addUpdatableList(updaters.look);
  scheduler.sortUpdatableList();

  return {
    user,
    setting,
    mocVersion,
    manifestUrl,
    paramApi,
    profile,
    motions,
    expressions,
    motionGroups,
    scheduler,
    updaters,
    motionUpdated,
    stats: {
      frames: 0,
      motionUpdates: 0,
      schedulerRuns: 0,
      seamCalls: 0,
      coreUpdates: 0,
    },
    release() {
      scheduler.release();
      fw.CubismLook.delete(look);
      motions.clear();
      expressions.clear();
      user.deleteRenderer();
      user.release();
    },
  };
}
