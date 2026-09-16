/**
 * speech/channel.ts — S1 SpeechChannel: kepemilikan UCAPAN bersama jendela utama.
 *
 * Ini infrastruktur, BUKAN kebijakan produk. Tiga sumbu kepemilikan yang
 * sengaja terpisah (Behavior Contract §7):
 *   - Request ownership  → Phase 16 (_reqCtrl/_reqGen) — TIDAK disentuh.
 *   - Chain ownership    → Phase 18 (_chainOwner di AgentBrain) — TIDAK disentuh;
 *     ia mengatur SEKUENS segmen brain.
 *   - Speech channel     → file ini. Satu-satunya pemegang ACCESS ke output
 *     bicara jendela utama (engine speak). Produsen: brain chain, VTuber
 *     responder, Harness actor, jalur direct app.
 *
 * Kontrak inti:
 *   INV-1 hanya satu owner aktif.
 *   INV-2 opaque token; stale token tidak bisa melepas owner aktif.
 *   INV-3 takeover = onLost lama dikirim SEBELUM new owner aktif, lalu
 *         enforcer (app.js stopSpeechNow) menghentikan audio yang sedang
 *         jalan — baru pemilik baru boleh bicara.
 *   INV-4 completion dibedakan dari loss: pemanggil speak wrapper menerima
 *         outcome "completed" | "lost" (dihitung dari kepemilikan, bukan
 *         dari onend browser — onend setelah cancel TIDAK boleh menyamar
 *         jadi completion).
 *   INV-5 release idempoten; release token basi = no-op false.
 *   INV-7 reset() dipanggil saat teardown model — ownership tidak boleh
 *         selamat lintas model.
 *
 * Priority: numerik MINIMAL, default 0; takeover selalu diizinkan selama
 * priority baru >= pemilik saat ini (persis perilaku fisik engine hari ini:
 * ucapan baru membatalkan ucapan lama — yang berubah hanyalah sekarang
 * kejadian itu TERLIHAT oleh korban sebagai `lost`, bukan completion).
 * Claim ditolak (null) hanya bila pemilik saat ini priority-nya LEBIH
 * TINGGI — mekanisme siap-pakai untuk S2/S3 (queue/park), TANPA menanam
 * kebijakan mode apa pun di sini.
 */

export type SpeechOutcome = "completed" | "lost";

export interface SpeechToken {
  readonly id: number;
  readonly producer: string;
  readonly priority: number;
}

export interface SpeechClaimOpts {
  priority?: number;
  onLost?: (tookOverBy: string | null) => void;
}

export interface SpeechChannel {
  /** Ambil kepemilikan. null = DITOLAK (pemilik saat ini priority lebih tinggi). */
  claim(producerId: string, opts?: SpeechClaimOpts): SpeechToken | null;
  /** true hanya bila token adalah pemilik saat ini. Selalu aman dipanggil dua kali. */
  release(token: SpeechToken | null | undefined): boolean;
  isOwner(token: SpeechToken | null | undefined): boolean;
  /** Outcome untuk callback speak: apakah token ini MASIH pemilik saat ucapan selesai. */
  outcome(token: SpeechToken | null | undefined): SpeechOutcome;
  /** Snapshot READ-ONLY pemilik aktif (tanpa token). */
  current(): { producer: string; priority: number } | null;
  /** app.js memasang stopSpeechNow di sini — dipanggil saat takeover & reset. */
  setEnforcer(fn: (() => void) | null): void;
  /** Teardown model: pemilik lama di-`lost`, channel bersih. */
  reset(reason?: string): void;
  version(): string;
}

export function createSpeechChannel(): SpeechChannel {
  interface Slot {
    token: SpeechToken;
    onLost?: (t: string | null) => void;
  }
  let owner: Slot | null = null;
  let seq = 0;
  let enforcer: (() => void) | null = null;

  const runEnforcer = () => {
    if (!enforcer) return;
    try {
      enforcer();
    } catch (e) {
      /* enforcer tidak boleh menjatuhkan alih kepemilikan */
    }
  };

  const dropOwner = (tookOverBy: string | null) => {
    const cur = owner;
    owner = null; // kosongkan DULU — onLost re-entrant (klaim lagi) tidak dobel-fire
    if (cur && cur.onLost) {
      try {
        cur.onLost(tookOverBy);
      } catch (e) {
        /* korban rusak tidak boleh menghentikan takeover */
      }
    }
  };

  const isOwner = (token: SpeechToken | null | undefined): boolean =>
    !!token && !!owner && owner.token.id === token.id;

  const ch: SpeechChannel = {
    claim(producerId, opts = {}) {
      const priority = Number.isFinite(Number(opts.priority))
        ? Number(opts.priority)
        : 0;
      if (owner && priority < owner.token.priority) return null; // ditolak
      const hadOwner = !!owner;
      if (hadOwner) dropOwner(String(producerId)); // INV-3: lama dapat `lost`
      const token: SpeechToken = {
        id: ++seq,
        producer: String(producerId || "unknown"),
        priority,
      };
      owner = { token, onLost: opts.onLost };
      // Enforcer HANYA saat ada pemilik lama yang digusur — klaim atas kanal
      // bebas tidak boleh membatalkan audio apa pun (bukan peristiwa takeover).
      if (hadOwner) runEnforcer();
      return token;
    },
    release(token) {
      if (!isOwner(token)) return false; // stale/ganda → no-op (INV-5)
      owner = null;
      return true;
    },
    isOwner,
    outcome(token) {
      return isOwner(token) ? "completed" : "lost";
    },
    current() {
      return owner
        ? { producer: owner.token.producer, priority: owner.token.priority }
        : null;
    },
    setEnforcer(fn) {
      enforcer = typeof fn === "function" ? fn : null;
    },
    reset() {
      dropOwner(null);
      runEnforcer(); // INV-7: audio lintas-model ikut berhenti
    },
    version() {
      return "1.0.0-speech-channel";
    },
  };
  return ch;
}
