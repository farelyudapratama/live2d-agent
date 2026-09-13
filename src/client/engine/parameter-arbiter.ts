/**
 * engine/parameter-arbiter.ts — Phase 13 STAGE 0: fondasi Parameter Arbiter.
 *
 * SATU titik resolusi + komit untuk semua intent tulisan parameter dari JS.
 * Stage 0 TIDAK memigrasikan writer lama (idle loop / sticky / rawDrive tetap
 * jalan) — modul ini adalah target migrasi Stage 1+ dan komitnya dipasang di
 * slot `beforeModelUpdate` engine (app.js) yang secara kontrak berjalan:
 *
 *   framework writers (native motion/ekspresi/blink/breath/physics)
 *     → ARBITER resolve/commit        ← slot ini
 *     → coreModel.update()
 *     → render
 *
 * Aturan resolusi (paritas dengan `combinedDelta` MotionRuntime — diuji test):
 *   - priority lebih tinggi menang PER TARGET (role dan raw param = dua
 *     namespace terpisah; keduanya di-resolve independen).
 *   - priority sama → tie-break deterministik: nama channel naik (A→Z);
 *     TANPA wall-clock — resolve() murni fungsi dari entri yang terdaftar.
 *   - nilai 0 tetap pemilik valid (kehadiran key = ownership, bukan nilai).
 *   - resubmit channel yang sama = penggantian penuh entry-nya (analog
 *     same-band replace runtime).
 *
 * Sengaja TIDAK diimplementasi di Stage 0:
 *   - fade/duration (dihitung pengirim; komit selalu weight 1 / pin false,
 *     konsisten dengan semua caller existing — see docs/STATUS entri 33).
 *   - MAX_LAYERS: cap layer adalah mekanisme runtime (layer berumur); channel
 *     arbiter adalah sistem persisten yang sedikit jumlahnya.
 *
 * NOL dependensi renderer/Cubism — penulisan hanya lewat `backing` yang
 * disuntik (engine: delegasi ke roleLink → ParameterApi, `pin:false`).
 */

export type ArbiterDomain = "role" | "param";

/** Backing tulis yang disuntik engine. `false` = target tak dikenal/rusak
 * (safe-fail, TIDAK melempar — kontrak ParameterApi).
 * writeRoleNorm opsional: ruang normalized 0..1 (kedip/napas) — tanpa itu
 * entri mode "norm" gagal aman (false). */
export interface ArbiterWriteBacking {
  writeRole(role: string, valueRef: number): boolean;
  writeRoleNorm?(role: string, t: number): boolean;
  writeParam(id: string, value: number): boolean;
}

export interface ArbiterSubmit {
  channel: string;
  priority: number;
  domain: ArbiterDomain;
  /** key = nama role (domain "role") ATAU id parameter (domain "param"). */
  values: Record<string, number>;
  /** Ruang nilai role: "ref" (±skala referensi, default) atau "norm"
   * (0..1, kedip/napas). Param domain selalu actual — mode diabaikan. */
  mode?: "ref" | "norm";
}

export interface ArbiterSubmitResult {
  channel: string;
  domain: ArbiterDomain;
  /** jumlah nilai yang diterima (finite). */
  accepted: number;
  /** key yang ditolak karena NaN/Infinity. */
  rejected: string[];
}

export interface ArbiterResolved {
  role: Record<string, number>;
  param: Record<string, number>;
}

interface ArbiterEntry {
  channel: string;
  priority: number;
  domain: ArbiterDomain;
  /** snapshot — mutasi objek submit oleh caller tidak memengaruhi arbiter. */
  values: Record<string, number>;
  mode: "ref" | "norm";
}

function isFiniteValue(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function createParameterArbiter(backing: ArbiterWriteBacking) {
  if (!backing || typeof backing.writeRole !== "function" || typeof backing.writeParam !== "function")
    throw new Error("parameter-arbiter: backing writeRole/writeParam wajib fungsi");
  const entries: ArbiterEntry[] = [];

  function indexOfChannel(channel: string, domain: ArbiterDomain): number {
    return entries.findIndex((e) => e.channel === channel && e.domain === domain);
  }

  /** Urutan resolusi deterministik: priority desc, lalu nama channel asc.
   * Sort yang sama dijalankan setiap resolve — tanpa state waktu. */
  function ordered(domain: ArbiterDomain): ArbiterEntry[] {
    return entries
      .filter((e) => e.domain === domain)
      .sort((a, b) => (b.priority - a.priority) || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
  }

  return {
    /** Daftar entri untuk sebuah domain — channel diurutkan seperti resolusi
     * (diagnostik/test). */
    orderedChannels(domain: ArbiterDomain): string[] {
      return ordered(domain).map((e) => e.channel);
    },

    hasSource(channel: string): boolean {
      return entries.some((e) => e.channel === channel);
    },

    sourceCount(): number {
      return entries.length;
    },

    /** Daftarkan/perbarui satu channel. Nilai non-finite (NaN/Infinity)
     * DITOLAK per-key (dilaporkan di result); channel tetap terdaftar dengan
     * nilai yang lolos. Resubmit channel sama = penggantian penuh. */
    submit(s: ArbiterSubmit): ArbiterSubmitResult {
      if (!s || typeof s.channel !== "string" || !s.channel)
        throw new Error("parameter-arbiter: channel wajib string non-kosong");
      if (s.domain !== "role" && s.domain !== "param")
        throw new Error("parameter-arbiter: domain harus 'role' | 'param'");
      if (!Number.isFinite(s.priority))
        throw new Error("parameter-arbiter: priority wajib finite");
      const values: Record<string, number> = {};
      const rejected: string[] = [];
      for (const key of Object.keys(s.values || {})) {
        const v = (s.values as Record<string, unknown>)[key];
        if (!isFiniteValue(v)) {
          rejected.push(key);
          continue;
        }
        values[key] = v;
      }
      // Resubmit channel sama = penggantian penuh (same-band replace analog).
      const i = indexOfChannel(s.channel, s.domain);
      const entry: ArbiterEntry = {
        channel: s.channel,
        priority: s.priority,
        domain: s.domain,
        values,
        mode: s.mode === "norm" ? "norm" : "ref",
      };
      if (i >= 0) entries[i] = entry;
      else entries.push(entry);
      return { channel: s.channel, domain: s.domain, accepted: Object.keys(values).length, rejected };
    },

    /** Hapus SEMUA target milik satu channel (semua domain). */
    clearSource(channel: string): boolean {
      let removed = false;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].channel === channel) {
          entries.splice(i, 1);
          removed = true;
        }
      }
      return removed;
    },

    /** Hapus satu target milik satu channel; channel kosong ikut dihapus. */
    clearTarget(channel: string, domain: ArbiterDomain, key: string): boolean {
      const i = indexOfChannel(channel, domain);
      if (i < 0 || !Object.prototype.hasOwnProperty.call(entries[i].values, key)) return false;
      delete entries[i].values[key];
      if (!Object.keys(entries[i].values).length) entries.splice(i, 1);
      return true;
    },

    /** Teardown total — WAJIB dipanggil saat model switch (tidak ada stale
     * ownership lintas model). */
    clearAll(): void {
      entries.length = 0;
    },

    /** Resolusi murni — TIDAK menulis, TIDAK memakai waktu. Panggil ulang
     * dengan state sama = hasil identik (diuji). */
    resolve(): ArbiterResolved {
      const out: ArbiterResolved = { role: {}, param: {} };
      for (const domain of ["role", "param"] as const) {
        const owned: Record<string, number> = {};
        for (const e of ordered(domain)) {
          for (const key of Object.keys(e.values)) {
            if (Object.prototype.hasOwnProperty.call(owned, key)) continue;
            owned[key] = e.values[key];
          }
        }
        out[domain] = owned;
      }
      return out;
    },

    /** SATU titik komit: resolusi ownership (entry pertama dalam urutan
     * ordered yang memuat key = pemilik) lalu tulis tiap key sekali lewat
     * backing sesuai mode entri (role: writeRole / writeRoleNorm; param:
     * writeParam). Mengembalikan jumlah tulisan yang diterima backing.
     * Dipanggil di slot `beforeModelUpdate` engine. */
    commit(): number {
      let written = 0;
      for (const domain of ["role", "param"] as const) {
        const writtenKeys = new Set<string>();
        for (const e of ordered(domain)) {
          const write =
            domain === "param"
              ? backing.writeParam
              : e.mode === "norm" && typeof backing.writeRoleNorm === "function"
                ? backing.writeRoleNorm
                : backing.writeRole;
          for (const key of Object.keys(e.values).sort()) {
            if (writtenKeys.has(key)) continue;
            writtenKeys.add(key);
            if (write(key, e.values[key])) written++;
          }
        }
      }
      return written;
    },
  };
}

export type ParameterArbiter = ReturnType<typeof createParameterArbiter>;
