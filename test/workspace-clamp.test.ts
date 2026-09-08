/**
 * test/workspace-clamp.test.ts — Clamp flex-basis workspace agent.
 * Regresi bug maximize: basis tersimpan (warisan migrasi live2d.sidebar.w)
 * diterapkan mentah-mentah sehingga #stage tergencet ke min-width 340px dan
 * model Live2D terpotong. clampWorkspaceBasis murni aritmetika — tanpa DOM.
 */
import { describe, it, expect } from "bun:test";
import { clampWorkspaceBasis } from "../src/client/shell/workspace";

const LEFT = 300; // rail projek terbuka: activity 56 + gap 10 + rail ±234
const CHROME = 56; // gutter 6 + padding .app 2×10 + gap .app 3×10
const OCCUPIED = LEFT + CHROME;

describe("clampWorkspaceBasis", () => {
  it("kasus nyata restored (innerWidth 1260): tak boleh pakai inline basis", () => {
    // room = 1260 − 356 − 340 = 564 < 650 → default CSS (372px) yang menang.
    expect(clampWorkspaceBasis(1040, 1260, OCCUPIED)).toBeNull();
  });

  it("kasus nyata maximize (innerWidth 1536): basis 1040 dipangkas, stage ≥ 340", () => {
    // room = 1536 − 356 − 340 = 840 → workspace 840, stage pas 340.
    expect(clampWorkspaceBasis(1040, 1536, OCCUPIED)).toBe(840);
  });

  it("clamp bawah 650 dan atas 1200 tetap berlaku di ruang lega", () => {
    expect(clampWorkspaceBasis(300, 2200, OCCUPIED)).toBe(650);
    expect(clampWorkspaceBasis(5000, 2200, OCCUPIED)).toBe(1200);
  });

  it("viewport sempit ekstrem: null (biarkan default CSS 372px)", () => {
    expect(clampWorkspaceBasis(800, 1000, OCCUPIED)).toBeNull();
  });

  it("invariansi: hanya bergantung lebar terukur, bukan identitas kolom", () => {
    for (const left of [0, 66, 298, 300, 1024]) {
      const a = clampWorkspaceBasis(1040, 1536, left + CHROME);
      const b = clampWorkspaceBasis(1040, 1536, left + CHROME);
      expect(a).toBe(b);
      // Stage tidak boleh tenggelam di bawah minimumnya.
      if (a != null) expect(1536 - (left + CHROME) - a).toBeGreaterThanOrEqual(340);
    }
  });
});
