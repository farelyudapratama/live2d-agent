/**
 * client/agent/panel/actor.ts — Direktur akting karakter (port dari
 * mode-runtime.js saat remake panel agent).
 *
 * "Otak akting" sisi klien: memetakan event aktivitas agent ke gaze,
 * ekspresi, dan komentar. Semua reaksi diberi cooldown agar karakter tidak
 * "kebablasan". Komentar: LLM persona DULU via /api/assistant/quip
 * (role "chat") dengan label event asli — template i18n (as.actor.*) hanya
 * jaring pengaman bila quip gagal/tak datang dalam batas waktu. Dalam masa
 * cooldown quip karakter DIAM, bukan mengucap kalimat kaleng.
 *
 * Mapping (per-event, bukan generik):
 *   - verification_result gagal → error + komentar; lolos → "done" ringan
 *     TANPA komentar (jangan mengganggu saat kerjaan lancar).
 *   - subagent_completed → "done" tanpa komentar; spawned → "tool" + komentar.
 *   - tool_call_start/end → "tool"; komentar hanya di start.
 *   - plan_revised → gaze "think" + komentar.
 *   - permission_resolved disetujui → "done" (lega); ditolak → TANPA reaksi
 *     (jangan terasa "menghukum" user yang menolak).
 * Semua dependensi di-inject (L, t, post, now, fallbackMs) supaya bisa
 * di-stub di test.
 */

export type ActorEvent = { type: string; label?: string };

export type ActorDeps = {
  /** Karakter Live2D (window.__live2dAgent) — boleh absen. */
  L?: any;
  /** Terjemah string runtime. */
  t?: (key: string, vars?: Record<string, string | number>) => string;
  /** POST JSON ke server (dipakai /api/assistant/quip). */
  post?: (path: string, body: any) => Promise<any>;
  /** Suara sebagai karakter (bubble + TTS). */
  speakAsCharacter?: (text: string) => void;
  /** Jam untuk cooldown — di-inject agar test deterministik. */
  now?: () => number;
  fallbacks?: { think?: string; tool?: string; done?: string; error?: string; revised?: string };
  /** Batas tunggu quip sebelum template fallback diucapkan — di-inject agar
   *  test tidak menunggu ribuan ms. Default QUIP_FALLBACK_MS. */
  fallbackMs?: number;
};

const QUIP_COOLDOWN = 15000;   // komentar LLM maks ~1 per 15 dtk
const MOTION_COOLDOWN = 2500;  // gerakan reaksi maks 1 per 2,5 dtk
/** Quip LLM dianggap gagal bila tak datang dalam batas ini → template baru
 *  diucapkan. Cukup pendek supaya jeda tidak terasa mati, cukup panjang
 *  untuk LLM role "chat" yang lazimnya jawab 1-3 dtk. */
const QUIP_FALLBACK_MS = 4500;

export function makeActor(deps: ActorDeps = {}) {
  const L = deps.L;
  const t = deps.t || ((k: string) => k);
  const post = deps.post || (() => Promise.resolve({}));
  const speak = deps.speakAsCharacter || (() => {});
  const now = deps.now || (() => Date.now());
  const fb = deps.fallbacks || {};
  const fbMs = deps.fallbackMs ?? QUIP_FALLBACK_MS;

  let lastQuip = 0;
  let lastMotion = 0;
  let fillerTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let actorPersona = "";

  const clearFiller = () => {
    if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
  };
  const clearFallback = () => {
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
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

  /**
   * Komentar berkarakter: LLM DULU, template cuma jaring pengaman.
   *
   * Dulu template diucapkan langsung lalu quip LLM menyusul — user selalu
   * mendengar kalimat kaleng ("Hmm, dia lagi periksa berkas…") sebelum versi
   * persona, dan mayoritas event bahkan tak pernah minta quip (allowLLM:
   * false) sehingga karakter cuma hafalan template. Sekarang:
   *   1. Dalam masa cooldown quip → DIAM (bukan template). Cooldown artinya
   *      "baru bicara", bukan izin mengucap kalimat kaleng.
   *   2. Di luar cooldown → minta quip dulu dengan label event asli; label
   *      inilah yang bikin komentar spesifik ("dia lagi baca package.json",
   *      bukan generik).
   *   3. Quip gagal/tak datang dalam QUIP_FALLBACK_MS → baru template
   *      fallback diucapkan. Quip datang → template dibatalkan.
   */
  function comment(fallbackKey: string, eventLabel: string, allowLLM: boolean): void {
    if (!allowLLM || now() - lastQuip < QUIP_COOLDOWN) return;
    lastQuip = now();
    const key = fallbackKey;
    clearFallback();
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      speak(t(key));
    }, fbMs);
    post("/api/assistant/quip", { persona: actorPersona, event: eventLabel })
      .then((d) => {
        if (d?.quip && fallbackTimer) {
          clearFallback();
          speak(d.quip);
        }
      })
      .catch(() => {
        // Quip gagal → template segera (bila timer belum menggugatkan) —
        // kalau sudah gugat, biarkan template yang bicara, jangan dobel.
        if (fallbackTimer) {
          clearFallback();
          speak(t(key));
        }
      });
  }

  return {
    /** Persona di-set tiap start panel (dari sheet userNote). */
    setPersona(p: string): void {
      actorPersona = String(p || "").slice(0, 800);
    },

    onActivity(ev: ActorEvent): void {
      if (!ev) return;
      clearFiller();
      // Label asli event — dikirim ke prompt quip supaya komentar mengacu
      // pada pekerjaan yang nyata, bukan kalimat generik.
      const label = (ev.label || "").slice(0, 160);
      // Nama event kanonik dari server/agent/bus.ts
      switch (ev.type) {
        case "thinking_start":
          // Mulai mikir: tatap jauh (pose mikir), komentar pengisi.
          react("think");
          comment(fb.think || "as.actor.think",
            label || "agent mulai memikirkan dan merencanakan langkah kerjanya", true);
          // Filler: kalau lama tak ada kabar, karakter bersuara sekali.
          fillerTimer = setTimeout(() => {
            speak(t(fb.tool || "as.actor.tool"));
          }, 18000);
          break;
        case "tool_call_start":
          react("tool");
          comment(fb.tool || "as.actor.tool",
            label || "agent sedang memeriksa berkas dan isi folder kerja", true);
          break;
        case "tool_call_end":
          // Tanpa komentar — hasil tool sudah tereport di transcript; cukup
          // reaksi pandang agar karakter tampak mengikuti.
          react("tool");
          break;
        case "permission_request":
          react("approval");
          comment(fb.think || "as.actor.think",
            label || "agent butuh izin user untuk melanjutkan aksinya", false);
          break;
        case "permission_resolved": {
          // Disetujui → lega; ditolak → diam (jangan menghukum user).
          if (/^disetujui/i.test(ev.label || "")) react("done");
          break;
        }
        case "speak":
          // Komentar persona (dibuat server lewat role "chat") — teks utama
          // yang diucapkan; jangan ditimpa fallback.
          clearFallback();
          react("done");
          speak(ev.label || t(fb.done || "as.actor.done"));
          break;
        case "final_answer":
          // Simpulan akhir: versi persona lewat "speak" sudah bicara dulu;
          // event ini memberi konteks ringkasnya ke quip bila speak tak datang.
          react("done");
          if (!ev.label || !/^⏳/.test(ev.label)) {
            comment(fb.done || "as.actor.done",
              label || "agent baru saja menyelesaikan tugasnya", true);
          }
          break;
        case "error":
          react("error");
          comment(fb.error || "as.actor.error",
            label || "agent mengalami kendala saat bekerja", true);
          break;
        case "verification_result":
          // Gagal → prihatin + komentar; lolos → reaksi ringan tanpa komentar.
          if (/^gagal/i.test(ev.label || "")) {
            react("error");
            comment(fb.error || "as.actor.error",
              label || "agent menemukan masalah saat memverifikasi hasil kerjanya", true);
          } else {
            react("done");
          }
          break;
        case "plan_revised":
          // Rencana berubah di tengah jalan — karakter ikut berpikir ulang.
          react("think");
          comment(fb.revised || "as.actor.revised",
            label || "agent menyesuaikan rencana kerjanya", true);
          break;
        case "subagent_spawned":
          // Ada pekerjaan paralel — karakter menonton dengan penasaran.
          react("tool");
          comment(fb.tool || "as.actor.tool",
            label || "agent mengerjakan beberapa sub-task sekaligus lewat subagent", true);
          break;
        case "subagent_completed":
          // Satu subtask tuntas — reaksi ringan, tanpa komentar.
          react("done");
          break;
      }
    },

    stop(): void {
      clearFiller();
      clearFallback();
    },
  };
}

export type Actor = ReturnType<typeof makeActor>;
