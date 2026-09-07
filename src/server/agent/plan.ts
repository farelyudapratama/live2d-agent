/**
 * server/agent/plan.ts — Todo list terstruktur untuk task kompleks.
 * State TERPISAH dari teks jawaban: loop menyimpan di rt.plan, tool
 * update_plan yang mengubahnya, dan tiap perubahan di-emit ke bus supaya
 * user melihat progress real-time (event plan_updated / plan_revised).
 */

export type PlanItemStatus = "pending" | "in_progress" | "done" | "failed";

export type PlanItem = {
  id: string;
  task: string;
  status: PlanItemStatus;
  /** Alasan revisi/kegagalan (opsional). */
  note?: string;
};

import { emitEvent } from "./bus";

/** Validasi & normalisasi payload plan dari LLM. */
export function sanitizePlan(raw: unknown): PlanItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PlanItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const id = String((it as any).id ?? "").trim().slice(0, 12) || String(out.length + 1);
    const task = String((it as any).task ?? "").trim().slice(0, 300);
    if (!task) continue;
    let status = String((it as any).status ?? "pending").toLowerCase();
    if (!["pending", "in_progress", "done", "failed"].includes(status)) status = "pending";
    const note = String((it as any).note ?? "").trim().slice(0, 300) || undefined;
    out.push({ id, task, status, note } as PlanItem);
  }
  return out.length ? out : null;
}

/**
 * Terapkan plan baru ke rt.plan. Return {ok, reason} — reason terisi kalau
 * perubahan ditolak atau perlu dicatat sebagai revisi.
 */
export function applyPlan(
  rt: { plan?: PlanItem[]; planFailCount?: Record<string, number> },
  todos: PlanItem[],
  reason?: string,
): { ok: boolean; reason?: string } {
  const old = rt.plan || [];

  // Revisi: item lama ada yang hilang / task berubah → wajib alasan.
  const oldKeys = new Set(old.map((p) => p.id + "|" + p.task));
  const newKeys = new Set(todos.map((p) => p.id + "|" + p.task));
  const isRevision =
    old.length > 0 &&
    (todos.some((p) => !oldKeys.has(p.id + "|" + p.task)) || old.some((p) => !newKeys.has(p.id + "|" + p.task)));
  if (isRevision && !reason) {
    return {
      ok: false,
      reason: "REVISI TANPA ALASAN DITOLAK — sebutkan 'reason' singkat kenapa rencana berubah.",
    };
  }
  rt.plan = todos;
  if (isRevision) emitEvent("plan_revised", reason!);
  else emitEvent("plan_updated", planLabel(todos));
  return { ok: true };
}

export function planLabel(todos: PlanItem[]): string {
  const done = todos.filter((p) => p.status === "done").length;
  const failed = todos.filter((p) => p.status === "failed").length;
  return done + "/" + todos.length + " selesai" + (failed ? ", " + failed + " gagal" : "");
}
