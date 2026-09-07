/**
 * server/agent/subagent.ts — Delegasi sub-task ke loop terpisah (fresh
 * context). Aturan keras:
 *   - Subagent TIDAK boleh spawn subagent lagi (nesting 1 level).
 *   - Subagent hanya punya tool read-only (mutating tetap otoritas
 *     orchestrator + approval user; jangan sembunyi-sembunyi menulis).
 *   - Orchestrator hanya menerima RINGKASAN hasil akhir, bukan history
 *     subagent — context orchestrator tetap ramping.
 *   - Maks 4 subagent paralel per batch.
 */
import type { ConfigManager } from "../../shared/config";
import { makeRuntime, getRuntime, setRuntime } from "./state";
import type { Runtime } from "./state";
import { agentAsk, MAX_ITERATIONS } from "./loop";
import { stripToolDirective } from "./parse";
import { TOOLS } from "./tools/index";
import { emitEvent } from "./bus";

export const MAX_PARALLEL = 4;

export type SubagentCall = { task: string };

/**
 * Jalankan batch subagent (paralel). Return teks tool_result gabungan
 * yang siap masuk history orchestrator.
 */
export async function runSubagentBatch(
  parent: Runtime,
  calls: SubagentCall[],
  config: ConfigManager,
): Promise<string> {
  const batch = calls.slice(0, MAX_PARALLEL);
  const skipped = calls.length - batch.length;

  const results = await Promise.all(
    batch.map(async (c, i) => {
      const id = "sub" + (i + 1);
      emitEvent("subagent_spawned", id + ": " + c.task.slice(0, 80));
      // Runtime anak: history kosong, workDir sama, persona kosong — loop
      // yang sama dengan context segar. Sementara menggeser singleton,
      // parent TIDAK disentuh (parent sedang menunggu await).
      const child = makeRuntime({}, parent.workDir, []);
      const prev = getRuntime();
      setRuntime(child);
      try {
        const r = await agentAsk(child, c.task, config);
        const out = r.ok
          ? stripToolDirective(r.reply || "", TOOLS.map((t) => t.name)).slice(0, 2000)
          : "ERROR: " + (r.error || "subagent gagal");
        emitEvent("subagent_completed", id + ": " + out.slice(0, 80));
        return "── " + id + " ──\n" + c.task.slice(0, 120) + "\n→ " + out;
      } catch (e: any) {
        emitEvent("subagent_completed", id + ": error " + (e?.message || e).slice(0, 60));
        return "── " + id + " ──\n" + c.task.slice(0, 120) + "\n→ ERROR: " + (e?.message || e);
      } finally {
        setRuntime(prev);
      }
    }),
  );

  let out = results.join("\n\n");
  if (skipped > 0)
    out +=
      "\n\n(" + skipped + " spawn_subagent dilewati — maksimal " + MAX_PARALLEL + " subagent paralel)";
  return out;
}

void MAX_ITERATIONS;
