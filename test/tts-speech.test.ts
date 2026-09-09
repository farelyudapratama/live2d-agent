/**
 * test/tts-speech.test.ts — persona/speech-lang.ts: terjemahan teks-bicara
 * per bahasa suara (tanpa jaringan — LLM call di-stub lewat inject).
 */
import { describe, test, expect } from "bun:test";
import {
  translateForSpeech,
  speechLangOf,
  ttsLangIsFixed,
  detectSpeechLangBase,
} from "../src/server/persona/speech-lang";

describe("speech-lang — pemetaan bahasa", () => {
  test("speechLangOf: locale → kode dasar", () => {
    expect(speechLangOf("ja-JP")).toBe("ja");
    expect(speechLangOf("en-US")).toBe("en");
    expect(speechLangOf("auto")).toBe("auto");
    expect(speechLangOf("")).toBe("");
  });

  test("ttsLangIsFixed: kode bahasa tetap = true; auto/kosong = false", () => {
    expect(ttsLangIsFixed("ja-JP")).toBe(true);
    expect(ttsLangIsFixed("id")).toBe(true);
    expect(ttsLangIsFixed("auto")).toBe(false);
    expect(ttsLangIsFixed("")).toBe(false);
    expect(ttsLangIsFixed(undefined)).toBe(false);
  });

  test("detectSpeechLangBase: skrip & kata layak Indonesia", () => {
    expect(detectSpeechLangBase("こんにちは")).toBe("ja");
    expect(detectSpeechLangBase("你好世界")).toBe("zh");
    expect(detectSpeechLangBase("안녕하세요")).toBe("ko");
    expect(detectSpeechLangBase("aku sudah makan kok")).toBe("id");
    expect(detectSpeechLangBase("this is a compiler bug")).toBe("en");
  });
});

describe("speech-lang — translateForSpeech", () => {
  test("teks kosong → apa adanya, tanpa panggil LLM", async () => {
    let called = 0;
    const out = await translateForSpeech(
      "",
      "ja-JP",
      async () => {
        called++;
        return "x";
      },
      new Map(),
    );
    expect(out).toBe("");
    expect(called).toBe(0);
  });

  test("teks SUDAH berbahasa target → tanpa LLM (deterministik, tanpa biaya)", async () => {
    let called = 0;
    const out = await translateForSpeech(
      "こんにちは、みなさん！",
      "ja-JP",
      async () => {
        called++;
        return "x";
      },
      new Map(),
    );
    expect(out).toBe("こんにちは、みなさん！");
    expect(called).toBe(0);
  });

  test("sukses → hasil terjemahan; kutip pembuka/penutup dibuang", async () => {
    const store = new Map<string, string>();
    const out = await translateForSpeech(
      "Halo, apa kabar?",
      "ja-JP",
      async () => '“こんにちは、お元気ですか？”',
      store,
    );
    expect(out).toBe("こんにちは、お元気ですか？");
    expect(store.size).toBe(1);
  });

  test("cache: teks+bahasa sama tidak memanggil LLM ulang", async () => {
    const store = new Map<string, string>();
    let called = 0;
    const call = async () => {
      called++;
      return "konbanwa";
    };
    expect(await translateForSpeech("aku sudah lelah", "ja-JP", call, store)).toBe("konbanwa");
    expect(await translateForSpeech("aku sudah lelah", "ja-JP", call, store)).toBe("konbanwa");
    expect(called).toBe(1);
    // Bahasa beda → kunci beda → LLM dipanggil lagi.
    expect(await translateForSpeech("aku sudah lelah", "en-US", call, store)).toBe("konbanwa");
    expect(called).toBe(2);
  });

  test("LLM gagal → teks asli (degrade senyap) dan TIDAK ter-cache", async () => {
    const store = new Map<string, string>();
    let called = 0;
    const call = async () => {
      called++;
      throw new Error("down");
    };
    expect(await translateForSpeech("halo", "ja-JP", call, store)).toBe("halo");
    expect(await translateForSpeech("halo", "ja-JP", call, store)).toBe("halo");
    expect(called).toBe(2); // gagal tidak di-cache — dicoba lagi nanti
    expect(store.size).toBe(0);
  });
});
