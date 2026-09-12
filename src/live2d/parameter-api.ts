/**
 * live2d/parameter-api.ts — PARAMETER API (Phase 8).
 *
 * Lapisan di atas Cubism Runtime yang memberi engine/consumer akses parameter
 * model yang stabil dan model-agnostic:
 *
 *   Engine / Consumer
 *          │
 *          ▼
 *   Live2D Model API  (Live2DModelHandle — kontrak adapter)
 *          │
 *          ▼
 *   Parameter API    ← modul ini
 *          │
 *          ▼
 *   Cubism Model     (CubismModel / backing apapun)
 *          │
 *          ▼
 *   model.update() → renderer
 *
 * Aturan mengikat (dari spesifikasi Phase 8):
 *  - TIDAK TAHU ALASAN: API menerima (id, value) tanpa peduli apakah angka
 *    berasal dari user, motion, emotion, role-mapping, AI, atau physics. Itu
 *    urusan layer lain (Phase 10/11/12/13).
 *  - MODEL-AGNOSTIC: ID, min, max, default diambil DARI model (backing), tidak
 *    pernah di-hard-code. Tidak ada id bernomor, tidak ada konversi skala.
 *  - RANGE = KONSTRAIN MODEL: clamp ke [min, max] milik parameter adalah
 *    "model range constraint" (bukan semantic/role clamp — itu Phase 10).
 *  - READ-ONLY SAFE: getParameters/getParameter/getParameterInfo tidak mengubah
 *    state model.
 *  - FAIL-SAFE: NaN/Infinity ditolak; ID tak dikenal → false (tanpa throw,
 *    tanpa membuat parameter baru, tanpa menyentuh parameter lain).
 *  - ISOLASI INSTANCE: state parameter milik instance model (backing), bukan
 *    global mutable.
 *  - LIFECYCLE: setelah dispose(), semua panggilan aman (false / undefined),
 *    tidak ada reference ke Cubism model yang sudah dihancurkan.
 *
 * API ini BEBAS dari pustaka renderer/scene-graph dan BEBAS dari Cubism
 * (hanya bergantung pada CubismParameterBacking — interface polos). Adapter
 * konkret ke CubismModel ada di cubism-parameter-backing.ts terpisah, supaya
 * modul ini bisa dites dengan mock tanpa WASM/core.
 */

// ── Kontrak data (tanpa semantic role — role mapping = Phase 10) ──
export interface ParameterInfo {
  /** ID asli Cubism milik model (model-agnostic). */
  id: string;
  min: number;
  max: number;
  defaultValue: number;
}

export interface ParameterSnapshot extends ParameterInfo {
  /** Nilai aktual pada instance model. */
  value: number;
}

/**
 * Backing minimal yang harus dipuaskan model Cubism apa pun supaya ParameterApi
 * bisa bekerja. CubismModel resmi memenuhinya (lihat
 * cubism-parameter-backing.ts); mock memenuhinya untuk test. Semua nilai
 * didefinisikan model — API tidak pernah meng-hard-code range/default.
 */
export interface CubismParameterBacking {
  /** Jumlah parameter model. */
  getParameterCount(): number;
  /** ID string pada indeks 0..count-1 (urutan model). */
  getParameterId(index: number): string;
  /** Nilai aktual parameter id (number). */
  getParameterValue(id: string): number;
  /** Batas bawah parameter id. */
  getParameterMinimum(id: string): number;
  /** Batas atas parameter id. */
  getParameterMaximum(id: string): number;
  /** Nilai default parameter id. */
  getParameterDefault(id: string): number;
  /** Tulis nilai mentah ke parameter (TANPA clamp — API yang clamp). */
  setParameterValue(id: string, value: number): void;
  /** Majukan model satu langkah (Cubism: model.update()). */
  update(): void;
  /** Opsional: true bila model masih hidup (untuk lifecycle). */
  isAlive?(): boolean;
}

export interface SetParameterOptions {
  /**
   * Bila true (default), nilai dipin secara internal dan di-re-apply tiap
   * frame lewat applyOverrides() SEBELUM backing.update() — sehingga nilai
   * bertahan melawan motion/physics/breath yang menulis parameter tiap frame.
   * Ini praktis untuk uji manual Phase 8 ("set lalu lihat hasil"). Untuk
   * tulisan satu-frame (mis. sekali lewat), set pin:false.
   */
  pin?: boolean;
}

/**
 * ParameterApi — implementasi tunggal Parameter API Phase 8.
 *
 * Satu instans per instance model (backing). State override milik instans ini,
 * bukan global → dua model tidak saling pengaruh (§8.11).
 */
export class ParameterApi {
  private backing: CubismParameterBacking | null;
  private disposed = false;
  /** Daftar override ter-pin (id → nilai clamped). Diterapkan tiap frame. */
  private overrides = new Map<string, number>();
  /** Cache ID model (parameter model immutable per load). null = belum build. */
  private idCache: string[] | null = null;

  constructor(backing: CubismParameterBacking) {
    this.backing = backing;
  }

  // ── Discovery & read (read-only, tidak ubah state) ──

  /** Seluruh parameter instance model: id, value, min, max, defaultValue. */
  getParameters(): ParameterSnapshot[] {
    if (!this.isAlive()) return [];
    const b = this.backing!;
    return this.ids().map((id) => ({
      id,
      value: b.getParameterValue(id),
      min: b.getParameterMinimum(id),
      max: b.getParameterMaximum(id),
      defaultValue: b.getParameterDefault(id),
    }));
  }

  /** Nilai aktual parameter, atau undefined bila id tak dikenal / model mati. */
  getParameter(id: string): number | undefined {
    if (!this.isAlive()) return undefined;
    if (!this.hasId(id)) return undefined;
    return this.backing!.getParameterValue(id);
  }

  /** Metadata parameter (tanpa nilai), atau undefined bila id tak dikenal. */
  getParameterInfo(id: string): ParameterInfo | undefined {
    if (!this.isAlive()) return undefined;
    if (!this.hasId(id)) return undefined;
    const b = this.backing!;
    return {
      id,
      min: b.getParameterMinimum(id),
      max: b.getParameterMaximum(id),
      defaultValue: b.getParameterDefault(id),
    };
  }

  // ── Write ──

  /**
   * Ubah nilai parameter. Mengembalikan true bila berhasil diterapkan, false
   * bila gagal (id tak dikenal / nilai NaN-Infinity / model mati). Tidak pernah
   * throw ke renderer.
   *
   * @param id    ID parameter asli model.
   * @param value Nilai numerik.
   * @param opts  pin (default true) — lihat SetParameterOptions.
   */
  setParameter(
    id: string,
    value: number,
    opts: SetParameterOptions = {},
  ): boolean {
    if (!this.isAlive()) return false;

    // §8.9 — unknown id: safe failure, no throw, no new param, no other mutation.
    if (!this.hasId(id)) return false;

    // §8.8 — NaN / Infinity / -Infinity ditolak; nilai lama lestari.
    if (!Number.isFinite(value)) return false;

    const b = this.backing!;
    const min = b.getParameterMinimum(id);
    const max = b.getParameterMaximum(id);

    // §8.7 — model range constraint (bukan semantic/role clamp).
    const clamped = value < min ? min : value > max ? max : value;

    b.setParameterValue(id, clamped);

    if (opts.pin !== false) this.overrides.set(id, clamped);
    return true;
  }

  /**
   * Re-apply semua override ter-pin ke backing. Consumer memanggil ini tiap
   * frame TEPAT SEBELUM backing.update() agar nilai pin bertahan terhadap
   * motion/physics/breath. Aman dipanggil bila tidak ada override (no-op).
   */
  applyOverrides(): void {
    if (!this.isAlive()) return;
    const b = this.backing!;
    for (const [id, v] of this.overrides) b.setParameterValue(id, v);
  }

  /** Lepas satu / semua override pin (nilai kembali dikuasai motion/phy). */
  clearOverride(id?: string): void {
    if (id === undefined) this.overrides.clear();
    else this.overrides.delete(id);
  }

  /** true bila id sedang di-pin. */
  hasOverride(id: string): boolean {
    return this.overrides.has(id);
  }

  /** Daftar id yang sedang di-pin. */
  pinnedIds(): string[] {
    return [...this.overrides.keys()];
  }

  // ── Lifecycle ──

  /**
   * Bongkar API: lepas semua override, putus reference ke backing/Cubism model.
   * Panggil saat model di-destroy agar tidak ada reference menggantung (§8.12).
   */
  dispose(): void {
    this.overrides.clear();
    this.backing = null;
    this.idCache = null;
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  // ── Intern ──

  private isAlive(): boolean {
    if (this.disposed) return false;
    if (!this.backing) return false;
    if (this.backing.isAlive && !this.backing.isAlive()) return false;
    return true;
  }

  /** Cache ID model (parameter tidak berubah selama model hidup). */
  private ids(): string[] {
    if (this.idCache) return this.idCache;
    const b = this.backing!;
    const n = b.getParameterCount();
    const out: string[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = b.getParameterId(i);
    this.idCache = out;
    return out;
  }

  private hasId(id: string): boolean {
    return this.ids().includes(id);
  }
}

/**
 * Format tabel debug parameter (§8.16) — cukup logging/console, bukan UI
 * Inspector (Inspector = Phase 9). Contoh output:
 *
 *   ID              Value     Range
 *   ParamAngleX     15.00     [-30,30]
 *   ParamAngleY    -10.00     [-30,30]
 *   ParamEyeLOpen    0.00     [0,1]
 */
export function formatParameterTable(snapshots: ParameterSnapshot[]): string {
  const idW = Math.max(2, ...snapshots.map((s) => s.id.length));
  const lines: string[] = [];
  lines.push(
    `${"ID".padEnd(idW)}  ${"Value".padStart(8)}  ${"Range"}`,
  );
  for (const s of snapshots) {
    const v = s.value.toFixed(2).padStart(8);
    lines.push(
      `${s.id.padEnd(idW)}  ${v}  [${s.min},${s.max}]`,
    );
  }
  return lines.join("\n");
}
