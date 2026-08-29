/**
 * animation/easing.ts — Cubic easing functions for keyframe interpolation.
 */

export type EasingMode = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "stepped";

export function ease(t: number, mode: EasingMode): number {
  switch (mode) {
    case "stepped": return 0;
    case "ease-in": return t * t * t;
    case "ease-out": return 1 - Math.pow(1 - t, 3);
    case "ease-in-out":
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case "linear":
    default: return t;
  }
}

/**
 * Clamp a value to a range.
 */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Linear interpolation between two values.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Smooth damping for natural motion (spring-like).
 */
export function smoothDamp(current: number, target: number, velocity: { value: number }, smoothTime: number, dt: number): number {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity.value + omega * change) * dt;
  velocity.value = (velocity.value - omega * temp) * exp;
  return target + (change + temp) * exp;
}
