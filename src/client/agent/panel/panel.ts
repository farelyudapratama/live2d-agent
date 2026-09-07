/**
 * client/agent/panel/panel.ts — Panel agent (mode Assistant), port dari
 * mode-runtime.js saat remake tampilan ala ZCode.
 *
 * Kontrak mode (docs/MODES.md): panel hanya LAYAR — runtime assistant di
 * server adalah layanan mandiri (CLI `bun run agent` memakai runtime yang
 * sama). destroy() melepas UI, TIDAK mematikan runtime.
 *
 * Sumber kebenaran (revisi remake):
 *   - Kartu approval: satu-satunya sumber = pendingApprovals dari poll
 *     /status, keyed by apId. Event SSE/bus izin hanya pemicu refresh.
 *   - Plan: satu sumber = status.plan (re-render idempotent).
 *   - Transcript: mode live (SSE) vs follow (bus). Protokol koneksi dua-kasus
 *     ada di stream.ts (decideFallback).
 */

import { Transcript, CONTINUATION_PROMPT } from "./transcript";
import type { Block } from "./transcript";
import { decideFallback, readSseStream, postJson } from "./stream";
import type { AsSseEvent } from "./stream";
import { ChangeRegistry, TermLog } from "./registry";
import { makeActor } from "./actor";
import { createPanelView } from "./view";
import type { TechnicalTab } from "./view";

const API = location.origin;

type StatusResp = {
  running?: boolean;
  busy?: boolean;
  workDir?: string | null;
  pendingApprovals?: Array<{ id: string; tool: string; args: any }>;
  plan?: any[];
  notes?: { filesTouched?: string[] };
  tools?: Array<{ name: string; level: "safe" | "mutating" }>;
};

function getT() {
  const i = (window as any).__i18n;
  return (k: string, v?: Record<string, string | number>) => (i ? i.t(k, v) : k);
}

function speakAsCharacter(text: string): void {
  if (!text) return;
  try { (window as any).__addChat?.("agent", text); } catch {}
  try { (window as any).__live2dAgent?.speak?.(text); } catch {}
}

export function startAssistantPanel(): () => void {
  const t = getT();
  const root = document.getElementById("as-root");
  const techRoot = document.getElementById("as-tech-root");
  if (!root) return () => {};
  const rootEl: HTMLElement = root;
  const techRootEl: HTMLElement | null = techRoot;

  let transcript = new Transcript();
  const registry = new ChangeRegistry(); // perubahan file sesi (tab Review)
  const termLog = new TermLog(); // riwayat run_command (tab Terminal)
  /** name → level tool (dari /status; sumber kebenaran = registry server). */
  const toolLevels = new Map<string, "safe" | "mutating">();
  let destroyBrowserPanel: (() => void) | null = null;
  const view = createPanelView(rootEl, techRootEl, {
    t,
    onApprove: approve,
    onTabChange: drawPages,
    toolLevel: (name) => toolLevels.get(name) ?? null,
  });
  const actor = makeActor({
    L: (window as any).__live2dAgent,
    t,
    post: (p, b) => postJson(API + p, b),
    speakAsCharacter,
  });

  const workdir = document.getElementById("as-workdir") as HTMLInputElement | null;
  const input = document.getElementById("as-input") as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById("btn-as-send") as HTMLButtonElement | null;
  // Composer menyebut nama karakter aktif ("Tanya Lumine…") — identitas
  // berasal dari sb-header, bukan nama hardcode model tertentu.
  if (input) {
    const agentName = document.querySelector(".sb-name")?.textContent?.trim() || t("as.agentName");
    input.placeholder = t("as.inputPhName", { name: agentName });
  }
  const stopBtn = document.getElementById("as-stop") as HTMLButtonElement | null;
  const cancelBtn = document.getElementById("as-cancel") as HTMLButtonElement | null;
  const resetBtn = document.getElementById("as-reset") as HTMLButtonElement | null;
  const memBtn = document.getElementById("as-memory") as HTMLButtonElement | null;

  let destroy = false;
  let statusIv: ReturnType<typeof setInterval> | null = null;
  let busIv: ReturnType<typeof setInterval> | null = null;
  let lastSeq = 0;
  let prevBusy = false;
  let liveAsk: { abort: AbortController; receivedAnyEvent: boolean } | null = null;
  let localApprovals = new Set<string>(); // apId yang panel ini yang menyelesaikan

  // ── Util kecil ──────────────────────────────────────────────────
  let currentPlan: any[] = [];
  const render = () => {
    view.renderTask(transcript.currentTask(), currentPlan);
    view.render(transcript.blocks);
  };

  function drawPages(tab: TechnicalTab): void {
    if (tab === "review") {
      view.renderReview(registry.list(), {
        canRevert: true,
        onRevert: (path: string) => { void revertByPath(path); },
        onRefresh: () => { refreshStatus(); drawPages("review"); },
      });
    } else if (tab === "term") {
      view.renderTerm(termLog.list());
    } else if (!destroyBrowserPanel) {
      destroyBrowserPanel = (window as any).__browserPanel?.start?.() ?? null;
    }
  }

  /** Revert file ke kondisi sebelum mutasi agent (via /api/assistant/revert). */
  async function revertByPath(path: string): Promise<void> {
    try {
      const entries: Array<{ id: string; path: string; reverted: boolean }> =
        await fetch(API + "/api/assistant/undo").then((r) => r.json()).then((d) => d.entries || []);
      const rec = entries.find((e) => e.path === path && !e.reverted);
      if (!rec) {
        transcript.status(t("as.review.revertNone", { path }), "warn");
        render();
        return;
      }
      const d = await postJson(API + "/api/assistant/revert", { id: rec.id });
      transcript.status(d.message || t("as.review.revertDone", { path }), "ok");
    } catch (e: any) {
      transcript.status("✗ " + (e?.message || e), "err");
    }
    render();
    refreshStatus();
    drawPages(view.activeTab());
  }

  async function fetchStatus(): Promise<StatusResp> {
    return fetch(API + "/api/assistant/status").then((r) => r.json());
  }

  async function syncHistory(): Promise<void> {
    try {
      const hist = await fetch(API + "/api/assistant/history").then((r) => r.json());
      transcript.syncFromHistory(hist);
      render();
    } catch {}
  }

  /** Cancel aktif saat ada tugas berjalan (stream kita / klien lain). */
  function setCancelEnabled(on: boolean): void {
    if (cancelBtn) cancelBtn.disabled = !on;
  }

  function setInputEnabled(on: boolean): void {
    if (input) input.disabled = !on;
    if (sendBtn) sendBtn.disabled = !on;
    setCancelEnabled(on || !!liveAsk);
  }

  // ── Stream: ask & approve (protokol dua-kasus) ──────────────────
  function handleSse(ev: AsSseEvent): void {
    if (ev.type === "speak") {
      speakAsCharacter(ev.text);
    }
    // Registry perubahan file + log terminal (tab Review/Terminal)
    if (ev.type === "tool_call") {
      if (ev.name === "run_command") {
        termLog.start(typeof ev.args?.command === "string" ? ev.args.command : "");
      } else {
        registry.record(ev.name, ev.args);
      }
    } else if (ev.type === "tool_result") {
      if (ev.name === "run_command") {
        termLog.end(ev.text);
      } else if (/^ERROR/.test(ev.text)) {
        // path diambil dari kartu tool terakhir di transcript
        const cards = transcript.blocks.filter((b) => b.kind === "tool" && b.name === ev.name);
        const last = cards[cards.length - 1] as Extract<Block, { kind: "tool" }> | undefined;
        const path = last?.args && typeof last.args === "object" ? (last.args as any).path : null;
        registry.fail(ev.name, path ? { path } : null);
      }
    }
    transcript.applySse(ev);
    render();
    drawPages(view.activeTab());
  }

  function finishLive(): void {
    liveAsk = null;
    transcript.endLive();
    render();
    setInputEnabled(true);
    refreshStatus();
    syncHistory();
  }

  async function runStream(
    path: string,
    body: Record<string, unknown>,
    fallback: { path: string; body: Record<string, unknown> },
  ): Promise<void> {
    const ac = new AbortController();
    liveAsk = { abort: ac, receivedAnyEvent: false };
    setInputEnabled(false);
    transcript.beginLive();
    render();
    try {
      const r = await fetch(API + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      await readSseStream(r, (ev) => {
        if (liveAsk) liveAsk.receivedAnyEvent = true;
        handleSse(ev);
      }, ac.signal);
      finishLive();
    } catch (e) {
      const receivedAny = !!liveAsk?.receivedAnyEvent;
      const aborted = ac.signal.aborted;
      if (aborted) { finishLive(); return; }
      if (receivedAny) {
        // Kasus B: loop server pasti masih jalan — jangan kirim ulang.
        transcript.status(t("as.stream.dropped"), "warn");
        render();
        finishLive();
        return;
      }
      // Kasus A: belum ada event — cek status FRESH sebelum memutuskan.
      let busyNow = false;
      try { busyNow = !!(await fetchStatus()).busy; } catch {}
      if (decideFallback({ receivedAnyEvent: false, busyNow }) === "resend") {
        try {
          const d = await postJson(API + fallback.path, fallback.body);
          if (d.reply) {
            transcript.appendFinal(d.reply);
            if (d.speak) speakAsCharacter(d.speak);
          }
        } catch (e2: any) {
          transcript.status("✗ " + (e2?.message || e2), "err");
        }
      } else {
        transcript.status(t("as.stream.dropped"), "warn");
      }
      render();
      finishLive();
    }
  }

  // ── Aksi panel ──────────────────────────────────────────────────
  function send(text: string): void {
    const txt = String(text || "").trim();
    if (!txt || liveAsk) return;
    transcript.appendUser(txt);
    render();
    runStream("/api/assistant/ask-stream", { text: txt }, { path: "/api/assistant/ask", body: { text: txt } });
  }

  function approve(apId: string, ok: boolean): void {
    if (liveAsk) return;
    localApprovals.add(apId);
    // Metamorfosis: kartu izin hilang; kartu tool (dari tool_call SSE /
    // hydrate "MENUNGGU PERSETUJUAN") tetap "menjalankan…" sampai
    // tool_result dari approve-stream mengisinya. Tanpa bubble user baru.
    transcript.resolveApprovalVisual(apId, false);
    render();
    runStream("/api/assistant/approve-stream", { id: apId, approve: ok }, { path: "/api/assistant/approve", body: { id: apId, approve: ok } });
  }

  async function toggleMemory(): Promise<void> {
    const hidden = rootEl.querySelector(".as-membox")?.classList.contains("hidden");
    if (!hidden) { view.hideMemory(); return; }
    try {
      const d = await fetch(API + "/api/assistant/memory").then((r) => r.json());
      view.renderMemory(d.entries || [], async (key) => {
        try { await postJson(API + "/api/assistant/memory/forget", { key }); } catch {}
        toggleMemory();
        toggleMemory();
      });
    } catch {}
  }

  async function stopAgent(): Promise<void> {
    try { await postJson(API + "/api/assistant/stop", {}); } catch {}
    liveAsk?.abort.abort();
    transcript.status(t("as.stopped"), "warn");
    render();
  }

  /** Cancel tugas berjalan (runtime tetap hidup). Bila tugas milik panel ini,
   *  SSE di-abort — protokol Kasus B (decideFallback) mencegah resend. */
  async function cancelTask(): Promise<void> {
    let accepted = false;
    try {
      const d = await postJson(API + "/api/assistant/cancel", {});
      accepted = !!d.accepted;
    } catch {}
    liveAsk?.abort.abort();
    transcript.status(accepted ? t("as.cancelSent") : t("as.cancelNone"), "warn");
    render();
    setCancelEnabled(false);
    refreshStatus();
  }

  async function resetAgent(): Promise<void> {
    try { await postJson(API + "/api/assistant/reset", {}); } catch {}
    transcript = new Transcript();
    registry.clear();
    termLog.clear();
    view.clearTranscript();
    await syncHistory();
    transcript.status(t("as.resetDone"), "ok");
    render();
    drawPages(view.activeTab());
  }

  // ── Polling status (sumber kebenaran approval/plan/busy) ────────
  async function refreshStatus(): Promise<void> {
    if (destroy) return;
    let st: StatusResp;
    try {
      st = await fetchStatus();
    } catch {
      return;
    }
    // Pill: live kita > sibuk klien lain > nunggu izin > idle/mati.
    // Saat loop pause untuk approval rt.busy=false — pendingApprovals yang
    // jadi sumber state "approval" (jangan sampai pill keliru "siap").
    const waitApproval = !liveAsk && (st.pendingApprovals?.length || 0) > 0;
    view.setPill(
      !st.running ? "off"
        : waitApproval ? "approval"
        : liveAsk ? "busy"
        : st.busy ? "busyOther"
        : "idle",
    );
    // Tombol cancel: aktif saat ada tugas berjalan di runtime (kita/CLI),
    // mati saat idle — tanpa runtime tak ada yang bisa dibatalkan.
    setCancelEnabled(!!st.running && (st.busy || !!liveAsk));
    // Kartu TASK (pusat perhatian): tugas berjalan + checklist plan live.
    currentPlan = st.plan || [];
    view.renderTask(transcript.currentTask(), currentPlan);
    // Metadata level tool (badge auto/izin) — refresh map bila dikirim.
    if (Array.isArray(st.tools) && st.tools.length) {
      toolLevels.clear();
      for (const tl of st.tools) toolLevels.set(tl.name, tl.level);
    }
    // Tab Review: gabung filesTouched server (sesi CLI) + terukur client
    registry.mergeTouched(st.notes?.filesTouched || []);
    drawPages(view.activeTab());
    // Rekonsiliasi approval: kartu hilang hanya lewat sini / resolve lokal.
    const pendingIds = (st.pendingApprovals || []).map((a) => a.id);
    const current = transcript.blocks
      .filter((b: Block): b is Extract<Block, { kind: "approval" }> => b.kind === "approval")
      .map((b) => b.apId);
    for (const apId of current) {
      if (pendingIds.includes(apId)) continue;
      if (localApprovals.has(apId)) continue; // panel ini — jalur SSE menangani
      // Diselesaikan klien lain (CLI) → kartu jadi ringkas "klien lain"
      // bila agent masih bekerja; bila tidak, cukup dibuang.
      transcript.resolveApprovalVisual(apId, !!st.busy);
    }
    localApprovals = new Set([...localApprovals].filter((id) => pendingIds.includes(id)));
    transcript.reconcileApprovals(pendingIds);
    render();
    // Transisi busy→false: tarik history (jawaban final dari sesi CLI/drop).
    if (prevBusy && !st.busy && !liveAsk) await syncHistory();
    prevBusy = !!st.busy;
    // Cermin workdir dari server (bila input sedang tidak diedit)
    if (st.workDir && workdir && document.activeElement !== workdir) {
      workdir.value = st.workDir;
    }
  }

  // ── Polling bus (actor + transcript mode follow) ────────────────
  async function pollBus(): Promise<void> {
    if (destroy) return;
    let d: { latest?: number; busy?: boolean; events?: any[] };
    try {
      d = await fetch(API + "/api/assistant/events?since=" + lastSeq).then((r) => r.json());
    } catch {
      return;
    }
    lastSeq = d.latest || lastSeq;
    let touched = false;
    for (const ev of d.events || []) {
      actor.onActivity(ev); // akting selalu (semua mode)
      const signals = transcript.applyBus(ev);
      touched = true;
      if (signals.includes("refresh-status")) refreshStatus();
    }
    if (touched) render();
  }

  // ── Wiring elemen statis (index.html) ───────────────────────────
  const onSend = () => send(input?.value || "");
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input?.value || "");
    }
  };
  const onInputGrow = () => {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  };
  const onStop = () => { stopAgent(); };
  const onCancel = () => { void cancelTask(); };
  const onReset = () => { if (confirm(t("as.resetTip"))) resetAgent(); };
  const onMem = () => { toggleMemory(); };
  // Quick actions: teks chip (sudah diterjemahkan i18n) dikirim apa adanya
  // sebagai prompt — satu sumber teks, tanpa duplikasi prompt di JS.
  const onQuick = (e: Event) => {
    const chip = (e.target as HTMLElement).closest(".as-quick-chip") as HTMLElement | null;
    if (!chip || !input) return;
    const text = chip.textContent || "";
    input.value = text;
    send(text);
  };
  // Rail projek memindahkan sesi (switch/new/delete) → hydrate ulang
  // transcript & status ke sesi yang baru (runtime server sama, tak dimatikan).
  const onSessionChanged = () => {
    if (liveAsk) return; // sedang streaming — poll status menyusul sendiri
    transcript = new Transcript();
    registry.clear();
    termLog.clear();
    view.clearTranscript();
    void (async () => {
      await syncHistory();
      transcript.status(t("as.sess.loaded"), "ok");
      render();
      refreshStatus();
    })();
  };

  sendBtn?.addEventListener("click", onSend);
  input?.addEventListener("keydown", onKey);
  input?.addEventListener("input", onInputGrow);
  stopBtn?.addEventListener("click", onStop);
  cancelBtn?.addEventListener("click", onCancel);
  resetBtn?.addEventListener("click", onReset);
  memBtn?.addEventListener("click", onMem);
  document.getElementById("as-quick")?.addEventListener("click", onQuick);
  window.addEventListener("agent:session-changed", onSessionChanged);

  // ── Boot ────────────────────────────────────────────────────────
  (async () => {
    let persona = "";
    try {
      const prof = await (window as any).__live2dAgent?.getCapabilityProfile?.();
      persona = String(prof?.userNote || "").slice(0, 800);
    } catch {}
    try {
      await postJson(API + "/api/assistant/start", {
        workDir: workdir?.value || undefined,
        persona,
      });
      actor.setPersona(persona);
      await syncHistory();
      transcript.status(t("as.activeDefault"), "ok");
      render();
    } catch (e: any) {
      transcript.status(t("as.startFail", { msg: e?.message || e }), "err");
      render();
    }
    // Baseline bus: TIDAK di-replay — mulai dari seq terkini.
    try {
      const d = await fetch(API + "/api/assistant/events?since=0").then((r) => r.json());
      lastSeq = d.latest || 0;
    } catch {}
    statusIv = setInterval(refreshStatus, 2000);
    busIv = setInterval(pollBus, 1500);
    refreshStatus();
  })();

  // ── Destroy: lepas UI saja (runtime tetap hidup) ────────────────
  return function destroyPanel() {
    destroy = true;
    actor.stop();
    liveAsk?.abort.abort();
    if (statusIv) clearInterval(statusIv);
    if (busIv) clearInterval(busIv);
    sendBtn?.removeEventListener("click", onSend);
    input?.removeEventListener("keydown", onKey);
    input?.removeEventListener("input", onInputGrow);
    stopBtn?.removeEventListener("click", onStop);
    cancelBtn?.removeEventListener("click", onCancel);
    resetBtn?.removeEventListener("click", onReset);
    memBtn?.removeEventListener("click", onMem);
    document.getElementById("as-quick")?.removeEventListener("click", onQuick);
    window.removeEventListener("agent:session-changed", onSessionChanged);
    destroyBrowserPanel?.();
    rootEl.textContent = "";
    if (techRootEl) techRootEl.textContent = "";
  };
}
