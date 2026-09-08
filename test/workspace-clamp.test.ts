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
import { computeFrame } from "../src/client/engine/framing";

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

describe("regresi — mesin user: 1920 fisik @ scaling 150% → 1280 CSS", () => {
  it("1280px (maximize): drag dihormati, stage ≥340 — dulu gutter disembunyikan", () => {
    // occupied: rail tertutup 66 + gutter 8 + padding 20 + 2 gap terlihat.
    // kids = 2 (left + gutter) → 66 + 8 + 20 + 20 = 114.
    const occ = 66 + 8 + 20 + 2 * 10;
    const w = clampWorkspaceBasis(700, 1280, occ)!;
    // panels = 1166; room = 826 → 700 sah; stage = 466 ≥ 340.
    expect(w).toBe(700);
    expect(1280 - occ - w).toBeGreaterThanOrEqual(STAGE_MIN);
    // 50/50 eksplisit juga sah: 583 workspace, 583 stage.
    const half = clampWorkspaceBasis(583, 1280, occ)!;
    expect(half).toBe(583);
  });

  it("1280px bertumpuk: floor percakapan 372, bukan 722 (tech di bawah)", () => {
    // Kontrak wsFloor via tame: nilai kecil hasil drag sadar tak dinaikkan.
    const w = tameStoredWorkspaceBasis(372, 1280, 114)!;
    expect(w).toBe(WORKSPACE_FLOOR);
  });

  it("invarian anti-gepeng: skala upper tak berubah meski workspace berubah", () => {
    // Stage 715 (w=483) vs stage 466 (w=700) pada H sama → skala identik.
    const H = 963; // 1280 CSS ≈ tinggi jendela maximize 150% scaling
    const a = computeFrame(800, 1200, 715, H, "upper")!;
    const b = computeFrame(800, 1200, 466, H, "upper")!;
    expect(a.scale).toBe(b.scale);
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
