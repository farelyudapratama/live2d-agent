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
 *    no-op senyap (lihat stub.ts).
 *
 * Kontrak ini dirumuskan dari audit pemakaian nyata app.js terhadap stack
 * lama (muat model, transform/framing, tulis param, motion native, ekspresi,
 * focus, settings introspeksi) — bukan desain dari nol.
 */

/** Titik polos ruang layar/model — pengganti bebas-renderer untuk Point. */
export interface Live2DPoint {
  x: number;
  y: number;
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
  destroy(): void;
}

// ── Model ──────────────────────────────────────────────────────
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

  /**
   * Hook tepat SETELAH framework selesai menulis param tiap frame (motion
   * native/physics/blink/breath) dan SEBELUM core di-update jadi vertex —
   * jangkar override guard & raw drive app.js. Balikan: fungsi unregister.
   */
  onBeforeModelUpdate(cb: () => void): () => void;

  // ── Motion native (klip .motion3.json milik model) ──
  /** Nama grup motion yang dikenal manifest (untuk scheduler idle). */
  motionGroups(): string[];
  /** index -1 = acak dalam grup; priority mengikuti semantik stack lama. */
  playNativeMotion(group: string, index?: number, priority?: number): boolean;

  // ── Ekspresi native (.exp3) & focus ──
  resetExpression(): void;
  /** Arah pandang framework (dipakai reset saat toggle mode AI). */
  setFocus(x: number, y: number): void;
  resetFocus(): void;

  // ── Introspeksi settings (dipakai deteksi capability model-agnostic) ──
  /** Nama model dari manifest. */
  getName(): string;
  /** Anggota grup resmi EyeBlink/LipSync — sumber "grup resmi" role-mapping. */
  getEyeBlinkParameters(): string[];
  getLipSyncParameters(): string[];

  /** Bongkar model dan bebaskan asetnya (destroy children+texture+baseTexture
   * pada stack lama — detail renderer disembunyikan). */
  destroy(): void;
}

// ── API puncak ─────────────────────────────────────────────────
export interface Live2DApi {
  /** Versi adapter — stub = "0.0.0-stub". */
  version(): string;
  /** true selama lapisan ini belum punya implementasi nyata. */
  isStub: boolean;
  createHost(options: HostOptions): Live2DHost;
  loadModel(host: Live2DHost, source: ModelSource): Promise<Live2DModelHandle>;
}
