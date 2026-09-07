/**
 * server/persona/narrator.ts — Otak akting (TERPISAH dari agent loop).
 * Input: ringkasan event agent (BUKAN history penuh) + persona sheet.
 * Output: satu kalimat "speak" untuk diucapkan karakter (TTS/bubble) —
 * berkarakter, bukan bacain laporan teknis. LLM-nya role "chat" sehingga
 * bisa model murah/beda dari otak kerja (role "assistant").
 */
import { llmForRole } from "../../shared/llm-client";
import type { ConfigManager } from "../../shared/config";
import { cleanForSpeech } from "./clean";

export type NarratorInput = {
  /** Event terakhir agent, ringkas (dari bus.ts, bukan history). */
  event: string;
  /** Hasil kerja final agent (teks, sudah bersih dari directive). */
  result: string;
  /** Apakah hasil menandakan error. */
  isError: boolean;
  /** Persona karakter (userNote sheet, maks 800 char). */
  persona: string;
};

export type NarratorOutput = { speak?: string };

/** Teks pendek tidak perlu di-narasi ulang — hemat satu panggilan LLM. */
const SHORT_LIMIT = 240;

export async function narrate(
  input: NarratorInput,
  config: ConfigManager,
): Promise<NarratorOutput> {
  const text = cleanForSpeech(input.result);
  if (!text) return {};
  const lang = config.load().i18n?.lang === "en" ? "en" : "id";

  // Error → kalimat prihatin singkat via LLM persona (hasil kerja biasanya
  // pesan teknis yang tidak layak diucapkan mentah).
  const sys =
    (lang === "en"
      ? "You are the VOICE of a living character (desktop pet / VTuber) who has been WATCHING an AI agent work on the user's request. React to the result like a companion — a short natural spoken reaction (max 2 casual, friendly sentences). You may be pleased, impressed, teasing, or honest when it failed. NEVER recite technical details: no tool names, no file paths, no markdown, no lists — the user only HEARS this line."
      : "Kamu adalah SUARA karakter hidup (pet / VTuber) yang baru saja MELIHAT agent AI mengerjakan permintaan user. Bereaksilah seperti teman yang menemani — reaksi lisan singkat dan natural (maksimal 2 kalimat santai). Boleh senang, kagum, menggoda, atau jujur kalau gagal. JANGAN membacakan detail teknis: tanpa nama tool, tanpa path file, tanpa markdown, tanpa daftar — user hanya MENDENGAR kalimat ini.") +
    (input.persona
      ? lang === "en"
        ? "\n\nYour character:\n" + input.persona
        : "\n\nKaraktermu:\n" + input.persona
      : "");

  try {
    const { reply } = await llmForRole(
      "chat",
      () => config.connections,
      () => config.activeConnection,
      (conns) => config.saveConnections(conns, config.load().activeId),
      [
        {
          role: "user",
          content:
            (lang === "en" ? "Agent work result:\n" : "Hasil kerja agent:\n") +
            text.slice(0, 3000),
        },
      ],
      sys,
    );
    return { speak: cleanForSpeech(reply) || undefined };
  } catch (e: any) {
    console.warn("[persona/narrator] gagal (dilewati):", e?.message || e);
    return {};
  }
}
