/**
 * server/persona/clean.ts — Util kecil pembersihan teks untuk ucapan.
 */

/** Rapikan teks markdown/output mentah jadi layak dibaca lisan. */
export function cleanForSpeech(t: string): string {
  return String(t || "")
    .replace(/```[a-z]*\n?/gi, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
