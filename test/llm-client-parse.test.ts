/**
 * test/llm-client-parse.test.ts — extractJSON: parse toleran untuk proxy LLM
 * tidak standar. Kasus nyata direkam dari relay openai-compatible lokal
 * ("9ruter"): body = satu JSON utuh + ekor `data: [DONE]` tanpa pemisah,
 * Content-Type text/event-stream, padahal request tidak meminta stream.
 */
import { describe, it, expect } from "bun:test";
import { extractJSON } from "../src/shared/llm-client";

const RELAY_BODY =
  '{"id":"chatcmpl-RXCYt5B1g88yDAiLwcqSzYmZ","object":"chat.completion","created":1788073032,' +
  '"model":"big-pickle","choices":[{"index":0,"finish_reason":"stop","logprobs":null,' +
  '"message":{"role":"assistant","content":"Halo! Aku baik-baik saja.","name":null,' +
  '"reasoning_content":null,"tool_calls":[]}}],"usage":{"total_tokens":46},"cost":"0"}data: [DONE]\n\n';

describe("extractJSON", () => {
  it("JSON murni tetap lewat tanpa sentuhan", () => {
    const t = '{"choices":[{"message":{"content":"hi"}}]}';
    expect(extractJSON(t).choices[0].message.content).toBe("hi");
  });

  it("JSON utuh + ekor `data: [DONE]` dari relay 9ruter → terselamatkan utuh", () => {
    const j = extractJSON(RELAY_BODY);
    expect(j.object).toBe("chat.completion");
    expect(j.choices[0].message.content).toContain("baik-baik");
    expect(j.choices[0].finish_reason).toBe("stop");
  });

  it("scanner string-aware: `}` di dalam string tidak dihitung sebagai akhir objek", () => {
    const j = extractJSON('{"a":"}"}data: [DONE]');
    expect(j.a).toBe("}");
    expect(() => extractJSON('{"a":" busted')).toThrow(/respon bukan JSON/);
  });

  it("SSE chunk murni (delta.content) → digabung jadi satu pesan", () => {
    const t =
      'data: {"choices":[{"delta":{"content":"Halo"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" dunia"}}]}\n\n' +
      "data: [DONE]\n\n";
    const j = extractJSON(t);
    expect(j.choices[0].message.content).toBe("Halo dunia");
  });

  it("chunk terpotong di tengah di-skip, chunk sehat tetap terselamatkan", () => {
    const t =
      'data: {"choices":[{"delta":{"content":"Aku"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"sedang menuli\n\n' + // terpotong
      'data: {"choices":[{"delta":{"content":"kan"}}]}\n\n' +
      "data: [DONE]\n\n";
    const j = extractJSON(t);
    expect(j.choices[0].message.content).toBe("Akukan");
  });

  it("SSE satu baris berisi chat.completion penuh (bukan delta) → langsung dipakai", () => {
    const t = 'data: {"choices":[{"message":{"content":"satu"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n';
    expect(extractJSON(t).choices[0].message.content).toBe("satu");
  });

  it("sampah tanpa JSON → tetap error dengan 200 karakter pertama", () => {
    expect(() => extractJSON("<html>Gateway error</html>")).toThrow(/respon bukan JSON/);
  });

  it("body KOSONG → pesan manusiawi, bukan 'respon bukan JSON'", () => {
    expect(() => extractJSON("")).toThrow(/respon KOSONG/);
    expect(() => extractJSON("   \n")).toThrow(/respon KOSONG/);
  });
});
