/**
 * client/agent/panel/actor.ts — Direktur akting karakter (port dari
 * mode-runtime.js saat remake panel agent).
 *
 * "Otak akting" sisi klien: memetakan event aktivitas agent ke gaze,
 * ekspresi, dan komentar. Semua reaksi diberi cooldown agar karakter tidak
 * "kebablasan". Komentar bertingkat: kalimat acuan instan (fallback, gratis)
 * → LLM persona via /api/assistant/quip (role "chat").
 *
 * Mapping diperluas saat remake (per-event, bukan generik):
 *   - verification_result gagal → error + komentar; lolos → "done" ringan
 *     TANPA komentar (jangan mengganggu saat kerjaan lancar).
 *   - subagent_completed → "done" tanpa komentar; spawned → "tool" + komentar.
 *   - plan_revised → gaze "think" + komentar fallback as.actor.revised.
 *   - permission_resolved disetujui → "done" (lega); ditolak → TANPA reaksi
 *     (jangan terasa "menghukum" user yang menolak).
 * Semua dependensi di-inject (L, t, post, now) supaya bisa di-stub di test.
 */

export type ActorEvent = { type: string; label?: string };

export type ActorDeps = {
  /** Karakter Live2D (window.__live2dAgent) — boleh absen. */
  L?: any;
  /** Terjemah string runtime. */
  t?: (key: string, vars?: Record<string, string | number>) => string;
  /** POST JSON ke server (dipakai /api/assistant/quip). */
  post?: (path: string, body: any) => Promise<any>;
  /** Suarakan teks sebagai karakter (bubble + TTS). */
  speakAsCharacter?: (text: string) => void;
  /** Jam untuk cooldown — di-inject agar test deterministik. */
  now?: () => number;
  fallbacks?: { think?: string; tool?: string; done?: string; error?: string; revised?: string };
};

const QUIP_COOLDOWN = 25000;   // komentar LLM maks ~1 per 25 dtk
const MOTION_COOLDOWN = 2500;  // gerakan reaksi maks 1 per 2,5 dtk

export function makeActor(deps: ActorDeps = {}) {
  const L = deps.L;
  const t = deps.t || ((k: string) => k);
  const post = deps.post || (() => Promise.resolve({}));
  const speak = deps.speakAsCharacter || (() => {});
  const now = deps.now || (() => Date.now());
  const fb = deps.fallbacks || {};

  let lastQuip = 0;
  let lastMotion = 0;
  let fillerTimer: ReturnType<typeof setTimeout> | null = null;
  let actorPersona = "";

  const clearFiller = () => {
    if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
  };

  /** Gerakan/ekspresi reaksi — rate-limited supaya tidak saling menimpa. */
  function react(kind: "tool" | "done" | "error" | "approval" | "think"): void {
    if (!L || now() - lastMotion < MOTION_COOLDOWN) return;
    lastMotion = now();
    try {
      if (kind === "tool") {
        L.setGazeIntent?.("glance", { hold: 1600 });
        L.expressEmotion?.("bingung");
      } else if (kind === "done") {
        L.setGazeIntent?.("up", { hold: 1200 });
        L.expressEmotion?.("senang");
      } else if (kind === "error") {
        L.setGazeIntent?.("lookaway-down", { hold: 2000 });
        L.expressEmotion?.("kesal");
      } else if (kind === "approval") {
        L.setGazeIntent?.("face-user", { hold: 2500 });
        L.expressEmotion?.("kaget");
      } else if (kind === "think") {
        L.setGazeIntent?.("think", { hold: 6000 });
      }
    } catch { /* engine belum siap — akting boleh gagal senyap */ }
  }

  /** Komentar: fallback instan, lalu coba LLM persona (hasilnya menimpa). */
  function comment(fallbackKey: string, prompt: string, allowLLM: boolean): void {
    speak(t(fallbackKey));
    if (!allowLLM || now() - lastQuip < QUIP_COOLDOWN) return;
    lastQuip = now();
    post("/api/assistant/quip", { persona: actorPersona, event: prompt })
      .then((d) => { if (d?.quip) speak(d.quip); })
      .catch(() => {});
  }

  return {
    /** Persona di-set tiap start panel (dari sheet userNote). */
    setPersona(p: string): void {
      actorPersona = String(p || "").slice(0, 800);
    },

    onActivity(ev: ActorEvent): void {
      if (!ev) return;
      clearFiller();
      // Nama event kanonik dari server/agent/bus.ts
      switch (ev.type) {
        case "thinking_start":
          // Mulai mikir: tatap jauh (pose mikir), komentar pengisi.
          react("think");
          comment(fb.think || "as.actor.think",
            "agent mulai memikirkan dan merencanakan langkah kerjanya", true);
          // Filler: kalau lama tak ada kabar, karakter bersuara sekali.
          fillerTimer = setTimeout(() => {
            speak(t(fb.tool || "as.actor.tool"));
          }, 18000);
          break;
        case "tool_call_start":
        case "tool_call_end":
          react("tool");
          if (ev.type === "tool_call_start") {
            comment(fb.tool || "as.actor.tool",
              "agent sedang memeriksa berkas dan isi folder kerja", false);
          }
          break;
        case "permission_request":
          react("approval");
          comment(fb.think || "as.actor.think",
            "agent butuh izin user untuk melanjutkan aksinya", false);
          break;
        case "permission_resolved": {
          // Disetujui → lega; ditolak → diam (jangan menghukum user).
          if (/^disetujui/i.test(ev.label || "")) react("done");
          break;
        }
        case "speak":
          // Komentar persona (dibuat server lewat role "chat") — teks utama
          // yang diucapkan; jangan ditimpa fallback.
          react("done");
          speak(ev.label || t(fb.done || "as.actor.done"));
          break;
        case "final_answer":
          // Jawaban final: versi persona sudah datang lewat "speak".
          react("done");
          if (!ev.label || !/^⏳/.test(ev.label)) {
            comment(fb.done || "as.actor.done",
              "agent baru saja menyelesaikan tugasnya", false);
          }
          break;
        case "error":
          react("error");
          comment(fb.error || "as.actor.error",
            "agent mengalami kendala saat bekerja", true);
          break;
        case "verification_result":
          // Gagal → prihatin + komentar; lolos → reaksi ringan tanpa komentar.
          if (/^gagal/i.test(ev.label || "")) {
            react("error");
            comment(fb.error || "as.actor.error",
              "agent menemukan masalah saat memverifikasi hasil kerjanya", false);
          } else {
            react("done");
          }
          break;
        case "plan_revised":
          // Rencana berubah di tengah jalan — karakter ikut berpikir ulang.
          react("think");
          comment(fb.revised || "as.actor.revised",
            "agent menyesuaikan rencana kerjanya", false);
          break;
        case "subagent_spawned":
          // Ada pekerjaan paralel — karakter menonton dengan penasaran.
          react("tool");
          comment(fb.tool || "as.actor.tool",
            "agent mengerjakan beberapa sub-task sekaligus lewat subagent", false);
          break;
        case "subagent_completed":
          // Satu subtask tuntas — reaksi ringan, tanpa komentar.
          react("done");
          break;
      }
    },

    stop(): void {
      clearFiller();
    },
  };
}

export type Actor = ReturnType<typeof makeActor>;
