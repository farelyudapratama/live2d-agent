/**
 * server/persona/speech-lang.ts — Terjemahan teks-bicara per bahasa suara.
 *
 * Kasus: user menyetel "Bahasa suara" tetap (mis. ja-JP) sementara balasan
 * karakter tetap dalam bahasa user (aturan cermin-bahasa). Supaya suara yang
 * dibacakan natural, teks diterjemahkan dulu ke bahasa suara SEBELUM masuk
 * TTS — teks di bubble/log tetap bahasa user.
 *
 * LLM-nya role "chat" (bisa model murah, beda dari otak kerja). Hasil
 * di-cache LRU in-memory ber-key bahasa supaya kalimat yang sama (quick
 * phrase, sapaan berulang) tidak memicu panggilan ulang. Fungsi menerima
 * `call` ter-inject supaya bisa di-unit-test tanpa jaringan.
 */

const CACHE_MAX = 200;

const cache = new Map<string, string>();
function cachePut(store: Map<string, string>, key: string, val: string): void {
  if (store.has(key)) store.delete(key);
  store.set(key, val);
  if (store.size > CACHE_MAX)
    store.delete(store.keys().next().value as string);
}

/** Kode bahasa BCP-47 → nama bahasa untuk prompt (cukup yang di UI). */
const LANG_NAMES: Record<string, string> = {
  id: "Indonesian (Bahasa Indonesia)",
  ja: "Japanese",
  en: "English",
  zh: "Mandarin Chinese",
  ko: "Korean",
};

export function speechLangOf(ttsLang: string): string {
  return String(ttsLang || "").split("-")[0].toLowerCase();
}

/** true bila bahasa suara adalah bahasa TETAP (bukan "auto"/kosong). */
export function ttsLangIsFixed(ttsLang: string | undefined): boolean {
  return /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/.test(String(ttsLang || ""));
}

/**
 * Deteksi bahasa teks (heuristic skrip, tanpa jaringan) — dipakai server untuk
 * melewati terjemahan bila teks SUDAH dalam bahasa target (mis. user menulis
 * Jepang padahal suara ja-JP). Cermin dari detectTextLang() di app.js; jangan
 * saling menipu — keduanya harus keputusan yang sama untuk teks yang sama.
 */
export function detectSpeechLangBase(text: string): string {
  const t = String(text || "");
  if (/[\u3040-\u30ff]/.test(t)) return "ja"; // kana selalu Jepang
  if (/[\u4e00-\u9fff]/.test(t)) return "zh"; // hanzi (tanpa kana) → Mandarin
  if (/[\uac00-\ud7af]/.test(t)) return "ko";
  if (/[a-z]/i.test(t)) {
    const words = t.toLowerCase().match(/[a-z]+/g) || [];
    if (!words.length) return "en";
    const idWords =
      /^(yang|dan|di|ke|dari|untuk|dengan|ini|itu|aku|kamu|kita|saya|tidak|bisa|sudah|akan|ada|juga|tapi|kalau|gak|nggak|banget|ya|kok|dong|deh|sih)$/;
    const hits = words.filter((w) => idWords.test(w)).length;
    return hits / words.length >= 0.2 ? "id" : "en";
  }
  return "id";
}

/**
 * Terjemahkan satu baris bicara ke bahasa `ttsLang`. `call(text, sys)` =
 * panggilan LLM role "chat" (di-inject; produksi memakai llmForRole).
 * Teeks yang sudah berbahasa target TIDAK diterjemahkan (hemat panggilan
 * LLM dan menghilangkan sifat nondeterministik). Gagal = teks asli —
 * terjemahan adalah peningkatan, bukan jalur kritis.
 */
export async function translateForSpeech(
  text: string,
  ttsLang: string,
  call: (text: string, sys: string) => Promise<string>,
  store: Map<string, string> = cache,
): Promise<string> {
  const src = String(text || "").trim();
  const target = speechLangOf(ttsLang);
  if (!src || !target) return src;
  // Teks sudah berbahasa target → tidak ada yang diterjemahkan.
  if (detectSpeechLangBase(src) === target) return src;

  const key = target + "\u0000" + src;
  const hit = store.get(key);
  if (hit !== undefined) {
    // LRU touch — kunci terpakai pindah ke belakang.
    store.delete(key);
    store.set(key, hit);
    return hit;
  }

  const langName = LANG_NAMES[target] || String(ttsLang);
  const sys =
    "You adapt a spoken line for a text-to-speech voice. Translate the text into " +
    langName +
    " — natural, conversational, same tone and register, similar length. " +
    "Output ONLY the translated line: no quotes, no explanation, no romaji. " +
    "If it is already in " +
    langName +
    ", output it unchanged.";

  try {
    const reply = await call(src.slice(0, 2000), sys);
    const out = String(reply || "")
      .trim()
      .replace(/^["“”']+|["“”']+$/g, "")
      .trim();
    const val = out || src;
    cachePut(store, key, val);
    return val;
  } catch (e: any) {
    console.warn(
      "[speech-lang] terjemahan gagal (pakai teks asli):",
      e?.message || e,
    );
    return src;
  }
}
