import { describe, test, expect } from "bun:test";
import { rmsTimeDomain, mouthTarget, envelope } from "../src/client/speech/lip-sync";

describe("rmsTimeDomain", () => {
  test("henyap total (semua 128) → 0", () => {
    expect(rmsTimeDomain(new Uint8Array(1024).fill(128))).toBe(0);
  });

  test("square wave skala penuh (0/255) → ≈1.0", () => {
    expect(rmsTimeDomain(new Uint8Array(512).fill(0))).toBeCloseTo(1.0, 5);
    expect(rmsTimeDomain(new Uint8Array(512).fill(255))).toBeCloseTo(127 / 128, 5);
  });

  test("square wave setengah amplitudo (64/192 bergantian) → ≈0.5", () => {
    const buf = new Uint8Array(512);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 2 ? 192 : 64;
    expect(rmsTimeDomain(buf)).toBeCloseTo(0.5, 5);
  });

  test("kosong / null → 0 tanpa melempar", () => {
    expect(rmsTimeDomain(new Uint8Array(0))).toBe(0);
    expect(rmsTimeDomain(null)).toBe(0);
    expect(rmsTimeDomain(undefined)).toBe(0);
  });
});

describe("mouthTarget", () => {
  test("henyap → 0 (mulut tertutup)", () => {
    expect(mouthTarget(0)).toBe(0);
    expect(mouthTarget(0.005)).toBe(0);   // di bawah gate 0.012
  });

  test("skala linear di atas gate: 0.1 → (0.1-0.012)*9", () => {
    expect(mouthTarget(0.1)).toBeCloseTo((0.1 - 0.012) * 9, 5);
  });

  test("clamp di 1 — input ekstrem tidak melewati batas", () => {
    expect(mouthTarget(0.5)).toBe(1);
    expect(mouthTarget(100)).toBe(1);
  });

  test("input tidak valid (NaN/Infinity) → 0, bukan NaN menyebar", () => {
    expect(mouthTarget(NaN)).toBe(0);
    expect(mouthTarget(Infinity)).toBe(0);   // bukan finite → diperlakukan hening
  });
});

describe("envelope", () => {
  test("attack: bergerak menuju target, konstanta waktu 35ms → 1-e^-1 pada dt=35", () => {
    const v = envelope(0, 1, 35, { attackMs: 35, decayMs: 110 });
    expect(v).toBeCloseTo(1 - Math.exp(-1), 5);
  });

  test("decay lebih lambat dari attack pada dt yang sama", () => {
    const up = envelope(0, 1, 30, { attackMs: 35, decayMs: 110 });
    const down = envelope(1, 0, 30, { attackMs: 35, decayMs: 110 });
    expect(up).toBeGreaterThan(0.5);              // membuka hampir sampai target
    expect(1 - down).toBeLessThan(up);            // menutup lebih sedikit geraknya
  });

  test("konvergen ke target setelah banyak frame", () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = envelope(v, 1, 16, { attackMs: 35, decayMs: 110 });
    expect(v).toBeGreaterThan(0.999);
  });

  test("dt=0 / dt tidak valid → nilai tidak berubah", () => {
    expect(envelope(0.4, 1, 0)).toBe(0.4);
    expect(envelope(0.4, 1, NaN)).toBe(0.4);
    expect(envelope(0.4, 1, -5)).toBe(0.4);
  });
});
