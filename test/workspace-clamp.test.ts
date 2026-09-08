/**
 * test/workspace-clamp.test.ts — Aritmetika layout stage ↔ workspace agent.
 * Regresi bug maximize: basis tersimpan (warisan migrasi live2d.sidebar.w)
 * diterapkan mentah-mentah sehingga #stage tergencet ke min-width 340px dan
 * model Live2D terpotong. Fungsi di shell/workspace.ts murni aritmetika.
 *
 * Angka kasus diambil dari laporan user nyata:
 *  - restored   : innerWidth ≈ 1260 (1536 fisik @ Windows 125%)
 *  - maximized  : innerWidth ≈ 1536
 *  - occupied   : rail kiri 300 + gutter 6 + padding .app 20 + gap 3×10 = 356
 */
import { describe, it, expect } from "bun:test";
import {
  WORKSPACE_CEIL,
  WORKSPACE_FLOOR,
  STAGE_MIN,
  clampWorkspaceBasis,
  tameStoredWorkspaceBasis,
  workspaceFloor,
} from "../src/client/shell/workspace";

const LEFT = 300;
const CHROME = 56;
const OCCUPIED = LEFT + CHROME;

describe("workspaceFloor", () => {
  it("chat/vtuber: floor = default percakapan", () => {
    expect(workspaceFloor(false)).toBe(WORKSPACE_FLOOR);
  });
  it("assistant (agent-wide): floor menampung tech pane + percakapan min", () => {
    // 340 tech + 10 gap + 372 percakapan
    expect(workspaceFloor(true)).toBe(722);
  });
});

describe("clampWorkspaceBasis (drag — keinginan eksplisit user)", () => {
  it("maximized 1536, chat: drag ke 1040 dihormati; stage pas 340", () => {
    // room = 1536 − 356 − 340 = 840 → drag melebihi ruang → dipangkas ke 840.
    expect(clampWorkspaceBasis(1040, 1536, OCCUPIED)).toBe(840);
  });

  it("maximized 1536, assistant: floor kontekstual 722", () => {
    const fl = workspaceFloor(true);
    // Drag kecil dihormati sampai floor; stage tetap ≥ 340.
    expect(clampWorkspaceBasis(600, 1536, OCCUPIED, fl)).toBe(fl);
    expect(1536 - OCCUPIED - 600 >= STAGE_MIN).toBe(true);
  });

  it("restored 1260 (kontrak fungsi): dipangkas ke sisa ruang 564", () => {
    // Di jalur nyata <1500px basis inline tak dipasang sama sekali
    // (applyWorkspaceW membersihkannya sebelum clamp). Test ini kontrak fungsi:
    // room = 1260 − 356 − 340 = 564 ≥ floor 372 → 564, stage pas 340.
    expect(clampWorkspaceBasis(1040, 1260, OCCUPIED)).toBe(564);
  });

  it("ceiling 1200 tetap berlaku di ruang lega", () => {
    expect(clampWorkspaceBasis(5000, 2200, OCCUPIED)).toBe(WORKSPACE_CEIL);
  });

  it("viewport sempit ekstrem: null", () => {
    expect(clampWorkspaceBasis(800, 1000, OCCUPIED)).toBeNull();
  });
});

describe("tameStoredWorkspaceBasis (restore nilai tersimpan)", () => {
  it("maximized 1536: nilai warisan 1040 dipangkas; stage ≥45% ruang", () => {
    // panels = 1180; stageFloor = 531; room = 649 → 1040 → 649.
    const w = tameStoredWorkspaceBasis(1040, 1536, OCCUPIED)!;
    expect(w).toBe(649);
    expect(1536 - OCCUPIED - w).toBeGreaterThanOrEqual(Math.round(1180 * 0.45));
  });

  it("drag sadar ke nilai kecil (372) tetap dihormati — hanya memangkas", () => {
    expect(tameStoredWorkspaceBasis(372, 1536, OCCUPIED)).toBe(WORKSPACE_FLOOR);
  });

  it("restored 1260: stage dijaga ≥340 — basis dipangkas ke sisa ruang", () => {
    // panels = 904; stageFloor = max(340, 407) = 407; room = 497 → 497.
    // (Di jalur nyata <1500px basis inline malah tak dipasang; ini kontrak fungsi.)
    const w = tameStoredWorkspaceBasis(1040, 1260, OCCUPIED)!;
    expect(w).toBe(497);
    expect(1260 - OCCUPIED - w).toBeGreaterThanOrEqual(STAGE_MIN);
  });

  it("tak pernah melebihi ceiling dan stage tetap ≥45% ruang panel", () => {
    // panels = 1844; stageFloor = 830; room = 1014 (< ceiling) → 1014.
    const big = tameStoredWorkspaceBasis(5000, 2200, OCCUPIED)!;
    expect(big).toBe(1014);
    expect(2200 - OCCUPIED - big).toBe(Math.round(1844 * 0.45));
  });
});

describe("invariansi (aturan repo: bebas nama, hanya lebar terukur)", () => {
  it("hasil hanya fungsi (px, innerWidth, occupied, floor) — identitas kolom abstrak", () => {
    for (const left of [0, 66, 298, 300, 1024]) {
      const a = clampWorkspaceBasis(1040, 1536, left + CHROME);
      const b = clampWorkspaceBasis(1040, 1536, left + CHROME);
      expect(a).toBe(b);
      if (a != null) expect(1536 - (left + CHROME) - a).toBeGreaterThanOrEqual(STAGE_MIN);
      const t = tameStoredWorkspaceBasis(1040, 1536, left + CHROME);
      if (t != null) {
        expect(1536 - (left + CHROME) - t).toBeGreaterThanOrEqual(
          Math.max(STAGE_MIN, Math.round((1536 - (left + CHROME)) * 0.45) - 1),
        );
      }
    }
  });
});
