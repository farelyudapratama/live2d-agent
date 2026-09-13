/**
 * live2d/model-profile.ts — MODEL INSPECTOR (Phase 9).
 *
 * Menjawab satu pertanyaan: "Model ini punya apa?" — mengubah informasi model
 * yang tersebar (core, manifest, runtime loader) menjadi SATU representasi
 * capability/profile beku yang bisa dibaca engine:
 *
 *   Cubism Model + Manifest + Runtime state
 *            │
 *            ▼
 *   ModelMetadataBacking   ← adapter konkret (cubism-model-inspector.ts)
 *            │
 *            ▼
 *   buildModelProfile()    ← modul ini (murni, nol import)
 *            │
 *            ▼
 *   ModelProfile (deep-frozen snapshot)
 *
 * Aturan mengikat (dari spesifikasi Phase 9):
 *  - PARAMETER DARI PHASE 8: metadata parameter SELALU lewat ParameterApi
 *    (getParameters) — TIDAK ada sistem parameter kedua. Nilai LIVE tidak
 *    disimpan di profile (selalu via getParameter) agar tidak basi (§snapshot).
 *  - MODEL-AGNOSTIC: semua id/range/file berasal dari model & manifest; tidak
 *    ada hard-code id, tidak ada daftar kemampuan per model.
 *  - FAKTA SAJA (NO SEMANTIC GUESSING): profile melaporkan id, jumlah, range,
 *    file, dan flag kemampuan. Kesimpulan makna (role) = Phase 10.
 *  - READ-ONLY: membangun profile tidak boleh memutasi model (tidak ada
 *    setParameter/update di jalur ini).
 *  - BEKU: hasil deep-frozen — konsumen tidak bisa mengubah internal lewat
 *    objek profile.
 *  - KEBENARAN KEMAMPUAN: physics/pose dari state model/aset/runtime; bila
 *    sumber tidak tersedia → "not-verified", BUKAN tebakan true.
 *  - ABSEN = EMPTY: motion/ekspresi/physics yang tidak ada direpresentasikan
 *    konsisten ([] / false), bukan field hilang.
 *  - MILIK INSTANCE: satu profile per instance model — tidak ada global.
 */

import type { ParameterApi, ParameterInfo } from "./parameter-api";

// ── Kontrak data profil (semua polos & beku saat dibangun) ──

export interface PartInfo {
  id: string;
  /** Part induk dalam hierarki model; -1 = akar / tidak diketahui. */
  parentIndex: number;
}

export interface DrawableInfo {
  id: string;
  /** Indeks tekstur (manifest) yang dipakai drawable ini. */
  textureIndex: number;
  /** Posisi pada render order GABUNGAN era 5.3 (drawable + offscreen). */
  renderOrder: number;
  /** Nilai enum blend framework (CubismColorBlend) apa adanya — pemetaan arti
   * operasi hidup di renderer, inspector hanya melaporkan faktanya. */
  colorBlend: number;
  /** Nilai enum blend framework (CubismAlphaBlend) apa adanya. */
  alphaBlend: number;
  /** Indeks drawable yang menjadi mask untuk drawable ini. */
  maskIndices: number[];
  invertedMask: boolean;
  /** Part pemilik (-1 bila tanpa part) — dasar komposit offscreen per-part. */
  parentPartIndex: number;
  vertexCount: number;
  indexCount: number;
}

export interface OffscreenInfo {
  index: number;
  /** Indeks part yang memiliki render target offscreen ini. */
  ownerIndices: number[];
  colorBlend: number;
  alphaBlend: number;
  invertedMask: boolean;
  maskIndices: number[];
}

export interface TextureInfo {
  index: number;
  /** Path file tekstur relatif manifest (apa adanya dari model3.json). */
  path: string;
}

export interface MotionInfo {
  /** Nama grup motion sebagaimana tertulis di manifest. */
  group: string;
  /** Indeks dalam grup. */
  index: number;
  file: string;
}

export interface ExpressionInfo {
  name: string;
  /** Path file .exp3.json relatif manifest, bila manifest menyediakannya. */
  file?: string;
}

/**
 * Flag kemampuan tri-state: true/false dari fakta (aset/runtime), atau
 * "not-verified" bila sumber informasinya tidak tersedia — dilarang menebak.
 */
export type CapabilityFlag = boolean | "not-verified";

export interface ProfileCounts {
  parameters: number;
  parts: number;
  drawables: number;
  offscreens: number;
  textures: number;
  motions: number;
  expressions: number;
}

/**
 * ModelProfile — SNAPSHOT metadata statis milik SATU instance model.
 * Nilai parameter yang hidup TIDAK ada di sini (itu wilayah ParameterApi —
 * getParameter(id) untuk nilai terkini).
 */
export interface ModelProfile {
  /** Nama model sebagaimana diketahui (override pemanggil / nama file). */
  modelName: string;
  /** Versi MOC3 yang terdeteksi saat load (fakta header, bukan tebakan). */
  mocVersion: number;
  /** Metadata parameter DARI Phase 8 ParameterApi — tanpa field value. */
  parameters: ParameterInfo[];
  parts: PartInfo[];
  drawables: DrawableInfo[];
  offscreens: OffscreenInfo[];
  textures: TextureInfo[];
  motions: MotionInfo[];
  expressions: ExpressionInfo[];
  /** Grup resmi EyeBlink/LipSync sebagaimana DINYATAKAN manifest — ini fakta
   * aset (manifest yang menyebutnya), bukan kesimpulan semantik inspector. */
  eyeBlinkParameters: string[];
  lipSyncParameters: string[];
  physics: CapabilityFlag;
  pose: CapabilityFlag;
  counts: ProfileCounts;
}

/**
 * Backing metadata yang harus dipuaskan sumber data model apa pun (Cubism
 * asli lewat adapter, mock lewat test). Semua method READ-ONLY dan hanya
 * dipanggil SEKALI saat buildModelProfile.
 */
export interface ModelMetadataBacking {
  modelName(): string;
  mocVersion(): number;
  parts(): PartInfo[];
  drawables(): DrawableInfo[];
  offscreens(): OffscreenInfo[];
  textures(): TextureInfo[];
  motions(): MotionInfo[];
  expressions(): ExpressionInfo[];
  eyeBlinkParameters(): string[];
  lipSyncParameters(): string[];
  physics(): CapabilityFlag;
  pose(): CapabilityFlag;
}

// ── Builder ──

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const key of Object.keys(v as Record<string, unknown>)) {
      deepFreeze((v as Record<string, unknown>)[key]);
    }
  }
  return v;
}

/**
 * Rakit ModelProfile beku dari ParameterApi (Phase 8) + backing metadata.
 * Read-only terhadap model: hanya memanggil getter. Field `value` dari
 * snapshot Phase 8 DIBUANG — profile menyimpan metadata statis saja; nilai
 * terkini selalu lewat api.getParameter(id).
 */
export function buildModelProfile(
  parameters: ParameterApi,
  meta: ModelMetadataBacking,
): ModelProfile {
  const parameterInfos: ParameterInfo[] = parameters
    .getParameters()
    .map(({ id, min, max, defaultValue }) => ({ id, min, max, defaultValue }));

  const motions = meta.motions();
  const profile: ModelProfile = {
    modelName: meta.modelName(),
    mocVersion: meta.mocVersion(),
    parameters: parameterInfos,
    parts: meta.parts(),
    drawables: meta.drawables(),
    offscreens: meta.offscreens(),
    textures: meta.textures(),
    motions,
    expressions: meta.expressions(),
    eyeBlinkParameters: meta.eyeBlinkParameters(),
    lipSyncParameters: meta.lipSyncParameters(),
    physics: meta.physics(),
    pose: meta.pose(),
    counts: {
      parameters: parameterInfos.length,
      parts: 0,
      drawables: 0,
      offscreens: 0,
      textures: 0,
      motions: motions.length,
      expressions: 0,
    },
  };
  profile.counts.parts = profile.parts.length;
  profile.counts.drawables = profile.drawables.length;
  profile.counts.offscreens = profile.offscreens.length;
  profile.counts.textures = profile.textures.length;
  profile.counts.expressions = profile.expressions.length;
  return deepFreeze(profile);
}

// ── Debug instrumentation (bukan UI Inspector — logging dulu) ──

/** Ringkasan multi-baris untuk log/debug — menjawab pertanyaan §capability. */
export function formatProfileSummary(p: ModelProfile): string {
  const flag = (f: CapabilityFlag) =>
    f === "not-verified" ? "NOT VERIFIED" : f ? "yes" : "no";
  const blendSeen = new Map<string, number>();
  let masked = 0;
  for (const d of p.drawables) {
    const key = `${d.colorBlend}/${d.alphaBlend}`;
    blendSeen.set(key, (blendSeen.get(key) ?? 0) + 1);
    if (d.maskIndices.length > 0) masked++;
  }
  const groups = new Map<string, number>();
  for (const m of p.motions) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  return [
    `MODEL PROFILE — ${p.modelName} (moc v${p.mocVersion})`,
    `parameters: ${p.counts.parameters} | parts: ${p.counts.parts} | drawables: ${p.counts.drawables} | offscreen: ${p.counts.offscreens} | textures: ${p.counts.textures}`,
    `masked drawables: ${masked} | blend color/alpha: ${[...blendSeen].map(([k, n]) => `${k}×${n}`).join(", ") || "-"}`,
    `motions: ${[...groups].map(([g, n]) => `${g}(${n})`).join(", ") || "none"}`,
    `expressions: ${p.counts.expressions ? p.expressions.map((e) => e.name).join(", ") : "none"}`,
    `physics: ${flag(p.physics)} | pose: ${flag(p.pose)}`,
    `eyeBlink(grup resmi manifest): ${p.eyeBlinkParameters.join(", ") || "-"} | lipSync: ${p.lipSyncParameters.join(", ") || "-"}`,
  ].join("\n");
}
