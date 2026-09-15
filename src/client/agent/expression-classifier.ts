/**
 * expression-classifier.ts — P15.4: Conservative heuristic expression classifier.
 *
 * Mengklasifikasikan nama expression Live2D berdasarkan token nama saja.
 * TIDAK menggunakan parameter payload, file path, urutan, atau index.
 *
 * Aturan inti:
 *   - Token yang jelas (happy, sad, angry, dll) → klasifikasi CONFIDENT.
 *   - Nama opaque (exp_01, exp_02) → UNKNOWN.
 *   - Nama prop/karakter tanpa bukti emosi → UNKNOWN.
 *   - CJK hanya bila arti emosi tidak ambigu.
 *   - Confidence rendah → tetap UNKNOWN (lebih baik miss daripada salah).
 *
 * Output digunakan sebagai metadata informasional pada expression catalog
 * yang sudah ada — TIDAK mengganti selection, reorder, atau disable expression.
 */

/**
 * Hasil klasifikasi satu expression name.
 * `emotion` menggunakan kanonik proyek (Indonesia) bila cocok,
 * atau null bila tidak bisa diklasifikasi secara andal.
 */
export interface ExpressionClassification {
  /** Nama emosi kanonik (sesuai DEFAULT_EMOTIONS) atau null. */
  emotion: string | null;
  /** Confidence 0..1 — berapa yakin classifier terhadap klasifikasi. */
  confidence: number;
  /** Bukti teks singkat mengapa klasifikasi ini dipilih. */
  evidence: string;
}

/**
 * Peta token nama → emosi kanonik (Indonesia).
 * Hanya token yang SANGAT JELAS dan TIDAK AMBIGU masuk di sini.
 * Confidence ditentukan berdasarkan kejelasan token.
 *
 * Kanonik emosi proyek:
 *   senang, tersenyum, sedih, malu, kaget, kesal, bingung, normal
 *
 * Peta ini menggunakan emosi kanonik sebagai value agar LLM bisa
 * langsung menggunakan nama emosi yang dikenal.
 */
const TOKEN_TO_EMOTION: Record<string, { emotion: string; confidence: number }> = {
  // Happy / positive
  happy:   { emotion: "senang", confidence: 0.9 },
  joy:     { emotion: "senang", confidence: 0.85 },
  smile:   { emotion: "tersenyum", confidence: 0.85 },
  smiling: { emotion: "tersenyum", confidence: 0.85 },
  grinning:{ emotion: "senang", confidence: 0.8 },

  // Sad / negative
  sad:     { emotion: "sedih", confidence: 0.9 },
  tear:    { emotion: "sedih", confidence: 0.85 },
  cry:     { emotion: "sedih", confidence: 0.85 },
  crying:  { emotion: "sedih", confidence: 0.85 },
  sorrow:  { emotion: "sedih", confidence: 0.8 },

  // Angry
  angry:   { emotion: "kesal", confidence: 0.9 },
  rage:    { emotion: "kesal", confidence: 0.85 },
  mad:     { emotion: "kesal", confidence: 0.8 },
  fury:    { emotion: "kesal", confidence: 0.8 },
  anger:   { emotion: "kesal", confidence: 0.85 },

  // Surprised
  surprised: { emotion: "kaget", confidence: 0.9 },
  surprise:  { emotion: "kaget", confidence: 0.85 },
  shock:     { emotion: "kaget", confidence: 0.85 },
  shocked:   { emotion: "kaget", confidence: 0.85 },

  // Shy / embarrassed
  shy:     { emotion: "malu", confidence: 0.9 },
  blush:   { emotion: "malu", confidence: 0.85 },
  blushes: { emotion: "malu", confidence: 0.8 },
  blushing: { emotion: "malu", confidence: 0.8 },
  embarrassed: { emotion: "malu", confidence: 0.8 },

  // Confused
  confuse: { emotion: "bingung", confidence: 0.85 },
  confused:{ emotion: "bingung", confidence: 0.85 },
  wonder:  { emotion: "bingung", confidence: 0.7 },
  puzzled: { emotion: "bingung", confidence: 0.75 },
  dizzy:   { emotion: "bingung", confidence: 0.7 },

  // Neutral / normal
  neutral: { emotion: "normal", confidence: 0.9 },
  normal:  { emotion: "normal", confidence: 0.9 },
  default: { emotion: "normal", confidence: 0.85 },

  // CJK — hanya arti yang TIDAK AMBIGU
  怒:  { emotion: "kesal", confidence: 0.85 },  // marah
  笑:  { emotion: "senang", confidence: 0.75 }, // tertawa (bisa ambigu)
  泣:  { emotion: "sedih", confidence: 0.85 },  // menangis
  悲:  { emotion: "sedih", confidence: 0.8 },   // kesedihan
  驚:  { emotion: "kaget", confidence: 0.8 },   // kaget
  怕:  { emotion: "kaget", confidence: 0.7 },   // takut (bisa ambigu)
  呆:  { emotion: "bingung", confidence: 0.6 },  // terdiam (ambigu — confidence rendah → tetap dipakai sebagai hint lemah)
};

/**
 * Token yang harus di-EXCLUDE dari pencocokan.
 * Nama expression yang mengandung token ini harus dikembalikan UNKNOWN
 * meskipun mengandung token emosi (misal "unhappy" bukan "happy").
 */
const NEGATIVE_TOKENS = new Set([
  "unhappy", "unsad", "unangry", "dis", "mis", "anti",
]);

/**
 * Regex word boundary yang mendukung huruf, angka, dan CJK.
 * Untuk ASCII: \b (word boundary).
 * Untuk CJK: karakter CJK dianggap sebagai "kata" tersendiri.
 */
const TOKEN_BOUNDARY_RE = /[\s_\-\.\s]+|[a-zA-Z0-9]+|[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u3000-\u303f\uff00-\uffef]+/gu;

/**
 * Klasifikasi nama expression berdasarkan token nama saja.
 *
 * @param name — nama expression dari manifest model (misal "exp_angry", "exp_01", "呆猫")
 * @returns ExpressionClassification — emotion kanonik atau null
 *
 * DETERMINISTIC: input yang sama selalu menghasilkan output yang sama.
 * TANPA EFEK SAMPING: tidak mengubah state apapun.
 * TANPA DEPENDENSI: tidak memanggil API, tidak membaca file.
 */
export function classifyExpressionName(name: string): ExpressionClassification {
  if (!name || typeof name !== "string") {
    return { emotion: null, confidence: 0, evidence: "empty or invalid name" };
  }

  const normalized = name.toLowerCase().trim();
  if (!normalized) {
    return { emotion: null, confidence: 0, evidence: "empty name after normalization" };
  }

  // Ekstrak token dari nama (huruf+angka, atau karakter CJK per-kanji)
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = TOKEN_BOUNDARY_RE.exec(normalized)) !== null) {
    tokens.push(match[0]);
  }

  if (!tokens.length) {
    return { emotion: null, confidence: 0, evidence: "no extractable tokens" };
  }

  // Cek negative tokens — bila ada, langsung UNKNOWN
  for (const t of tokens) {
    if (NEGATIVE_TOKENS.has(t)) {
      return { emotion: null, confidence: 0, evidence: `negative token: ${t}` };
    }
  }

  // Cari token yang cocok dengan peta emosi
  for (const t of tokens) {
    const mapping = TOKEN_TO_EMOTION[t];
    if (mapping) {
      return {
        emotion: mapping.emotion,
        confidence: mapping.confidence,
        evidence: `name token: ${t}`,
      };
    }
  }

  return { emotion: null, confidence: 0, evidence: "no semantic token found" };
}

/**
 * Bentuk output yang di-attach ke expression catalog untuk LLM.
 * Format compact yang bisa langsung disuntikkan ke prompt.
 *
 * @param name — nama expression
 * @returns string compact: "exp_angry — emotion: senang" atau "exp_01" (tanpa metadata)
 */
export function expressionHint(name: string): string {
  const cls = classifyExpressionName(name);
  if (!cls.emotion) return name;
  return `${name} — emotion: ${cls.emotion}`;
}
