/**
 * server/assistant.ts — Runtime mode AI Assistant/Agent.
 * Agent lokal: LLM + tools (read_file, write_file, list_dir, run_shell)
 * dengan persetujuan user untuk aksi menulis/eksekusi. Satu runtime aktif;
 * start() menghancurkan runtime lama (riwayat + status job).
 */

export type AsMsg = { role: "user" | "assistant" | "tool"; content: string; ts: number };
export type AsApproval = { id: string; tool: string; args: any; ts: number };

type Runtime = {
  cfg: any;
  history: AsMsg[];
  approvals: Map<string, AsApproval>;
  busy: boolean;
  workDir: string;
  destroyed: boolean;
};

let runtime: Runtime | null = null;

const MAX_HISTORY = 60;

export function assistantStatus() {
  return {
    running: !!runtime,
    busy: runtime?.busy || false,
    workDir: runtime?.workDir || null,
    historyCount: runtime?.history.length || 0,
    pendingApprovals: runtime ? Array.from(runtime.approvals.values()) : [],
  };
}

export function assistantHistory(): AsMsg[] {
  return runtime ? runtime.history : [];
}

export function assistantStop() {
  if (runtime) { runtime.destroyed = true; runtime = null; }
  return { ok: true };
}

export function assistantStart(cfg: any): { ok: boolean; error?: string } {
  assistantStop();
  runtime = {
    cfg: cfg || {},
    history: [],
    approvals: new Map(),
    busy: false,
    workDir: String(cfg?.workDir || process.cwd()).trim(),
    destroyed: false,
  };
  return { ok: true };
}

export function assistantReset() {
  if (runtime) runtime.history = [];
  return { ok: true };
}

// ── Tools (sandbox ringan di dalam workDir) ────────────────────
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, resolve, normalize, sep } from "path";
import { execSync } from "child_process";

function safePath(rt: Runtime, p: string): string {
  const base = resolve(rt.workDir);
  const full = resolve(base, normalize(String(p || ".")));
  if (full !== base && !full.startsWith(base + sep)) throw new Error("di luar folder kerja: " + p);
  return full;
}

function toolListDir(rt: Runtime, args: any) {
  const dir = safePath(rt, args.path || ".");
  const entries = readdirSync(dir, { withFileTypes: true }).slice(0, 200).map((e) => {
    let size = 0;
    try { size = statSync(join(dir, e.name)).size; } catch {}
    return (e.isDirectory() ? "[d] " : "[f] ") + e.name + (e.isDirectory() ? "/" : " (" + size + " B)");
  });
  return "Isi " + dir + ":\n" + (entries.join("\n") || "(kosong)");
}

function toolReadFile(rt: Runtime, args: any) {
  const fp = safePath(rt, args.path);
  const text = readFileSync(fp, "utf8");
  return text.length > 12000 ? text.slice(0, 12000) + "\n…(terpotong, " + text.length + " char)" : text;
}

function toolWriteFile(rt: Runtime, args: any) {
  const fp = safePath(rt, args.path);
  mkdirSync(dirname2(fp), { recursive: true });
  writeFileSync(fp, String(args.content ?? ""), "utf8");
  return "Tersimpan: " + fp + " (" + String(args.content ?? "").length + " char)";
}

function dirname2(p: string) { const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i > 0 ? p.slice(0, i) : p; }

function toolRunShell(rt: Runtime, args: any) {
  const cmd = String(args.command || "").trim();
  if (!cmd) throw new Error("command kosong");
  const out = execSync(cmd, { cwd: rt.workDir, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, shell: String(process.env.SHELL || "/bin/bash") });
  const text = String(out || "(tanpa output)");
  return text.length > 12000 ? text.slice(0, 12000) + "\n…(terpotong)" : text;
}

const TOOLS: Record<string, { desc: string; needsApproval: boolean; run: (rt: Runtime, args: any) => string }> = {
  list_dir: { desc: "list_dir {path} — lihat isi folder", needsApproval: false, run: toolListDir },
  read_file: { desc: "read_file {path} — baca file teks", needsApproval: false, run: toolReadFile },
  write_file: { desc: "write_file {path, content} — simpan file", needsApproval: true, run: toolWriteFile },
  run_shell: { desc: "run_shell {command} — jalankan perintah di folder kerja", needsApproval: true, run: toolRunShell },
};

function runTool(rt: Runtime, name: string, args: any): string {
  const tool = TOOLS[name];
  if (!tool) return "Tool tidak dikenal: " + name;
  try { return tool.run(rt, args || {}); } catch (e: any) { return "ERROR: " + e.message; }
}

function pushMsg(rt: Runtime, m: Omit<AsMsg, "ts">) {
  rt.history.push({ ...m, ts: Date.now() });
  if (rt.history.length > MAX_HISTORY) rt.history.splice(0, rt.history.length - MAX_HISTORY);
}

// ── LLM loop (multi-turn dengan tool calls) ─────────────────────
import { llmForRole } from "../shared/llm-client";
import { ConfigManager } from "../shared/config";

const SYSTEM = `Kamu adalah asisten AI yang hidup sebagai karakter Live2D di desktop user.
Kamu punya tools untuk membantu pekerjaan lokal:
${Object.values(TOOLS).map((t) => "- " + t.desc).join("\n")}
Aturan:
1. Untuk pertanyaan biasa, jawab langsung ringkas dan ramah (bahasa Indonesia).
2. Untuk tugas teknis (lihat file, baca kode, tulis file, jalankan perintah), pilih tool yang tepat.
3. Setelah hasil tool kembali, rangkum hasilnya untuk user — jangan hanya tempel output mentah jika panjang.
4. Jangan pernah menulis file atau menjalankan perintah berbahaya (rm -rf, format, dsb).`;

export async function assistantAsk(text: string, config: ConfigManager): Promise<{ ok: boolean; error?: string; reply?: string }> {
  const rt = runtime;
  if (!rt) return { ok: false, error: "assistant mode tidak aktif" };
  if (rt.busy) return { ok: false, error: "masih memproses pertanyaan sebelumnya" };
  rt.busy = true;
  pushMsg(rt, { role: "user", content: String(text || "").slice(0, 4000) });
  try {
    let final = "";
    for (let turn = 0; turn < 6 && !rt.destroyed; turn++) {
      const messages = rt.history
        .filter((m) => m.role !== "tool" || true)
        .map((m) => ({ role: m.role === "tool" ? "user" as const : m.role, content: m.role === "tool" ? "[hasil tool] " + m.content : m.content }));
      const system = SYSTEM + "\nFolder kerja: " + rt.workDir;
      const { reply } = await llmForRole(
        "assistant",
        () => config.connections,
        () => config.activeConnection,
        (conns) => config.saveConnections(conns, config.load().activeId),
        messages,
        system,
      );
      // Deteksi tool call — model sering memformat bebas:
      // "TOOL: nama {json}", "**Tool: nama**\n```json {...}```", atau "nama {json}".
      // Strategi: cari NAMA TOOL yang dikenal di teks, lalu ambil objek {}
      // pertama setelahnya (jendela 160 char) dan parse longgar.
      const detect = () => {
        const clean = String(reply || "").replace(/```[a-z]*\n?/gi, "\n").replace(/\*\*/g, "");
        for (const name of Object.keys(TOOLS)) {
          const idx = clean.toLowerCase().indexOf(name);
          if (idx < 0) continue;
          const windowTxt = clean.slice(idx + name.length, idx + name.length + 160);
          const jm = /\{[^{}]*\}/.exec(windowTxt);
          if (!jm) continue;
          try { return { name, args: JSON.parse(jm[0]) }; } catch {}
          const loose = jm[0].replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":').replace(/'/g, '"');
          try { return { name, args: JSON.parse(loose) }; } catch {}
        }
        return null;
      };
      const detected = detect();
      if (!detected) { final = reply || "(kosong)"; break; }
      const toolName = detected.name;
      const toolArgs: any = detected.args;
      const tool = TOOLS[toolName];
      if (!tool) { pushMsg(rt, { role: "assistant", content: reply }); pushMsg(rt, { role: "tool", content: "Tool tidak dikenal: " + toolName }); continue; }
      if (tool.needsApproval) {
        const id = "ap_" + Math.random().toString(36).slice(2, 8);
        rt.approvals.set(id, { id, tool: toolName, args: toolArgs, ts: Date.now() });
        pushMsg(rt, { role: "assistant", content: reply });
        pushMsg(rt, { role: "tool", content: "MENUNGGU PERSETUJUAN: " + toolName + " " + JSON.stringify(toolArgs).slice(0, 300) + " (id " + id + ")" });
        final = reply + "\n\n⏳ Aku butuh izinmu untuk " + toolName + " — cek panel Assistant.";
        break;
      }
      const result = runTool(rt, toolName, toolArgs);
      pushMsg(rt, { role: "assistant", content: reply });
      pushMsg(rt, { role: "tool", content: "[" + toolName + "] " + result.slice(0, 2000) });
      if (turn === 5) final = result.slice(0, 1000);
    }
    if (final) pushMsg(rt, { role: "assistant", content: final });
    return { ok: true, reply: final || undefined };
  } catch (e: any) {
    pushMsg(rt, { role: "assistant", content: "⚠️ " + e.message });
    return { ok: false, error: e.message };
  } finally { rt.busy = false; }
}

export async function assistantResolveApproval(id: string, approve: boolean, config: ConfigManager): Promise<{ ok: boolean; error?: string; reply?: string }> {
  const rt = runtime;
  if (!rt) return { ok: false, error: "assistant mode tidak aktif" };
  const ap = rt.approvals.get(id);
  if (!ap) return { ok: false, error: "approval tidak ditemukan" };
  rt.approvals.delete(id);
  if (!approve) {
    pushMsg(rt, { role: "tool", content: "User MENOLAK " + ap.tool + " — batalkan rencana itu dan tanyakan alternatif." });
    return { ok: true, reply: "Ditolak. Aku batalkan." };
  }
  const result = runTool(rt, ap.tool, ap.args);
  pushMsg(rt, { role: "tool", content: "[" + ap.tool + "] " + result.slice(0, 2000) });
  // lanjutkan reasoning setelah tool dieksekusi
  return await assistantAsk("Lanjutkan tugas berdasarkan hasil tool di atas.", config);
}
