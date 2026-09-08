/**
 * client/shell/workspace.ts — Aritmetika layout shell, murni & tanpa DOM.
 * Dipisah dari projek.ts karena projek.ts menyentuh location/DOM di level
 * modul (tidak aman diimpor dari bun test). Diuji di test/workspace-clamp.test.ts.
 *
 * Model: stage Live2D dan workspace agent berbagi satu batas (gutter).
 * Yang disimpan adalah lebar workspace; lebar stage = sisanya. Dua jalur
 * clamp berbeda:
 *  - drag (keinginan eksplisit user): floor kontekstual, stage ≥ 340px.
 *  - restore nilai tersimpan: stage dijaga ≥ 45% ruang panel, supaya
 *    preferensi lama (mis. 1040px warisan migrasi) tidak menjadikan stage
 *    strip setiap kali jendela di-maximize.
 */

export const WORKSPACE_FLOOR = 372; // = default basis CSS percakapan
export const WORKSPACE_CEIL = 1200;
export const STAGE_MIN = 340; // min-width #stage di app.css
export const TECH_PANE_W = 340; // flex-basis #agent-tech (>=1500px)
export const SIDEBAR_MIN = 372; // percakapan term.minimum saat tech tampil

/** Floor workspace saat drag, tergantung konteks kolom. */
export function workspaceFloor(agentWide: boolean): number {
  // Mode assistant: pane teknis 340 + gap 10 + percakapan min 372.
  return agentWide ? SIDEBAR_MIN + TECH_PANE_W + 10 : WORKSPACE_FLOOR;
}

/**
 * Clamp saat drag: keinginan user menang dalam batas floor/ceil, dan stage
 * tidak boleh di bawah minimumnya. Return null = ruang tak cukup → pakai
 * default CSS (jangan pasang inline basis).
 */
export function clampWorkspaceBasis(
  px: number,
  innerWidth: number,
  occupied: number,
  floor = WORKSPACE_FLOOR,
): number | null {
  const room = innerWidth - occupied - STAGE_MIN;
  if (room < floor) return null;
  return Math.max(floor, Math.min(WORKSPACE_CEIL, px, room));
}

/**
 * Clamp saat memakai nilai TERSIMPAN (restore/init/window-resize): stage
 * dijaga ≥ 45% ruang panel. Nilai kecil hasil drag sadar tetap dihormati
 * (fungsi hanya memangkas, tidak menaikkan). Return null hanya bila ruang
 * benar-benar tak cukup → default CSS.
 */
export function tameStoredWorkspaceBasis(
  px: number,
  innerWidth: number,
  occupied: number,
  floor = WORKSPACE_FLOOR,
): number | null {
  const panels = innerWidth - occupied; // ruang untuk stage + workspace
  const stageFloor = Math.max(STAGE_MIN, Math.round(panels * 0.45));
  const room = panels - stageFloor;
  if (room < STAGE_MIN) return null;
  const fl = Math.min(floor, Math.max(STAGE_MIN, room));
  return Math.max(fl, Math.min(WORKSPACE_CEIL, px, room));
}
