/**
 * server/assistant.ts — FACADE mode AI Assistant/Agent.
 * Semua logika berat sudah dipindah ke modul agent/ (otak kerja) dan
 * persona/ (otak akting). File ini hanya:
 *   - kelola runtime (start/stop/reset/status/history),
 *   - jembatan API lama (index.ts & panel web) ke agent loop,
 *   - panggil persona narrator di akhir tugas.
 * Kontrak API TIDAK berubah: index.ts, panel web, dan CLI tetap sama.
 */
import type { ConfigManager } from "../shared/config";
import { appRoot } from "../shared/paths";
import { makeRuntime, getRuntime, setRuntime, loadSession, saveSession, pushMsg } from "./agent/state";
import { agentAsk, agentRunApproved } from "./agent/loop";
import { stripToolDirective } from "./agent/parse";
import { readEvents, emitEvent } from "./agent/bus";
import { narrate } from "./persona/narrator";
import { cleanForSpeech } from "./persona/clean";
import { TOOLS } from "./agent/tools/index";
import { setSubagentConfig } from "./agent/tools/subagent";
import { memoryList, memoryDelete } from "./agent/memory";
import { undoList, revertUndo } from "./agent/undo";

export type { AsMsg, AsApproval, PlanItem } from "./agent/state";
export type { AsEvent } from "./assistant-events";
export { memoryList as assistantMemoryList, memoryDelete as assistantMemoryDelete };

let configWired = false;
/** Dipanggil sekali dari index.ts saat server boot. */
export function initAssistant(config: ConfigManager): void {
  if (!configWired) {
    setSubagentConfig(config);
    configWired = true;
  }
}

// ── Status & lifecycle ─────────────────────────────────────────

export function assistantStatus() {
  const rt = getRuntime();
  return {
    running: !!rt,
    busy: rt?.busy || false,
    workDir: rt?.workDir || null,
    historyCount: rt?.history.length || 0,
    pendingApprovals: rt ? Array.from(rt.approvals.values()) : [],
    /** Rencana kerja aktif (update_plan) — untuk kotak progress di panel. */
    plan: rt?.plan || [],
    /** File yang tersentuh sesi ini (notes) — untuk tab Review panel. */
    notes: { filesTouched: rt ? rt.notes.filesTouched.slice() : [] },
  };
}

export function assistantHistory() {
  const rt = getRuntime();
  return rt ? rt.history : [];
}

export function assistantStop() {
  const rt = getRuntime();
  if (rt) rt.destroyed = true;
  setRuntime(null);
  return { ok: true };
}

export function assistantStart(cfg: any): { ok: boolean; error?: string } {
  assistantStop();
  // Default = akar app (bukan process.cwd()) supaya deterministik di portable.
  const saved = loadSession();
  const workDir = String(cfg?.workDir || saved?.workDir || appRoot()).trim();
  const rt = makeRuntime(cfg || {}, workDir, saved?.history ? saved.history.slice() : []);
  setRuntime(rt);
  saveSession(rt);
  return { ok: true };
}

export function assistantReset() {
  const rt = getRuntime();
  if (rt) {
    rt.history = [];
    saveSession(rt);
  }
  return { ok: true };
}

// ── Event stream untuk panel/pet/akting (bus ber-seq) ──────────

export function assistantEvents(sinceSeq = 0) {
  const d = readEvents(sinceSeq);
  return { latest: d.latest, busy: !!getRuntime()?.busy, events: d.events };
}

// ── Ask: jembatan ke agent loop + narrator di akhir ────────────

function assistantAskNoop(): void {}

export async function assistantAsk(
  text: string,
  config: ConfigManager,
  onEvent: (e: any) => void = assistantAskNoop,
): Promise<{ ok: boolean; error?: string; reply?: string; speak?: string }> {
  const rt = getRuntime();
  if (!rt) return { ok: false, error: "assistant mode tidak aktif" };
  if (rt.busy) return { ok: false, error: "masih memproses pertanyaan sebelumnya" };

  const persona = rt.persona;
  const r = await agentAsk(rt, text, config, onEvent !== assistantAskNoop ? onEvent : undefined);
  if (!r.ok) return r;

  // Lapisan akting: hasil panjang dipadatkan jadi komentar berkarakter.
  const clean = cleanForSpeech(stripToolDirective(r.reply || "", TOOLS.map((t) => t.name)));
  let speak: string | undefined;
  if (clean && !r.reply?.includes("⏳")) {
    if (clean.length <= 240 && !persona) {
      speak = clean;
    } else {
      const n = await narrate({ event: "", result: clean, isError: false, persona }, config);
      speak = n.speak;
    }
  }
  if (speak) onEvent({ type: "speak", text: speak });
  return { ok: true, reply: r.reply, speak };
}

export async function assistantResolveApproval(
  id: string,
  approve: boolean,
  config: ConfigManager,
  onEvent: (e: any) => void = assistantAskNoop,
): Promise<{ ok: boolean; error?: string; reply?: string; speak?: string }> {
  const rt = getRuntime();
  if (!rt) return { ok: false, error: "assistant mode tidak aktif" };
  const ap = rt.approvals.get(id);
  if (!ap) return { ok: false, error: "approval tidak ditemukan" };
  rt.approvals.delete(id);
  // Event bus permission_resolved: tipe sudah dideklarasikan di bus.ts tapi
  // belum pernah di-emit — kini dipakai supaya panel/pet menutup kartu izin
  // secara reaktif (bukan menunggu poll status berikutnya).
  emitEvent("permission_resolved", (approve ? "disetujui: " : "ditolak: ") + ap.tool);
  if (!approve) {
    pushMsg(rt, { role: "tool", content: "User MENOLAK " + ap.tool + " — batalkan rencana itu dan tanyakan alternatif." });
    return { ok: true, reply: "Ditolak. Aku batalkan." };
  }
  await agentRunApproved(rt, ap.tool, ap.args, onEvent !== assistantAskNoop ? onEvent : undefined);
  // lanjutkan reasoning setelah tool dieksekusi — streaming bila onEvent
  // diberikan (approve-stream dari panel), senyap bila tidak (route lama).
  return await assistantAsk("Lanjutkan tugas berdasarkan hasil tool di atas.", config, onEvent);
}

// ── Undo: daftar snapshot & revert (panel tab Review) ────────────

export function assistantUndoList() {
  const rt = getRuntime();
  return rt ? undoList(rt) : [];
}

export function assistantRevert(id: string): string {
  const rt = getRuntime();
  if (!rt) throw new Error("assistant mode tidak aktif");
  return revertUndo(rt, id);
}
