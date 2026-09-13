/**
 * live2d/types.ts — KONTRAK adapter Live2D: lapisan di antara app.js dan Cubism.
 *
 * Arsitektur target:
 *
 *   app.js (legacy)  →  window.__live2dApi  →  Cubism (core + renderer)
 *
 * Dengan lapisan ini, pustaka scene-graph/renderer mana pun menjadi detail
 * implementasi DI BAWAH kontrak — bisa diganti tanpa menyentuh app.js.
 *
 * Aturan kontrak (mengikat):
 *  - BEBAS-RENDERER: hanya angka, string, boolean, objek polos. Tidak ada
 *    tipe/API pustaka scene-graph di sini — renderer (v6 lama, v8 baru,
 *    buatan sendiri) disembunyikan di balik implementasi.
 *  - MODEL-AGNOSTIC: akses parameter hanya by-ID passthrough ke core (id
 *    aktual milik model). Tidak ada id bernomor dan tidak ada konversi
 *    skala — skala referensi (±30/±1) tetap urusan pemanggil (role-mapping
 *    di bundle), bukan adapter.
 *  - FAIL-LOUD: method yang belum diimplementasikan wajib melempar, bukan
 *    no-op senyap (lihat stub.ts). Termasuk kompatibilitas versi: model
 *    dengan moc yang tidak didukung core DITOLAK saat load — tidak pernah
 *    ada lagi stamp versi sebagai solusi kompatibilitas.
 *  - TANGGUNG JAWAB TERBATAS: lapisan ini hanya Cubism Model → Runtime →
 *    Renderer → Canvas. LLM/TTS/lip-sync/agent ada di lapisan lain di atas
 *    app.js — bukan bagian adapter.
 *
 * Kontrak ini dirumuskan dari audit pemakaian nyata app.js terhadap stack
 * lama (muat model, transform/framing, tulis param, motion native, ekspresi,
 * focus, settings introspeksi) dan dari dokumen teknis Cubism 5.3 (moc v6,
 * render order gabungan, blend mode 15+5, Offscreen Drawing, masking HD).
 */

import type {
  CoreInfo,
  CoreModelSnapshot,
  CubismCapabilities,
  MocVersion,
} from "./cubism-core";
import type { ParameterInfo, ParameterSnapshot } from "./parameter-api";
import type { ModelProfile } from "./model-profile";
import type { BackendKind } from "./render-backend";

// Re-export konsep lapisan bawah yang dibutuhkan konsumen API publik.
export type {
  CoreInfo,
  CoreModelSnapshot,
  CubismCapabilities,
  MocVersion,
} from "./cubism-core";
export { SUPPORTED_MOC_VERSIONS } from "./cubism-core";
export type { BackendKind } from "./render-backend";
// Parameter API (Phase 8) — kontrak data model-agnostic (tanpa semantic role).
export type { ParameterInfo, ParameterSnapshot } from "./parameter-api";
// Model Inspector (Phase 9) — profil capability statis per instance.
export type {
  ModelProfile,
  PartInfo,
  DrawableInfo,
  OffscreenInfo,
  TextureInfo,
  MotionInfo,
  ExpressionInfo,
  CapabilityFlag,
} from "./model-profile";

/** Titik polos ruang layar/model — pengganti bebas-renderer untuk Point. */
export interface Live2DPoint {
  x: number;
  y: number;
}

// ── Kesalahan muat (fail-loud bertipe) ─────────────────────────
export type Live2DLoadErrorReason =
  /** Global core tidak ditemukan / tidak siap di halaman ini. */
  | "core-missing"
  /** MOC versi model tidak didukung core atau di luar supportedMocVersions —
   * SOLUSINYA UPDATE CORE, bukan stamp versi. */
  | "moc-unsupported"
  /** Manifest rusak / bukan .model3.json sah. */
  | "manifest-invalid"
  /** Tekstur gagal dimuat/dekode. */
  | "texture-failed"
  /** Gagal lain (pesan di `message`). */
  | "unknown";

export class Live2DLoadError extends Error {
  readonly reason: Live2DLoadErrorReason;
  /** Versi moc model bila diketahui (alasan moc-unsupported). */
  readonly mocVersion?: number;
  constructor(
    reason: Live2DLoadErrorReason,
    message: string,
    mocVersion?: number,
  ) {
    super(message);
    this.name = "Live2DLoadError";
    this.reason = reason;
    this.mocVersion = mocVersion;
  }
}

// ── Opsi adapter ───────────────────────────────────────────────
export interface AdapterOptions {
  /**
   * Batas moc yang dilayani (§20 dokumen teknis). Default: SUPPORTED_MOC_VERSIONS.
   * Contoh: [6] = hanya model 5.3 (pipeline lebih sederhana, model lama ditolak
   * loud). Model di luar daftar → Live2DLoadError "moc-unsupported".
   */
  supportedMocVersions?: readonly MocVersion[];
  /** Backend yang diutamakan; fallback ke webgl2 bila webgpu tak tersedia. */
  preferredBackend?: BackendKind;
  /** Masking resolusi tinggi (§11) — default true bila core mendukung. */
  highDefinitionMasking?: boolean;
}

// ── Host (panggung) ────────────────────────────────────────────
export interface HostOptions {
  /** Elemen <canvas> milik halaman — adapter yang mengambil alih context-nya. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Warna latar (angka 0xRRGGBB atau string CSS); default transparan. */
  background?: number | string;
  /** 0 = transparan (latar dari CSS #stage). Default 0. */
  backgroundAlpha?: number;
  /** Cap resolusi devicePixelRatio (pola lama: min(dpr, 2)). */
  resolution?: number;
  antialias?: boolean;
  /**
   * STAGE R3 — strategi composite:
   *  - "direct" (default): CubismRenderer_WebGL menggambar langsung ke context
   *    WebGL kanvas host.
   *  - "canvas-texture": Cubism menggambar ke kanvas GL offscreen milik host,
   *    compositor v8 (namespace global terisolasi milik loader compositor) menampilkannya
   *    sebagai satu sprite penuh kanvas — pola halaman golden. Compositor
   *    di-init dengan autoStart:false (tanpa ticker tersembunyi).
   */
  composite?: "direct" | "canvas-texture";
}

/**
 * Panggung tempat model hidup. Pemilik satu context render per halaman
 * (app.js hari ini membuat Application sendiri; target akhir: ini yang punya).
 */
export interface Live2DHost {
  /** Ikuti ukuran #stage (window.resize + ResizeObserver di sisi pemanggil). */
  resize(width: number, height: number): void;
  screenSize(): { width: number; height: number };
  /** Latar warna — shim 3 generasi API renderer lama menjadi satu pintu. */
  setBackgroundColor(color: number | string, alpha?: number): void;
  /** Pasang model ke panggung; `at` = urutan layer (0 = paling belakang). */
  add(model: Live2DModelHandle, at?: number): void;
  remove(model: Live2DModelHandle): void;
  /** Render satu frame ke layar — dipanggil loop milik pemanggil; adapter
   * TIDAK memulai rAF sendiri (kebijakan loop: app.js yang punya tick). */
  render(): void;
  /**
   * R7-1 GAP-2 — bbox piksel terang (alpha > 8) dari frame TERAKHIR yang
   * dirender, dalam koordinat PIKSEL PERANGKAT kanvas GL. Pengganti jalur
   * measureHead() emotion-overlay yang dulu (render-texture → extract →
   * getImageData di renderer scene-graph legacy). Caller mengonversi ke CSS dengan membagi
   * resolution (compositeInfo().cubPixels / canvasCss). null bila frame
   * kosong / host sudah destroyed. Jangan dipanggil per-partikel — pola legacy
   * meng-cache per aktivasi efek.
   */
  measureLitBounds(): LitBounds | null;
  destroy(): void;
}

/** Bbox piksel hasil measureLitBounds (koordinat device-pixel, origin GL
 * bawah-kiri sudah dikonversi ke layar atas-kiri). */
export interface LitBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  /** pusat massa x pada pita atas (puncak kepala) — parity anchor legacy */
  topCentroidX: number;
}

// ── Model ──────────────────────────────────────────────────────
/**
 * Efek framework yang bisa di-gate oleh engine. Union tertutup — anggota hanya
 * boleh bertambah dengan bukti caller di engine (aturan R1: tanpa bukti
 * pemanggil, jangan tambah). Bukti caller (ENGINE MAIN, static/js/app.js):
 *  - "eyeBlink" — freeze memutus kedip: `im.eyeBlink = null` (baris 5119) lalu
 *    dipulihkan saat unfreeze (baris 5161);
 *  - "breath"   — freeze memutus napas framework: `im.breath = null` (baris
 *    5130) lalu dipulihkan (baris 5162);
 *  - "physics"  — freeze hanya MENYIMPAN referensi physics (baris 5111) tanpa
 *    memutuskannya; anggota ini disediakan agar gate efek satu pintu, bukan
 *    karena sudah ada pemanggil yang memutuskannya hari ini.
 */
export type Live2DEffect = "eyeBlink" | "breath" | "physics";

/** Sumber muat: manifest settings JSON (hasil rakit buildModelSettings, boleh
 * membawa ekspresi adopsi) ATAU path relatif "model/<nama>/<file>.model3.json". */
export type ModelSource =
  | { kind: "path"; path: string }
  | { kind: "settings"; settings: Record<string, unknown> };

/**
 * Satu model yang hidup. Semua operasi transform/param di app.js hari ini
 * menyentuh objek renderer langsung — di sini semuanya method kontrak.
 */
export interface Live2DModelHandle {
  // ── Versi & pipeline ──
  /** Versi MOC3 model ini (dibaca dari header moc saat load). */
  getMocVersion(): MocVersion | number;
  /** true bila diputar dengan pipeline Cubism 5.3 (moc v6: offscreen+blend
   * lengkap). false = pipeline legacy — BUKAN tebakan, ditentukan saat load. */
  uses53Pipeline(): boolean;

  // ── Transform & framing (kebutuhan frameModel, drag/pinch/wheel) ──
  getPosition(): Live2DPoint;
  setPosition(x: number, y: number): void;
  /** Skala seragam (pemakaian lama hanya pakai scale.set(x)). */
  getScale(): number;
  setScale(scale: number): void;
  /** Anchor 0..1 — dipakai framing di sekitar pusat (setScaleAroundCenter). */
  setAnchor(x: number, y: number): void;
  /** Ukuran natural (bounds TANPA skala) — dasar hitung framing. */
  getNaturalSize(): { width: number; height: number };
  setRotation(radian: number): void;
  /** Konversi titik ruang lokal model ↔ ruang layar (eye-tracking, pinch). */
  toGlobal(point: Live2DPoint): Live2DPoint;
  toLocal(point: Live2DPoint): Live2DPoint;

  // ── Parameter Cubism (by-ID passthrough; makna = urusan pemanggil) ──
  readParam(id: string): number;
  writeParam(id: string, value: number, weight?: number): void;

  // ── Parameter API (Phase 8) ──
  // Layer aman di atas readParam/writeParam: discovery, metadata, write
  // tervalidasi (clamp ke range model, tolak NaN/Infinity, id tak dikenal aman),
  // dan isolasi instance. TIDAK tahu alasan perubahan (user/motion/AI/dst).
  getParameters(): ParameterSnapshot[];
  getParameter(id: string): number | undefined;
  getParameterInfo(id: string): ParameterInfo | undefined;
  setParameter(id: string, value: number): boolean;

  // ── Model Inspector (Phase 9) ──
  // SATU API kanonik — jangan tambah varian inspectModel/getModelCapabilities/
  // getModelInfo. Mengembalikan snapshot capability BEKU milik instance ini:
  // parameter METADATA (dari Parameter API Phase 8, tanpa nilai), parts,
  // drawables, motions, expressions, physics/pose. Read-only; nilai live tetap
  // lewat getParameter(id).
  getProfile(): ModelProfile;

  // ── Part (opacity part = data runtime inti, bukan efek renderer) ──
  getPartIds(): string[];
  getPartOpacity(id: string): number;
  setPartOpacity(id: string, opacity: number): void;

  /**
   * Hook tepat SETELAH framework selesai menulis param tiap frame (motion
   * native/physics/blink/breath) dan SEBELUM core dievaluasi jadi vertex —
   * jangkar override guard & raw drive app.js. Balikan: fungsi unregister.
   */
  onBeforeModelUpdate(cb: () => void): () => void;

  // ── Motion native (klip .motion3.json milik model) ──
  /** Nama grup motion yang dikenal manifest (untuk scheduler idle). */
  motionGroups(): string[];
  /** index -1 = acak dalam grup; priority mengikuti semantik stack lama. */
  playNativeMotion(group: string, index?: number, priority?: number): boolean;
  /**
   * true bila queue motion native sedang TIDAK memutar apa pun (semua entri
   * selesai / queue kosong). Bila implementasi tidak bisa memastikan, kembalikan
   * false — "belum tentu selesai" lebih aman daripada "mengaku selesai".
   * Caller (ENGINE MAIN): gerbang poseAuthority idle tick — static/js/app.js
   * baris 1013–1023 membaca `motionManager.isFinished()` untuk memperpanjang
   * window `clipGateUntil` (+450 ms) selama klip native benar-benar main.
   */
  isMotionFinished(): boolean;
  /**
   * Hentikan SEMUA motion native yang sedang/akan diputar pada model ini.
   * Queue kosong setelahnya; klip DSL MotionRuntime TIDAK tersentuh (itu milik
   * layer lain). Caller (ENGINE MAIN): freeze motion editor — static/js/app.js
   * baris 5118 memanggil `motionManager.stopAllMotions()`.
   */
  stopAllMotions(): void;

  // ── Ekspresi native (.exp3) & focus ──
  resetExpression(): void;
  /**
   * Putar ekspresi native milik model (.exp3) berdasar nama manifest.
   * true = mulai diputar; false = nama tak dikenal / model tanpa ekspresi
   * (fail-safe, tanpa throw — pola setParameter). Caller (ENGINE MAIN):
   * applyExpression cabang ekspresi bawaan — static/js/app.js baris 2313
   * memanggil `model.expression(nativeName)`.
   */
  playExpression(name: string): boolean;
  /** Arah pandang framework (dipakai reset saat toggle mode AI). */
  setFocus(x: number, y: number): void;
  resetFocus(): void;

  // ── Gate efek framework (freeze/unfreeze motion editor) ──
  /**
   * Nyalakan/matikan SATU efek framework pada model ini tanpa menghancurkan
   * state-nya: `false` = efek berhenti menulis parameter mulai update
   * berikutnya; `true` = efek hidup kembali persis seperti sebelum dimatikan
   * (implementasi menyimpan/memulihkan, BUKAN membuat ulang — paritas freeze →
   * unfreeze di engine lama yang menukar referensi referensi obyek yang sama).
   * false bila efek tidak tersedia pada model ini (mis. manifest tanpa
   * physics) — fail-safe, tanpa throw. Union Live2DEffect tertutup: anggota
   * hanya bertambah dengan bukti caller baru di engine.
   */
  setEffectEnabled(effect: Live2DEffect, enabled: boolean): boolean;

  // ── Introspeksi settings (dipakai deteksi capability model-agnostic) ──
  /** Nama model dari manifest. */
  getName(): string;
  /** Anggota grup resmi EyeBlink/LipSync — sumber "grup resmi" role-mapping. */
  getEyeBlinkParameters(): string[];
  getLipSyncParameters(): string[];

  // ── Diagnostik ──
  /** Salinan data model dari core (drawable/part/offscreen/parameter) untuk
   * diagnostik & perencanaan — bukan jalur per-frame (lihat komentar tipe). */
  snapshotCore(): CoreModelSnapshot;

  /** Bongkar model dan bebaskan asetnya (destroy children+texture+baseTexture
   * pada stack lama — detail renderer disembunyikan). */
  destroy(): void;

  /**
   * STAGE R2 — lifecycle update: jalankan SATU langkah framework (motion →
   * efek → seam beforeModelUpdate → evaluasi core). Dipanggil oleh PEMILIK
   * loop (R3+ yang menentukan owner) — handle TIDAK pernah memulai
   * rAF/ticker/interval sendiri (tanpa loop tersembunyi). Posisi seam:
   * framework writers → callbacks (di sini engine kelak mengkomit arbiter)
   * → coreModel.update().
   */
  update(dt: number): void;
}

// ── API puncak ─────────────────────────────────────────────────
/** Gabungan capability Cubism + backend yang hidup (jawaban audit §23:
 * core version? pipeline? blend 5.3? offscreen? masking HD? backend apa?). */
export type RendererCapabilities = CubismCapabilities & {
  /** Backend yang AKTIF — "none" bila adapter belum punya host. */
  backend: BackendKind | "none";
};

export interface Live2DApi {
  /** Versi adapter — stub = "0.0.0-stub". */
  version(): string;
  /** true selama lapisan ini belum punya implementasi nyata. */
  isStub: boolean;
  /** Info core yang terpasang di halaman (versi, moc tertinggi, API order). */
  coreInfo(): CoreInfo;
  /** Capability gabungan core+backend — gate fitur runtime, bukan tebakan. */
  capabilities(): RendererCapabilities;
  createHost(options: HostOptions): Live2DHost;
  /** Gagal → Live2DLoadError dengan reason bertipe (moc tidak didukung =
   * DITOLAK, bukan di-stamp). */
  loadModel(host: Live2DHost, source: ModelSource): Promise<Live2DModelHandle>;
}
