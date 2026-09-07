/**
 * server/agent/tools/plan.ts — Tool update_plan: HANYA mengubah state plan,
 * tidak menyentuh file system (pemisahan planning vs eksekusi).
 * Sekaligus SELF-VERIFICATION GUARD: item tidak boleh "done" kalau ada file
 * yang ditulis/diedit dan belum ada aksi verifikasi (read/run) setelahnya.
 * 3x dipaksa done tanpa verifikasi → item otomatis "failed" + alasan.
 */
import { sanitizePlan, applyPlan, planLabel } from "../plan";
import type { PlanItem } from "../plan";
import { emitEvent } from "../bus";
import type { ToolCtx, ToolDef } from "./index";

const WRITE_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);
const VERIFY_TOOLS = new Set(["read_file", "run_command", "search_code", "git_diff", "recall"]);

/** Dipanggil loop setelah tool_call_end untuk melacak tulis vs verifikasi. */
export function trackToolSeq(rt: any, toolName: string): void {
  if (WRITE_TOOLS.has(toolName)) rt.lastWriteAt = Date.now();
  if (VERIFY_TOOLS.has(toolName)) rt.lastVerifyAt = Date.now();
}

function failCount(rt: any, id: string): number {
  rt.planBlocks = rt.planBlocks || {};
  return rt.planBlocks[id] || 0;
}

export async function toolUpdatePlan(ctx: ToolCtx, args: any): Promise<string> {
  const rt: any = ctx.rt;
  const todos = sanitizePlan(args?.todos);
  if (!todos) return "ERROR: todos tidak valid — kirim array [{id, task, status}]";
  const reason = String(args?.reason || "").trim().slice(0, 300) || undefined;

  const markingDone: PlanItem[] = todos.filter((t) => {
    if (t.status !== "done") return false;
    const old = (rt.plan || []).find((o: PlanItem) => o.id === t.id);
    return !old || old.status !== "done";
  });

  const unverifiedWrite =
    typeof rt.lastWriteAt === "number" && rt.lastWriteAt > (rt.lastVerifyAt || 0);

  if (unverifiedWrite && markingDone.length) {
    const blocked = markingDone.filter((t) => failCount(rt, t.id) >= 2);
    if (blocked.length) {
      // 3x dipaksa done tanpa verifikasi → gagal, JANGAN dipaksa done.
      for (const t of todos) {
        const b = blocked.find((x) => x.id === t.id);
        if (b) {
          t.status = "failed";
          t.note = "gagal: verifikasi tidak pernah dijalankan setelah 3 peringatan";
        }
      }
      applyPlan(rt, todos, reason);
      emitEvent("verification_result", "gagal: " + blocked.map((b) => b.task).join("; "));
      return (
        "Item " + blocked.map((b) => b.id).join(",") +
        " ditandai FAILED — verifikasi tidak pernah dijalankan setelah 3 peringatan. Lanjut ke item lain atau jelaskan ke user."
      );
    }
    for (const t of markingDone) {
      rt.planBlocks = rt.planBlocks || {};
      rt.planBlocks[t.id] = (rt.planBlocks[t.id] || 0) + 1;
      t.status = "in_progress";
    }
    applyPlan(rt, todos, reason);
    emitEvent(
      "verification_start",
      "wajib verifikasi dulu: " + markingDone.map((m) => m.task).join("; "),
    );
    return (
      "DITOLAK SEMENTARA: ada file yang baru ditulis/diedit tapi belum diverifikasi. " +
      "Jalankan verifikasi dulu (run_command build/test untuk kode, atau read_file untuk konfirmasi isi), " +
      "lalu kirim ulang update_plan dengan status done. (peringatan " +
      markingDone.map((t) => failCount(rt, t.id)).join("/") + "/3)"
    );
  }

  if (markingDone.length) {
    // done sah — sudah ada aksi verifikasi setelah tulis terakhir.
    emitEvent("verification_result", "lolos: " + markingDone.map((m) => m.task).join("; "));
  }

  const r = applyPlan(rt, todos, reason);
  if (!r.ok) return "ERROR: " + r.reason;
  return "ok — plan tersimpan (" + planLabel(rt.plan!) + ")";
}

export const updatePlanTool: ToolDef = {
  name: "update_plan",
  desc: "update_plan {todos:[{id,task,status}], reason?} — perbarui rencana kerja (tanpa menyentuh file)",
  params: {
    todos: "array [{id, task, status: pending|in_progress|done|failed}]",
    reason: "string opsional — WAJIB kalau rencana direvisi",
  },
  level: "safe",
  run: toolUpdatePlan,
};
