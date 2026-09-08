/**
 * client/shell/workspace.ts — Aritmetika layout shell, murni & tanpa DOM.
 * Dipisah dari projek.ts karena projek.ts menyentuh location/DOM di level
 * modul (tidak aman diimpor dari bun test). Diuji di test/workspace-clamp.test.ts.
 */

/**
 * Flex-basis workspace agent setelah clamp. Preferensi drag yang tersimpan
 * tetap menang, TAPI tidak boleh mempersempit #stage di bawah lebar minimumnya
 * (min-width 340px di app.css) — bug nyata: basis warisan migrasi
 * live2d.sidebar.w diterapkan mentah-mentah saat maximize dan stage jadi strip.
 * `occupied` = lebar terukur kolom kiri + gutter + padding/gap .app.
 * Return null = viewport terlalu sempit → jangan pakai inline basis (default CSS).
 */
export function clampWorkspaceBasis(
  px: number,
  innerWidth: number,
  occupied: number,
  stageMin = 340,
): number | null {
  const room = innerWidth - occupied - stageMin;
  if (room < 650) return null;
  return Math.max(650, Math.min(1200, px, room));
}
