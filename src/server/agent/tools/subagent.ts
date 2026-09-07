/**
 * server/agent/tools/subagent.ts — spawn_subagent: delegasi sub-task
 * independen ke loop terpisah (read-only, tanpa nesting, maks 4 paralel).
 * Panggilan dengan array tasks dijalankan paralel dalam SATU tool call.
 */
import { runSubagentBatch, MAX_PARALLEL } from "../subagent";
import type { ToolCtx, ToolDef } from "./index";
import type { ConfigManager } from "../../../shared/config";

let configRef: ConfigManager | null = null;

/** Dipanggil facade sekali saat boot (tool butuh config utk LLM anak). */
export function setSubagentConfig(config: ConfigManager): void {
  configRef = config;
}

export async function toolSpawnSubagent(ctx: ToolCtx, args: any): Promise<string> {
  if (!ctx.rt) return "ERROR: runtime tidak tersedia";
  if (!configRef) return "ERROR: konfigurasi subagent belum siap";
  const tasksRaw = Array.isArray(args?.tasks) ? args.tasks : [args];
  const calls = tasksRaw
    .map((t: any) => ({
      task: String(t?.task ?? t ?? "").trim().slice(0, 1000),
    }))
    .filter((c: { task: string }) => c.task);
  if (!calls.length) return "ERROR: task kosong — kirim {tasks:[{task:'...'}]} atau {task:'...'}";
  return await runSubagentBatch(ctx.rt, calls, configRef);
}

export const spawnSubagentTool: ToolDef = {
  name: "spawn_subagent",
  desc:
    "spawn_subagent {tasks:[{task}]} — delegasikan sub-task riset/analisa INDEPENDEN ke subagent paralel (read-only, hasil ringkasan). Maks " +
    MAX_PARALLEL +
    " per panggilan",
  params: {
    tasks: "array [{task: deskripsi goal lengkap}] — tiap task jalan di context sendiri",
  },
  level: "safe",
  run: toolSpawnSubagent,
};
