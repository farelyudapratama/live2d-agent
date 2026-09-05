/**
 * server/assistant.ts — Runtime mode AI Assistant/Agent.
 * Agent lokal: LLM + tools (read_file, write_file, list_dir, run_shell)
 * dengan persetujuan user untuk aksi menulis/eksekusi. Satu runtime aktif;
 * start() menghancurkan runtime lama (riwayat + status job).
 */

export type AsMsg = { role: "user" | "assistant" | "tool"; content: string; ts: number };
export type AsApproval = { id: string; tool: string; args: any; ts: number };

/** Event stream untuk CLI / klien yang mau melihat proses secara langsung.
 *  delta       — potongan teks LLM yang baru masuk
 *  tool_call   — LLM meminta tool dijalankan
 *  tool_result — hasil tool (terpotong seperti yang disimpan ke history)
 *  approval    — butuh izin user (loop berhenti sampai disetujui) */
export type AsEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: any }
  | { type: "tool_result"; name: string; text: string }
  | { type: "approval"; id: string; tool: string; args: any };

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

// Pembanding identitas untuk deteksi "klien tanpa listener" — tidak pernah
// dipanggil, hanya referensi default parameter.
function assistantAskNoop(): void {}

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
  // Session sebelumnya dimuat ulang: riwayat & folder kerja bertahan lintas
  // restart. workDir eksplisit dari pemanggil (CLI --cwd / panel) menang.
  const saved = loadSession();
  const workDir = String(cfg?.workDir || saved?.workDir || process.cwd()).trim();
  runtime = {
    cfg: cfg || {},
    history: saved?.history ? saved.history.slice() : [],
    approvals: new Map(),
    busy: false,
    workDir,
    destroyed: false,
  };
  saveSession(runtime);
  return { ok: true };
}

export function assistantReset() {
  if (runtime) {
    runtime.history = [];
    saveSession(runtime);
  }
  return { ok: true };
}

// ── Tools (sandbox ringan di dalam workDir) ────────────────────
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, resolve, normalize, sep } from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ── Persist sesi (Fase 4) ───────────────────────────────────────
// Riwayat & folder kerja disimpan ke data/assistant-history.json supaya
// sesi tidak lenyap saat server restart. Approval SENGAJA tidak dipersist —
// izin per aksi itu keputusan instan, bukan state lintas sesi.
import { queueJsonWrite } from "../shared/config";

const SESSION_FILE = join(process.cwd(), "data", "assistant-history.json");

function loadSession(): { history: AsMsg[]; workDir: string | null } | null {
  try {
    const raw = readFileSync(SESSION_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!Array.isArray(j?.history)) return null;
    return { history: j.history.slice(-MAX_HISTORY), workDir: typeof j.workDir === "string" ? j.workDir : null };
  } catch { return null; }
}

function saveSession(rt: Runtime): void {
  try {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    queueJsonWrite(SESSION_FILE, { history: rt.history.slice(-MAX_HISTORY), workDir: rt.workDir }).catch(() => {});
  } catch {}
}

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
  // ASYNC (dibungkus promise oleh pemanggil): execSync dulu memblokir
  // seluruh event loop Bun — selama perintah jalan server tak bisa menjawab
  // apa pun (polling pet, TTS, chat HTTP semuanya macet sampai 30 dtk).
  const cmd = String(args.command || "").trim();
  if (!cmd) throw new Error("command kosong");
  // Windows tanpa SHELL (start.bat dari cmd.exe) dulu jatuh ke "/bin/bash"
  // dan run_shell selalu error — fallback ke ComSpec.
  const shell =
    process.platform === "win32"
      ? String(process.env.ComSpec || "cmd.exe")
      : String(process.env.SHELL || "/bin/bash");
  return execAsync(cmd, {
    cwd: rt.workDir,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    shell,
  }).then(
    ({ stdout }) => {
      const text = String(stdout || "(tanpa output)");
      return text.length > 12000 ? text.slice(0, 12000) + "\n…(terpotong)" : text;
    },
    (err: any) => {
      // exit non-zero / timeout tetap diekspos ke LLM sebagai hasil tool,
      // bukan exception yang mematahkan loop reasoning.
      const out = String(err?.stdout || "") + (err?.stdout ? "\n" : "") + String(err?.stderr || err?.message || "gagal");
      const text = out.trim() || "gagal tanpa output";
      return text.length > 12000 ? text.slice(0, 12000) + "\n…(terpotong)" : "ERROR: " + text;
    },
  );
}

const TOOLS: Record<string, { desc: string; needsApproval: boolean; run: (rt: Runtime, args: any) => string | Promise<string> }> = {
  list_dir: { desc: "list_dir {path} — lihat isi folder", needsApproval: false, run: toolListDir },
  read_file: { desc: "read_file {path} — baca file teks", needsApproval: false, run: toolReadFile },
  write_file: { desc: "write_file {path, content} — simpan file", needsApproval: true, run: toolWriteFile },
  run_shell: { desc: "run_shell {command} — jalankan perintah di folder kerja", needsApproval: true, run: toolRunShell },
};

async function runTool(rt: Runtime, name: string, args: any): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) return "Tool tidak dikenal: " + name;
  try { return await tool.run(rt, args || {}); } catch (e: any) { return "ERROR: " + e.message; }
}

function pushMsg(rt: Runtime, m: Omit<AsMsg, "ts">) {
  rt.history.push({ ...m, ts: Date.now() });
  if (rt.history.length > MAX_HISTORY) rt.history.splice(0, rt.history.length - MAX_HISTORY);
  saveSession(rt);
}

// ── LLM loop (multi-turn dengan tool calls) ─────────────────────
import { llmForRole, llmForRoleStream } from "../shared/llm-client";
import { ConfigManager } from "../shared/config";

const SYSTEM = `Kamu adalah asisten AI yang hidup sebagai karakter Live2D di desktop user.
Kamu punya tools untuk membantu pekerjaan lokal:
${Object.values(TOOLS).map((t) => "- " + t.desc).join("\n")}
Aturan:
1. Untuk pertanyaan biasa, jawab langsung ringkas dan ramah (bahasa Indonesia).
2. Untuk tugas teknis (lihat file, baca kode, tulis file, jalankan perintah), pilih tool yang tepat.
3. Setelah hasil tool kembali, rangkum hasilnya untuk user — jangan hanya tempel output mentah jika panjang.
4. Jangan pernah menulis file atau menjalankan perintah berbahaya (rm -rf, format, dsb).`;

export async function assistantAsk(
  text: string,
  config: ConfigManager,
  onEvent: (e: AsEvent) => void = assistantAskNoop,
): Promise<{ ok: boolean; error?: string; reply?: string }> {
  // Versi streaming hanya menyala saat klien meminta event (CLI / SSE) —
  // panel browser memakai jalur lama tanpa delta.
  const onDeltaFn: ((piece: string) => void) | null =
    onEvent !== assistantAskNoop ? (piece) => onEvent({ type: "delta", text: piece }) : null;
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
      // Jalur non-stream (browser panel): perilaku lama persis — fallback
      // antar koneksi bebas mengulang karena belum ada teks yang tercetak.
      // Jalur stream (CLI/SSE): delta diteruskan; fallback dibatasi (teks
      // yang sudah tercetak tidak boleh diulang koneksi lain).
      const llmCall = onDeltaFn
        ? llmForRoleStream(
            "assistant",
            () => config.connections,
            () => config.activeConnection,
            (conns) => config.saveConnections(conns, config.load().activeId),
            messages,
            system,
            onDeltaFn,
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
      onEvent({ type: "tool_call", name: toolName, args: toolArgs });
      const tool = TOOLS[toolName];
      if (!tool) { pushMsg(rt, { role: "assistant", content: reply }); pushMsg(rt, { role: "tool", content: "Tool tidak dikenal: " + toolName }); continue; }
      if (tool.needsApproval) {
        const id = "ap_" + Math.random().toString(36).slice(2, 8);
        // Cap antrean izin: runtime sekarang hidup lama (layanan mandiri).
        // Approval yang diabaikan user dulu menumpuk di Map tanpa batas —
        // yang tertua dibuang, dan model diberi tahu lewat riwayat.
        while (rt.approvals.size >= 8) {
          const oldest = rt.approvals.keys().next().value as string;
          rt.approvals.delete(oldest);
          pushMsg(rt, { role: "tool", content: "Permintaan izin lama kedaluwarsa (antrean penuh) — minta lagi kalau masih perlu." });
        }
        rt.approvals.set(id, { id, tool: toolName, args: toolArgs, ts: Date.now() });
        pushMsg(rt, { role: "assistant", content: reply });
        pushMsg(rt, { role: "tool", content: "MENUNGGU PERSETUJUAN: " + toolName + " " + JSON.stringify(toolArgs).slice(0, 300) + " (id " + id + ")" });
        onEvent({ type: "approval", id, tool: toolName, args: toolArgs });
        final = reply + "\n\n⏳ Aku butuh izinmu untuk " + toolName + " — cek panel Assistant.";
        break;
      }
      const result = await runTool(rt, toolName, toolArgs);
      pushMsg(rt, { role: "assistant", content: reply });
      pushMsg(rt, { role: "tool", content: "[" + toolName + "] " + result.slice(0, 2000) });
      onEvent({ type: "tool_result", name: toolName, text: result.slice(0, 2000) });
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
  const result = await runTool(rt, ap.tool, ap.args);
  pushMsg(rt, { role: "tool", content: "[" + ap.tool + "] " + result.slice(0, 2000) });
  // lanjutkan reasoning setelah tool dieksekusi
  return await assistantAsk("Lanjutkan tugas berdasarkan hasil tool di atas.", config);
}
