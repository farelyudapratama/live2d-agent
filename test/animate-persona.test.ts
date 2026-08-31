/**
 * animate-persona.test.ts — persona & nama karakter ke Animation Director.
 *
 * Yang dikunci di sini: sanitizePersonaText — satu-satunya pintu masuk teks
 * persona/nama ke prompt director (POST /api/animate-text). Aturannya sama
 * dengan sanitizeUserNote di app.js: control char dibuang, newline & tab
 * DIPERTAHANKAN (persona boleh multi-baris), trim, batas panjang keras.
 */
import { describe, test, expect } from "bun:test";
import { sanitizePersonaText } from "../src/server/index";

describe("sanitizePersonaText", () => {
  test("bukan string / kosong → \"\"", () => {
    expect(sanitizePersonaText(null)).toBe("");
    expect(sanitizePersonaText(undefined)).toBe("");
    expect(sanitizePersonaText(42)).toBe("");
    expect(sanitizePersonaText({})).toBe("");
    expect(sanitizePersonaText("")).toBe("");
    expect(sanitizePersonaText("   ")).toBe("");
  });

  test("control char dibuang; newline & tab dipertahankan (paritas sanitizeUserNote)", () => {
    expect(sanitizePersonaText("dia pemalu\r\n\tsuka anime\u0007")).toBe("dia pemalu\r\n\tsuka anime");
    expect(sanitizePersonaText("baris1\nbaris2")).toBe("baris1\nbaris2");
  });

  test("trim + cap default 800", () => {
    expect(sanitizePersonaText("  hai  ")).toBe("hai");
    expect(sanitizePersonaText("a".repeat(900)).length).toBe(800);
  });

  test("cap kustom 60 untuk nama karakter", () => {
    expect(sanitizePersonaText("N".repeat(100), 60).length).toBe(60);
  });
});
