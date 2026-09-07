/**
 * server/agent/tools/memory.ts — remember/recall: akses eksplisit ke
 * long-term memory (.agent-memory). Read/write file kecil sendiri — tidak
 * lewat sandbox workDir karena memory adalah milik assistant, bukan milik
 * project yang sedang dikerjakan.
 */
import { remember, recall } from "../memory";
import type { ToolCtx, ToolDef } from "./index";

export async function toolRemember(ctx: ToolCtx, args: any): Promise<string> {
  return remember(String(args?.key || ""), String(args?.value || ""));
}

export async function toolRecall(ctx: ToolCtx, args: any): Promise<string> {
  return recall(args?.key ? String(args.key) : undefined);
}

export const rememberTool: ToolDef = {
  name: "remember",
  desc: "remember {key, value} — simpan ingatan lintas sesi (preferensi user, keputusan, pelajaran)",
  params: { key: "string singkat, mis. 'style-user'", value: "string isi ingatan" },
  level: "safe",
  run: toolRemember,
};

export const recallTool: ToolDef = {
  name: "recall",
  desc: "recall {key?} — ambil ingatan tersimpan (tanpa key = semua)",
  params: { key: "string opsional — filter kata kunci" },
  level: "safe",
  run: toolRecall,
};
