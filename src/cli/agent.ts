#!/usr/bin/env bun
/**
 * src/cli/agent.ts — CLI untuk mode AI Assistant.
 *
 * Otak agent hidup di server Bun (src/server/assistant.ts); CLI ini cuma
 * layar lain yang memanggil API yang sama dengan panel di browser. Jadi
 * riwayat, approval, dan folder kerja dipegang server — CLI boleh dibuka-
 * tutup kapan saja tanpa kehilangan sesi.
 *
 * Pakai (server harus sudah jalan: start.bat / bun run dev):
 *   bun run agent                        → folder kerja = cwd saat ini
 *   bun run agent --cwd ../proyek-lain   → set folder kerja lain
 *   bun run agent --yes                  → auto-setujui write_file/run_shell
 *                                          (HATI-HATI: tanpa konfirmasi)
 *
 * Perintah slash: /status /history /reset /stop /help /exit
 * Catatan: server memegang kontrak satu-mode-aktif — menyalakan assistant
 * lewat CLI akan menutup pet/VTuber yang sedang jalan.
 */
import { createInterface } from "readline/promises";

const args = process.argv.slice(2);
let cwdArg: string | null = null;
let autoYes = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cwd") cwdArg = args[++i] ?? null;
  else if (args[i] === "--yes") autoYes = true;
}

const PORT = process.env.PORT || "8310";
const API = `http://127.0.0.1:${PORT}`;

async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(API + path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || "HTTP " + r.status);
  return d;
}

function printHelp() {
  console.log(`Perintah:
  /status    status runtime (folder kerja, approval menunggu)
  /history   tampilkan riwayat percakapan
  /reset     kosongkan riwayat
  /stop      matikan runtime assistant (lalu keluar)
  /help      bantuan ini
  /exit      keluar (runtime tetap hidup di server)`);
}

async function main() {
  // Cek server dulu supaya pesan errornya jelas, bukan fetch exception.
  try { await fetch(API + "/api/mode"); } catch {
    console.error(`Server tidak jalan di ${API} — jalankan start.bat / bun run dev dulu.`);
    process.exit(1);
  }

  const mode = await api("/api/mode");
  await api("/api/assistant/start", cwdArg ? { workDir: cwdArg } : {});
  if (mode.vtuber?.running) {
    console.log("(catatan: VTuber sedang jalan — keduanya bisa bareng; assistant & pet adalah layanan mandiri)");
  }
  const st0 = await api("/api/assistant/status");
  if (st0.historyCount > 0) {
    console.log(`Sesi dipulihkan: ${st0.historyCount} pesan, folder kerja ${st0.workDir}`);
  } else {
    console.log(`Agent siap. Folder kerja: ${st0.workDir}`);
  }
  if (autoYes) console.log("MODE --yes: write_file & run_shell DISETUJUI OTOMATIS.");
  printHelp();
  console.log("");

  // Antrean baris manual di atas readline: readline mengumpulkan SEMUA baris
  // input tanpa peduli ada question() aktif atau tidak. Saat input piped
  // (atau user mengetik cepat), baris "y" / "/exit" bisa masuk ke buffer
  // readline SEBELUM loop utama sempat bertanya — question() berikutnya
  // tidak pernah menerima apa pun (readline dianggap sudah menjawab) dan
  // urutan jawaban kacau. Antrean sendiri menjamin FIFO yang benar.
  const pendingLines: string[] = [];
  let lineWaiter: ((v: string) => void) | null = null;
  let stdinClosed = false;
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
  rl.on("line", (l) => {
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); }
    else pendingLines.push(l);
  });
  rl.on("close", () => {
    stdinClosed = true;
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w("/exit"); }
  });
  const ask = (q: string) => {
    process.stdout.write(q);
    if (pendingLines.length) return Promise.resolve(pendingLines.shift()!);
    if (stdinClosed) return Promise.resolve("/exit");
    return new Promise<string>((resolve) => { lineWaiter = resolve; });
  };

  // Approval bisa berantai: menyetujui satu tool melanjutkan reasoning yang
  // bisa meminta izin lagi — loop sampai tidak ada yang tertunda.
  async function drainApprovals() {
    for (;;) {
      const st = await api("/api/assistant/status");
      const pending: any[] = st.pendingApprovals || [];
      if (!pending.length) return;
      for (const ap of pending) {
        let ok: boolean;
        if (autoYes) {
          ok = true;
          console.log(`  (auto) izinkan ${ap.tool} ${JSON.stringify(ap.args)}`);
        } else {
          const ans = (await ask(`izin ${ap.tool} ${JSON.stringify(ap.args)} [y/n] › `)).trim().toLowerCase();
          ok = ans === "y" || ans === "yes" || ans === "ya";
        }
        const res = await api("/api/assistant/approve", { id: ap.id, approve: ok });
        if (res.reply) console.log("agent › " + res.reply);
      }
    }
  }

  // Tanya dengan streaming: teks LLM tercetak seiring masuk, event tool dan
  // approval juga tampil live. Server lama tanpa /ask-stream → fallback ke
  // POST biasa (jawaban muncul sekaligus, seperti sebelumnya).
  async function askStreaming(text: string) {
    try {
      const resp = await fetch(API + "/api/assistant/ask-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);
      process.stdout.write("agent › ");
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let errored: string | null = null;
      let streamedAny = false;
      const handle = (obj: any) => {
        if (obj.type === "delta") { streamedAny = true; process.stdout.write(obj.text); }
        else if (obj.type === "tool_call") console.log(`\n  [tool] ${obj.name} ${JSON.stringify(obj.args)}`);
        else if (obj.type === "tool_result") console.log(`\n  [hasil ${obj.name}] ${String(obj.text).split("\n")[0].slice(0, 160)}`);
        else if (obj.type === "approval") console.log(`\n  ⏳ butuh izin ${obj.tool} — jawab di bawah / atau /status`);
        else if (obj.type === "done") {
          process.stdout.write("\n");
          if (obj.ok === false) errored = obj.error || "gagal";
          // Kasus langka: teks final tidak pernah ter-stream (hasil tool di
          // putaran ke-6) — cetak sekarang, jangan sampai jawaban hilang.
          else if (obj.reply && !streamedAny) console.log("agent › " + obj.reply);
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const m of frame.matchAll(/^data: (.*)$/gm)) {
            try { handle(JSON.parse(m[1])); } catch {}
          }
        }
      }
      if (errored) console.log("gagal › " + errored);
    } catch (e: any) {
      // Server lama / endpoint tidak ada — jatuh ke jalur biasa.
      const r = await api("/api/assistant/ask", { text }).catch((e2: any) => { throw e2; });
      if (r.reply) console.log("agent › " + r.reply);
    }
  }

  for (;;) {
    let line: string;
    try {
      line = (await ask("you › ")).trim();
    } catch {
      break; // Ctrl+C
    }
    if (!line) continue;

    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") { printHelp(); continue; }
    if (line === "/reset") {
      await api("/api/assistant/reset", {});
      console.log("Riwayat dikosongkan.");
      continue;
    }
    if (line === "/stop") {
      await api("/api/assistant/stop", {});
      console.log("Runtime assistant dimatikan. Keluar.");
      break;
    }
    if (line === "/status") {
      const st = await api("/api/assistant/status");
      console.log(JSON.stringify({ ...st, pendingApprovals: st.pendingApprovals?.length || 0 }, null, 2));
      continue;
    }
    if (line === "/history") {
      const h = await api("/api/assistant/history");
      for (const m of h) console.log(`[${m.role}] ${m.content}`);
      continue;
    }
    if (line.startsWith("/")) {
      console.log("Perintah tidak dikenal — /help untuk daftar.");
      continue;
    }

    await askStreaming(line);
    try {
      await drainApprovals();
    } catch (e: any) {
      console.log("gagal › " + e.message);
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error("fatal: " + e.message);
  process.exit(1);
});
