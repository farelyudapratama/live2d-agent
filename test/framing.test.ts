/**
 * test/framing.test.ts — computeFrame (engine/framing.ts): rumus framing
 * panggung Live2D. Fokus regresi: ANTI-GEPENG — skala mode "upper"/"full"
 * hanya fungsi TINGGI stage, jadi panel kiri diperkecil (splitter didrag)
 * karakter tetap sama besar; lebar hanya mengubah pan (x). Hanya "fit" yang
 * menyesuaikan diri ke lebar.
 */
import { describe, it, expect } from "bun:test";
import { computeFrame } from "../src/client/engine/framing";

// Model rasio 2:3 ala Lumine (natW × natH).
const NAT = { w: 800, h: 1200 };

describe("computeFrame — anti-gepeng (permintaan user)", () => {
  const H = 900;
  const wide = computeFrame(NAT.w, NAT.h, 840, H, "upper")!;
  const narrow = computeFrame(NAT.w, NAT.h, 372, H, "upper")!;

  it("upper: skala IDENTIK saat panel menyempit (tinggi sama)", () => {
    expect(narrow.scale).toBe(wide.scale);
    expect(wide.scale).toBeCloseTo((H * 1.05) / NAT.h, 10);
  });

  it("upper: hanya pan yang bergeser — x mengikuti center panel", () => {
    expect(narrow.x).toBeCloseTo(372 / 2 - (NAT.w * narrow.scale) / 2, 10);
    expect(wide.x).toBeCloseTo(840 / 2 - (NAT.w * wide.scale) / 2, 10);
  });

  it("upper: panel sempit memotong sisi, bukan memampatkan — lebar render > panel", () => {
    expect(NAT.w * narrow.scale).toBeGreaterThan(372);
  });

  it("full: skala juga hanya fungsi tinggi (82%)", () => {
    const a = computeFrame(NAT.w, NAT.h, 840, H, "full")!;
    const b = computeFrame(NAT.w, NAT.h, 372, H, "full")!;
    expect(a.scale).toBe(b.scale);
    expect(a.scale).toBeCloseTo((H * 0.82) / NAT.h, 10);
  });

  it("fit: memang menyesuaikan diri ke lebar (dobel-klik/reset)", () => {
    const a = computeFrame(NAT.w, NAT.h, 840, H, "fit")!;
    const b = computeFrame(NAT.w, NAT.h, 372, H, "fit")!;
    expect(b.scale).toBeLessThan(a.scale);
    // Lebar model fit pas dalam panel (0.9 margin).
    expect(NAT.w * b.scale).toBeCloseTo(372 * 0.9, 10);
  });
});

describe("computeFrame — kasus umum", () => {
  it("model tinggi (h > w): upper memotong bawah, bukan mengecil", () => {
    const f = computeFrame(600, 1800, 500, 900, "upper")!;
    expect(f.scale).toBeCloseTo((900 * 1.05) / 1800, 10);
  });

  it("y selalu center vertikal untuk ketiga mode", () => {
    for (const mode of ["upper", "full", "fit"] as const) {
      const f = computeFrame(NAT.w, NAT.h, 600, 900, mode)!;
      expect(f.y).toBeCloseTo((900 - NAT.h * f.scale) / 2, 10);
    }
  });

  it("input tidak valid → null (degrade ke fallback app.js)", () => {
    expect(computeFrame(0, 100, 500, 900, "upper")).toBeNull();
    expect(computeFrame(NaN, 100, 500, 900, "upper")).toBeNull();
    expect(computeFrame(800, 1200, 0, 900, "fit")).toBeNull();
    expect(computeFrame(800, 1200, 500, NaN, "fit")).toBeNull();
  });
});
