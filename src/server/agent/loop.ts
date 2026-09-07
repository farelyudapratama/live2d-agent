/**
 * server/agent/loop.ts — Agentic loop utama (otak kerja).
 * Siklus standar: system prompt + task → model → tool_use? → eksekusi
 * (level "safe" langsung, "mutating" pause + permission_request) →
 * tool_result balik ke model → … → jawaban final → final_answer.
 * Loop TIDAK tahu apa-apa soal karakter/emosi — itu urusan persona/.
 */
import { llmForRole, llmForRoleStream } from "../../shared/llm-client";
import type { ConfigManager } from "../../shared/config";
import type { Runtime } from "./state";
import type { AsEvent } from "../assistant-events";
import { pushMsg, noteFileTouched, pushUndo } from "./state";
import { snapshotFile } from "./undo";
import { safePath } from "./tools/fs";
import { TOOLS, toolByName } from "./tools/index";
import { trackToolSeq } from "./tools/plan";
import { planLabel } from "./plan";
import type { ToolCtx } from "./tools/index";
import { stripToolDirective } from "./parse";
import { clipToolResult, maybeSummarize, notesBlock } from "./context";
import { memoryPromptBlock } from "./memory";
import { emitEvent } from "./bus";

export const MAX_ITERATIONS = 25;

/** Nama semua tool terdaftar — untuk stripToolDirective (filter baris tool-call). */
const TOOL_NAMES = TOOLS.map((t) => t.name);

export type AskResult = { ok: boolean; error?: string; reply?: string };

function buildSystem(lang: string, workDir: string): string {
  const t = {
    id: {
      head: "Kamu adalah AI agent lokal (seperti coding-agent) yang tampil sebagai karakter Live2D di desktop user. Tugasmu MENYELESAIKAN permintaan user di folder kerja — bukan mengobrol. Gaya: ringkas, padat, tetap ramah.",
      tools: "TOOLS — untuk memanggil, balas DENGAN PERSIS satu baris ini (JSON valid, tanpa markdown):",
      rules: [
        "0. FORMAT PANGGILAN TOOL WAJIB persis seperti contoh di atas. DILARANG memakai format lain (<tool_call>, XML, ```json, fungsi bawaan).",
        "1. PAHAMI DULU. Pertanyaan yang tidak butuh file/perintah (tanya kemampuan, konsep, opini) dijawab LANGSUNG di jawaban final — JANGAN memanggil tool.",
        "2. Kalau butuh data, panggil tool. Sebelum baris TOOL: boleh MAKSIMAL SATU kalimat rencana pendek. Tanpa emoji, tanpa markdown tebal.",
        "3. Setiap '[hasil tool] …' yang kembali WAJIB dilanjutkan: panggil tool berikutnya bila perlu, atau beri jawaban final. JANGAN mengulang tool yang sama dengan argumen yang sama. JANGAN berhenti diam. Kalau tool GAGAL, coba pendekatan lain (mis. list_dir / search_code) dulu.",
        "4. Jawaban FINAL: apa yang dikerjakan + temuan penting (nama file, angka, hasil perintah). Maksimal ~4 kalimat, tanpa emoji, tanpa markdown tebal, tanpa output mentah panjang.",
        "5. Tugas selesai → berhenti memanggil tool. Kalau permintaan tidak jelas, tanyakan SEKALI yang spesifik.",
        "6. DILARANG KERAS menulis/menghapus file di luar kebutuhan user atau menjalankan perintah merusak (rm -rf, format, dsb) — tool mutating selalu minta izin user, jangan coba mengakalinya.",
        "7. PLANNING: task yang multi-langkah/multi-file WAJIB dimulai dengan update_plan (rencana todo), dan status diperbarui tiap ada progress. Kalau rencana berubah di tengah jalan, kirim ulang plan + 'reason' singkat.",
        "8. SELF-VERIFICATION: sebelum item ditandai 'done' yang menyentuh file/kode, VERIFIKASI dulu — run_command (build/typecheck/test) untuk kode, read_file untuk konfirmasi isi. update_plan akan MENOLAK done kalau belum ada verifikasi.",
        "9. MEMORY: preferensi user / keputusan penting / pelajaran gagal → simpan via remember (key singkat). Butuh konteks → recall. Jangan simpan hal sementara.",
        "10. SUBAGENT: sub-task riset/analisa yang INDEPENDEN satu sama lain boleh didelegasikan paralel via spawn_subagent (read-only). Task yang bergantung → kerjakan sendiri berurutan.",
      ],
      final: "Jawab user dalam bahasa Indonesia.",
    },
    en: {
      head: "You are a local AI agent (like a coding agent) appearing as the user's Live2D desktop character. Your job is to COMPLETE the user's request in the working folder — not to chat. Style: concise, to the point, still friendly.",
      tools: "TOOLS — to call one, reply with EXACTLY one line like this (valid JSON, no markdown):",
      rules: [
        "0. TOOL CALL FORMAT MUST be exactly as shown above. FORBIDDEN: <tool_call>, XML, ```json, native function-call syntax.",
        "1. UNDERSTAND FIRST. Questions needing no files/commands are answered DIRECTLY in a final reply — DO NOT call tools.",
        "2. If you need data, call a tool. At most ONE short plan sentence before the TOOL: line. No emoji, no bold markdown.",
        "3. Every '[hasil tool] …' result MUST be followed up: next tool or final answer. NEVER repeat the same tool with the same args. NEVER stop silently. If a tool FAILS, try another approach (list_dir / search_code) first.",
        "4. FINAL reply: what you did + key findings. Max ~4 sentences, no emoji, no bold markdown, no raw dumps.",
        "5. Task done → stop calling tools. If unclear, ask ONE specific clarifying question.",
        "6. NEVER write/delete files beyond the user's request or run destructive commands — mutating tools always ask user permission; do not try to work around it.",
        "7. PLANNING: multi-step/multi-file tasks MUST start with update_plan and update statuses as progress happens. If the plan changes mid-task, resend it with a short 'reason'.",
        "8. SELF-VERIFICATION: before marking a file/code-touching item 'done', VERIFY first — run_command (build/typecheck/test) for code, read_file to confirm content. update_plan REJECTS done without verification.",
        "9. MEMORY: user preferences / key decisions / failure lessons → save via remember (short key). Need context → recall. Do not store transient stuff.",
        "10. SUBAGENT: independent research/analysis sub-tasks may be delegated in parallel via spawn_subagent (read-only). Dependent tasks → do them yourself in order.",
      ],
      final: "Reply to the user in English.",
    },
  }[lang === "en" ? "en" : "id"];
  return [
    t.head,
    "",
    "Folder kerja: " + workDir,
    "",
    t.tools,
    ...TOOLS.map(
      (x) =>
        "TOOL: " +
        x.name +
        " {" +
        Object.entries(x.params).map(([k, v]) => k + ": " + v).join(", ") +
        "} — level: " +
        x.level,
    ),
    "",
    "ATURAN:",
    ...t.rules,
    "",
    t.final,
  ].join("\n");
}

/** Deteksi tool call — model sering memformat bebas; parse longgar. */
export function detectToolCall(reply: string): { name: string; args: any } | null {
  const clean = String(reply || "").replace(/```[a-z]*\n?/gi, "\n").replace(/\*\*/g, "");
  const names = TOOLS.map((t) => t.name).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const idx = clean.toLowerCase().indexOf(name);
    if (idx < 0) continue;
    const windowTxt = clean.slice(idx + name.length, idx + name.length + 160);
    const jm = /\{[^{}]*\}/.exec(windowTxt);
    if (!jm) continue;
    try {
      return { name, args: JSON.parse(jm[0]) };
    } catch {}
    const loose = jm[0]
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"');
    try {
      return { name, args: JSON.parse(loose) };
    } catch {}
  }
  return null;
}

const UNDO_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);

async function execTool(rt: Runtime, name: string, args: any): Promise<string> {
  const tool = toolByName(name);
  if (!tool) return "ERROR: tool tidak dikenal: " + name;
  const ctx: ToolCtx = {
    workDir: rt.workDir,
    noteFile: (p) => {
      noteFileTouched(rt, p);
    },
    rt,
  };
  // Snapshot undo SEBELUM eksekusi (kondisi asli) — path dicek safePath agar
  // tak pernah membaca di luar workDir. Hanya dicatat bila tool sukses.
  let undoAbs: string | null = null;
  if (UNDO_TOOLS.has(name) && args && typeof args === "object" && typeof args.path === "string") {
    try {
      undoAbs = safePath(rt.workDir, args.path);
    } catch {
      undoAbs = null; // di luar workDir — tool akan gagal sendiri
    }
  }
  const undoPrev = undoAbs !== null ? snapshotFile(undoAbs) : null;
  try {
    const res = await tool.run(ctx, args || {});
    if (!/^ERROR/.test(res) && undoAbs !== null) {
      const existing = rt.undo.find((u) => u.absPath === undoAbs && !u.reverted);
      if (!existing) {
        // Rekaman pertama untuk path ini = kondisi ASLI sebelum rantai
        // mutasi agent — satu-satunya yang revert-nya bermakna.
        pushUndo(rt, {
          absPath: undoAbs,
          relPath: String(args.path).replace(/\\/g, "/"),
          prevContent: undoPrev,
        });
      }
    }
    return res;
  } catch (e: any) {
    return "ERROR: " + (e?.message || String(e));
  }
}

/**
 * Jalankan satu tugas (multi-turn tool loop). onEvent = sink SSE opsional;
 * semua event juga otomatis masuk bus (bus.ts) untuk panel/pet/akting.
 */
export async function agentAsk(
  rt: Runtime,
  text: string,
  config: ConfigManager,
  onEvent?: (e: AsEvent) => void,
): Promise<AskResult> {
  const emit = (e: AsEvent) => {
    if (onEvent) onEvent(e);
  };
  const lang = config.load().i18n?.lang === "en" ? "en" : "id";

  rt.busy = true;
  rt.cancelRequested = false; // cancel berlaku satu tugas — reset di awal ask
  emitEvent("thinking_start", String(text || "").slice(0, 120));
  emit({ type: "delta", text: "" });
  pushMsg(rt, { role: "user", content: String(text || "").slice(0, 4000) });
  try {
    await maybeSummarize(rt, config);
    let final = "";
    let cancelled = false;
    const seenCalls = new Set<string>();
    for (let turn = 0; turn < MAX_ITERATIONS && !rt.destroyed; turn++) {
      if (rt.cancelRequested) { cancelled = true; break; }
      const messages = rt.history.map((m) => ({
        role: m.role === "tool" ? ("user" as const) : m.role,
        content: m.role === "tool" ? "[hasil tool] " + m.content : m.content,
      }));
      const system =
        buildSystem(lang, rt.workDir) + memoryPromptBlock() + notesBlock(rt);

      // Jalur non-stream (panel): fallback bebas mengulang. Jalur stream
      // (CLI/SSE): delta diteruskan, fallback dibatasi oleh pemanggil.
      const llmCall = onEvent
        ? llmForRoleStream(
            "assistant",
            () => config.connections,
            () => config.activeConnection,
            (conns) => config.saveConnections(conns, config.load().activeId),
            messages,
            system,
            (piece) => emit({ type: "delta", text: piece }),
          )
        : llmForRole(
            "assistant",
            () => config.connections,
            () => config.activeConnection,
            (conns) => config.saveConnections(conns, config.load().activeId),
            messages,
            system,
          );
      const { reply } = await llmCall;

      const detected = detectToolCall(reply);
      if (!detected) {
        final = reply || "(kosong)";
        break;
      }
      const tool = toolByName(detected.name);
      const callKey = detected.name + " " + JSON.stringify(detected.args);
      if (!tool) {
        pushMsg(rt, { role: "assistant", content: stripToolDirective(reply, TOOL_NAMES) });
        pushMsg(rt, { role: "tool", content: "ERROR: tool tidak dikenal: " + detected.name });
        continue;
      }
      if (seenCalls.has(callKey)) {
        // Anti-stuck: tool identik dua kali → paksa finalisasi.
        final = stripToolDirective(reply, TOOL_NAMES) || "(berhenti setelah duplikasi tool)";
        break;
      }
      seenCalls.add(callKey);

      emitEvent("tool_call_start", detected.name + " " + JSON.stringify(detected.args).slice(0, 100));
      emit({ type: "tool_call", name: detected.name, args: detected.args });

      if (tool.level === "mutating") {
        // PERMISSION GATE — pause loop sampai user memutuskan.
        const id = "ap_" + Math.random().toString(36).slice(2, 8);
        while (rt.approvals.size >= 8) {
          const oldest = rt.approvals.keys().next().value as string;
          rt.approvals.delete(oldest);
          pushMsg(rt, { role: "tool", content: "Permintaan izin lama kedaluwarsa (antrean penuh) — minta lagi kalau masih perlu." });
        }
        rt.approvals.set(id, { id, tool: detected.name, args: detected.args, ts: Date.now() });
        pushMsg(rt, { role: "assistant", content: stripToolDirective(reply, TOOL_NAMES) });
        pushMsg(rt, {
          role: "tool",
          content: "MENUNGGU PERSETUJUAN: " + detected.name + " " + JSON.stringify(detected.args).slice(0, 300) + " (id " + id + ")",
        });
        emitEvent("permission_request", detected.name);
        emit({ type: "approval", id, tool: detected.name, args: detected.args });
        final = stripToolDirective(reply, TOOL_NAMES) + "\n\n⏳ Aku butuh izinmu untuk " + detected.name + " — cek panel Assistant.";
        break;
      }

      const result = await execTool(rt, detected.name, detected.args);
      trackToolSeq(rt, detected.name);
      pushMsg(rt, { role: "assistant", content: stripToolDirective(reply, TOOL_NAMES) });
      pushMsg(rt, { role: "tool", content: "[" + detected.name + "] " + clipToolResult(result) });
      emitEvent("tool_call_end", detected.name + " → " + result.slice(0, 80));
      emit({ type: "tool_result", name: detected.name, text: result.slice(0, 2000) });
      // Cancel kooperatif: cek SETELAH tool selesai — tool yang panjang
      // (mis. run_command ≤30 dtk) dibereskan dulu, turn berikutnya tak jalan.
      if (rt.cancelRequested) { cancelled = true; break; }
    }
    if (!final && rt.destroyed) final = "(dihentikan)";
    if (!final && cancelled) {
      final = "Dibatalkan oleh user.";
      rt.cancelRequested = false; // bersih — cancel berikutnya minta lagi
      emitEvent("error", "dibatalkan: oleh user");
    }
    if (!final) final = "(berhenti tanpa jawaban setelah " + MAX_ITERATIONS + " langkah — coba pecah tugasnya)";
    pushMsg(rt, { role: "assistant", content: stripToolDirective(final, TOOL_NAMES) });
    const finalText = stripToolDirective(final, TOOL_NAMES);
    emitEvent("final_answer", (rt.plan.length ? "[" + planLabel(rt.plan) + "] " : "") + finalText.slice(0, 120));
    return { ok: true, reply: finalText };
  } catch (e: any) {
    pushMsg(rt, { role: "assistant", content: "⚠️ " + e.message });
    emitEvent("error", String(e.message || "").slice(0, 120));
    return { ok: false, error: e.message };
  } finally {
    rt.busy = false;
  }
}

/** Eksekusi tool mutating SETELAH user menyetujui (dari facade assistant).
 *  onEvent opsional: hasil tool diteruskan juga via SSE supaya kartu tool di
 *  transcript panel terisi dari jalur approval (bukan hanya bus). */
export async function agentRunApproved(
  rt: Runtime,
  toolName: string,
  args: any,
  onEvent?: (e: AsEvent) => void,
): Promise<string> {
  const result = await execTool(rt, toolName, args);
  pushMsg(rt, { role: "tool", content: "[" + toolName + "] " + clipToolResult(result) });
  emitEvent("tool_call_end", toolName + " → " + result.slice(0, 80));
  if (onEvent) onEvent({ type: "tool_result", name: toolName, text: result.slice(0, 2000) });
  return result;
}
