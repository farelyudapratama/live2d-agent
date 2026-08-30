/**
 * speech/lip-sync.ts — Lip-sync presisi dari audio (bukan osilasi timer).
 *
 * Selama ini mulut bergerak lewat `0.35 + 0.4·|sin(t·9)|` — ritme silabel palsu
 * yang sama untuk semua kalimat. Modul ini menggantinya di jalur remote TTS:
 * elemen <audio> di-route lewat Web Audio (MediaElementSource → Analyser), RMS
 * time-domain dibaca tiap frame, lalu dipetakan menjadi KETERBUKAAN mulut 0..1.
 * Pemetaan ke parameter model tetap tugas engine (role space, roleRange) —
 * modul ini tidak pernah menyentuh id parameter (aturan model-agnostic).
 *
 * Jalur browser SpeechSynthesis tidak punya stream audio → tetap osilasi.
 *
 * Keamanan autoplay: AudioContext yang masih `suspended` tidak memproses graph —
 * dan begitu elemen diroute lewat MediaElementSource, suaranya LEWAT graph.
 * attach() menolak routing kecuali context benar-benar `running`, jadi kondisi
 * yang gagal jatuh ke fallback osilasi dengan audio tetap terdengar normal.
 */

export interface MouthTargetOpts {
  /** RMS di bawah nilai ini dianggap senyap (mulut tertutup). */
  gate?: number;
  /** Faktor penguat: rms di atas gate dikalikan ini sebelum clamp. */
  gain?: number;
  /** Batas atas keterbukaan (0..1). */
  ceiling?: number;
}

export interface EnvelopeOpts {
  /** Konstanta waktu membuka (ms) — lebih cepat agar artikulasi tajam. */
  attackMs?: number;
  /** Konstanta waktu menutup (ms) — sedikit lebih lambat agar tidak bergetar. */
  decayMs?: number;
}

const DEFAULT_GATE = 0.012;
const DEFAULT_GAIN = 9;
const DEFAULT_ATTACK = 35;
const DEFAULT_DECAY = 110;

/** RMS deviation dari titik tengah (128) dalam skala 0..1. Hening → 0. */
export function rmsTimeDomain(bytes: Uint8Array | null | undefined): number {
  if (!bytes || !bytes.length) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const d = (bytes[i] - 128) / 128;
    sum += d * d;
  }
  return Math.sqrt(sum / bytes.length);
}

/** RMS → target keterbukaan mulut 0..1 (gate, gain, clamp). */
export function mouthTarget(rms: number, opts: MouthTargetOpts = {}): number {
  const gate = opts.gate ?? DEFAULT_GATE;
  const gain = opts.gain ?? DEFAULT_GAIN;
  const ceiling = opts.ceiling ?? 1;
  const v = Number.isFinite(rms) ? rms : 0;
  const t = (v - gate) * gain;
  if (!(t > 0)) return 0;
  return Math.min(ceiling, t);
}

/**
 * Penghalus asimetris: membuka cepat (attack), menutup lebih lambat (decay).
 * Berbasis dt sehingga hasilnya sama di 30/60/144 fps.
 */
export function envelope(
  current: number,
  target: number,
  dtMs: number,
  opts: EnvelopeOpts = {}
): number {
  const attack = opts.attackMs ?? DEFAULT_ATTACK;
  const decay = opts.decayMs ?? DEFAULT_DECAY;
  // Tidak ada waktu yang berlalu (dt=0) atau dt tidak masuk akal → tidak ada
  // gerak; JANGAN mengasumsikan durasi frame — sample() bisa dipanggil dua
  // kali dalam frame yang sama dan nilainya harus deterministik.
  if (!(Number.isFinite(dtMs) && dtMs > 0)) return current;
  const tau = target > current ? attack : decay;
  const k = 1 - Math.exp(-dtMs / tau);
  return current + (target - current) * k;
}

/**
 * Membungkus satu elemen <audio> dengan AnalyserNode dan menyediakan
 * sample() → keterbukaan mulut terhalus 0..1 per frame.
 */
export class AudioLipSync {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Uint8Array = new Uint8Array(1024);
  // Web Audio: MediaElementSource HANYA boleh dibuat sekali per elemen —
  // buat kedua kalinya melempar. Cache per elemen di sini.
  private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private cur = 0;
  private lastT = 0;
  /** false → pemanggil memakai fallback osilasi (audio tetap langsung ke speaker). */
  active = false;

  attach(el: HTMLMediaElement): boolean {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return false;
      if (!this.ctx) this.ctx = new AC() as AudioContext;
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      // Lihat catatan autoplay di header modul: suspended = jangan route.
      if (this.ctx.state !== 'running') {
        this.active = false;
        return false;
      }
      let src = this.sources.get(el);
      if (!src) {
        src = this.ctx.createMediaElementSource(el);
        this.sources.set(el, src);
      }
      if (!this.analyser) {
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.35;
        this.buf = new Uint8Array(this.analyser.fftSize);
      }
      try { src.disconnect(); } catch { /* belum pernah terhubung */ }
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.active = true;
      return true;
    } catch {
      this.active = false;
      return false;
    }
  }

  /** Baca frame analiser → keterbukaan terhalus 0..1. Aman dipanggil kapan pun. */
  sample(nowMs?: number): number {
    if (!this.active || !this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.buf as any);
    const target = mouthTarget(rmsTimeDomain(this.buf));
    const t = typeof nowMs === 'number' ? nowMs : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = this.lastT ? Math.max(0, t - this.lastT) : 16;
    this.lastT = t;
    this.cur = envelope(this.cur, target, dt);
    return this.cur;
  }

  /** Mulai baris bicara baru: mulut mulai dari tertutup. */
  reset(): void {
    this.cur = 0;
    this.lastT = 0;
  }
}
