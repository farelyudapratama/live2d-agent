/**
 * engine/mouse-follow-gain.ts — kalibrasi gain mouse-follow (murni, tanpa DOM).
 *
 * Sumber kebenaran konstanta gain yang sebelumnya literal di handler
 * mousemove app.js (`nx * 30`, `nx * 30 * 0.25`, `nx * 1`). Algoritma
 * (normalisasi input, easing, tulisan lewat arbiter) TIDAK berubah —
 * modul ini hanya menyediakan angka pengali yang bisa dikalibrasi lewat
 * config `motion.mouseFollow` (preset atau nilai eksplisit).
 *
 * Semantik (default = perilaku existing, terukur di audit):
 *   headGainX/Y — skala referensi ±30 (derajat role) untuk AngleX/AngleY.
 *   bodyGainX/Y — FAKTOR dari skala referensi (0.25 → ±7.5) untuk
 *                 BodyAngleX/Y. Keamanan amplitudo tetap dari jalur
 *                 existing: roleClampActual + clamp range ParameterApi.
 *   eyeGainX/Y  — pengali ternormalisasi ±1 untuk EyeBallX/Y (tick sudah
 *                 meng-clamp ±1 — gain >1 hanya saturasi lebih cepat).
 */

export interface MouseFollowGains {
  headGainX: number;
  headGainY: number;
  bodyGainX: number;
  bodyGainY: number;
  eyeGainX: number;
  eyeGainY: number;
}

/** Default = perilaku existing (persis nilai literal lama). */
export const MOUSE_FOLLOW_DEFAULTS: MouseFollowGains = {
  headGainX: 30,
  headGainY: 30,
  bodyGainX: 0.25,
  bodyGainY: 0.25,
  eyeGainX: 1,
  eyeGainY: 1,
};

/** Preset kalibrasi (kandidat, bukan nilai final). */
export const MOUSE_FOLLOW_PRESETS: Record<string, MouseFollowGains> = {
  default: { ...MOUSE_FOLLOW_DEFAULTS },
  strong: {
    headGainX: 40,
    headGainY: 30,
    bodyGainX: 0.5,
    bodyGainY: 0.5,
    eyeGainX: 1,
    eyeGainY: 1,
  },
  wild: {
    headGainX: 50,
    headGainY: 30,
    bodyGainX: 0.75,
    bodyGainY: 0.75,
    eyeGainX: 1,
    eyeGainY: 1,
  },
};

const GAIN_KEYS: readonly (keyof MouseFollowGains)[] = [
  "headGainX",
  "headGainY",
  "bodyGainX",
  "bodyGainY",
  "eyeGainX",
  "eyeGainY",
];

export interface MouseFollowGainConfig extends Partial<MouseFollowGains> {
  /** "default" | "strong" | "wild" — nilai eksplisit menimpa preset. */
  preset?: string;
}

/**
 * Gabungkan config user → gain final. Tanpa config / preset tak dikenal →
 * default. Nilai eksplisit (finite, ≥ 0) menimpa preset; selain itu diabaikan
 * (fail-safe — config rusak tidak menghasilkan NaN ke handler).
 */
export function resolveMouseFollowGains(
  cfg?: MouseFollowGainConfig | null,
): MouseFollowGains {
  const preset = cfg?.preset ? MOUSE_FOLLOW_PRESETS[cfg.preset] : undefined;
  const out: MouseFollowGains = { ...(preset ?? MOUSE_FOLLOW_DEFAULTS) };
  if (cfg) {
    for (const key of GAIN_KEYS) {
      const v = cfg[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
    }
  }
  return out;
}
