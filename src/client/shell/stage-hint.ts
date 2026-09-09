/**
 * client/shell/stage-hint.ts — Hint panggung ("Drag · Scroll: zoom · …")
 * memudar permanen begitu user benar-benar berinteraksi dengan panggung.
 *
 * Mengapa: hint adalah bantuan onboarding; setelah interaksi pertama ia hanya
 * jadi noise permanen di atas canvas WebGL (dan menutupi sudut panggung).
 * Interaksi dihitung dari pointer event nyata di #stage (drag/zoom/wheel),
 * bukan hover. Sekali memudar → tetap (state UI sesi, tidak dipersist).
 * Elemen #hint milik legacy app.js — modul ini hanya menambah kelas "faded".
 */

const INTERACT_EVENTS = [
  "pointerdown",
  "wheel",
] as const;

export function startStageHintFade(): void {
  if (typeof window === "undefined") return;
  const stage = document.getElementById("stage");
  const hint = document.getElementById("hint");
  if (!stage || !hint || hint.classList.contains("faded")) return;

  const fade = () => {
    hint.classList.add("faded");
    for (const ev of INTERACT_EVENTS) {
      stage.removeEventListener(ev, fade);
    }
  };
  for (const ev of INTERACT_EVENTS) {
    stage.addEventListener(ev, fade, { passive: true });
  }
}
