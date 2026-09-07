/**
 * server/agent/context.ts — Manajemen context window.
 * 1. clipToolResult: hasil tool panjang dipotong SEBELUM masuk history.
 * 2. maybeSummarize: kalau total karakter history menembus budget, history
 *    lama diringkas LLM jadi satu pesan "context" — sambil state penting
 *    (file tersentuh, keputusan) disimpan di rt.notes DI LUAR history
 *    sehingga tidak pernah hilang oleh ringkasan.
 */
import { llmForRole } from "../../shared/llm-client";
import type { ConfigManager } from "../../shared/config";
import { MAX_HISTORY, HISTORY_CHAR_BUDGET } from "./state";
import type { Runtime } from "./state";
import { emitEvent } from "./bus";

/** Batas karakter per hasil tool yang ditulis ke history. */
export function clipToolResult(text: string, max = 4000): string {
  const t = String(text ?? "");
  return t.length > max ? t.slice(0, max) + "\n…(terpotong, " + t.length + " char)" : t;
}

function historyChars(rt: Runtime): number {
  return rt.history.reduce((n, m) => n + m.content.length + 16, 0);
}

/** Blok notes untuk disuntik ke prompt — selalu segar walau history diringkas. */
export function notesBlock(rt: Runtime): string {
  const parts: string[] = [];
  if (rt.notes.filesTouched.length)
    parts.push("File yang sudah kamu tulis/edit sesi ini:\n" + rt.notes.filesTouched.map((f) => "- " + f).join("\n"));
  if (rt.notes.decisions.length)
    parts.push("Keputusan/permintaan penting user:\n" + rt.notes.decisions.map((d) => "- " + d).join("\n"));
  return parts.length ? "\n=== STATE SESI (selalu berlaku) ===\n" + parts.join("\n\n") : "";
}

/**
 * Ringkas history lama bila melewati budget. Menyisakan MAX_KEEP pesan
 * terakhir apa adanya; sisanya jadi SATU pesan system ringkasan.
 * Gagal LLM = dibiarkan (loop tetap jalan, hanya context lebih gemuk).
 */
export async function maybeSummarize(rt: Runtime, config: ConfigManager): Promise<void> {
  if (historyChars(rt) < HISTORY_CHAR_BUDGET) return;
  const MAX_KEEP = 12;
  if (rt.history.length <= MAX_KEEP + 2) return;
  const keep = rt.history.slice(-MAX_KEEP);
  const old = rt.history.slice(0, -MAX_KEEP);
  const transcript = old
    .map((m) => "[" + m.role + "] " + m.content.slice(0, 600))
    .join("\n")
    .slice(0, 12000);
  try {
    const { reply } = await llmForRole(
      "assistant",
      () => config.connections,
      () => config.activeConnection,
      (conns) => config.saveConnections(conns, config.load().activeId),
      [
        {
          role: "user",
          content:
            "Ringkas transkrip kerja agent berikut jadi catatan padat (maks 12 kalimat): " +
            "apa yang dikerjakan, file/fakter penting yang ditemukan, keputusan yang diambil. " +
            "Jangan gunakan format percakapan.\n\n" +
            transcript,
        },
      ],
      "Kamu adalah asisten yang meringkas riwayat kerja agent coding. Output: catatan padat berbahasa Indonesia, tanpa basa-basi.",
    );
    const summary =
      "=== RINGKASAN AWAL SESI (history lama diringkas; detail persis mungkin sudah tidak tersedia) ===\n" +
      String(reply || "").trim();
    rt.history = [{ role: "assistant", content: summary, ts: Date.now() }, ...keep];
    rt.summarizations++;
  } catch (e: any) {
    console.warn("[agent/context] summarization gagal (dilewati):", e?.message || e);
  }
}
