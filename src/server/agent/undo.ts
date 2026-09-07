/**
 * server/agent/undo.ts — Snapshot & revert mutasi file agent (undo).
 * Snapshot diambil execTool (loop.ts) SETELAH tool write/edit/delete sukses:
 * isi file DARI DISK saat itu disimpan in-memory di rt.undo (cap MAX_UNDO).
 * Revert = tulis balik prevContent, atau hapus bila file tadinya belum ada.
 *
 * Sengaja TIDAK dipersist: undo itu jendela pendek sesi kerja (kayak approval);
 * restart server membuangnya — revert tetap aman karena tidak pernah
 * menyentuh file di luar workDir (path sudah melewati safePath di tool).
 */
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import type { Runtime } from "./state";
import { emitEvent } from "./bus";

/** Baca isi file untuk snapshot; null bila file belum ada. */
export function snapshotFile(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

/** Daftar rekaman undo untuk panel (path relatif, terbaru dulu). */
export function undoList(rt: Runtime): Array<{
  id: string; path: string; ts: number; reverted: boolean;
  /** null = file belum ada sebelum mutasi (revert = hapus file). */
  kind: "modified" | "created";
}> {
  return [...rt.undo].reverse().map((u) => ({
    id: u.id,
    path: u.relPath,
    ts: u.ts,
    reverted: !!u.reverted,
    kind: u.prevContent === null ? "created" as const : "modified" as const,
  }));
}

/**
 * Revert satu rekaman undo. Return pesan hasil atau throw Error bila
 * rekaman tidak dikenal / sudah pernah di-revert.
 */
export function revertUndo(rt: Runtime, id: string): string {
  const rec = rt.undo.find((u) => u.id === String(id || ""));
  if (!rec) throw new Error("rekaman undo tidak dikenal: " + id);
  if (rec.reverted) throw new Error("rekaman ini sudah pernah di-revert");
  if (rec.prevContent === null) {
    // file tadinya belum ada — kembalikan kondisi itu dengan menghapus
    try { unlinkSync(rec.absPath); } catch { /* sudah tidak ada — oke */ }
  } else {
    writeFileSync(rec.absPath, rec.prevContent, "utf8");
  }
  rec.reverted = true;
  emitEvent("verification_result", "revert: " + rec.relPath);
  return rec.prevContent === null
    ? "Dikembalikan: " + rec.relPath + " dihapus (sebelumnya belum ada)."
    : "Dikembalikan: " + rec.relPath + " ke isi sebelum mutasi agent (" + rec.prevContent.length + " char).";
}
