/**
 * test/voice-input.test.ts — unit test bagian MURNI dari static/js/voice-input.js.
 *
 * Modul STT-nya sendiri browser-only (getUserMedia/MediaRecorder/transformers.js),
 * jadi tidak bisa dijalankan di bun — tapi tiga keputusan algoritmik yang paling
 * rawan salah diuji di sini sebagai fungsi murni: RMS voice-activity, resampler
 * 16 kHz, dan keputusan auto-stop.
 */
import { describe, it, expect } from "bun:test";
import { rms, resampleTo16k, shouldAutoStop } from "../static/js/voice-input.js";

describe("rms — voice activity", () => {
  it("silence total -> 0", () => {
    expect(rms(new Float32Array(512))).toBe(0);
  });
  it("buffer kosong/null -> 0 (tidak throw)", () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(null)).toBe(0);
  });
  it("sine full-scale -> ~0.707", () => {
    const buf = new Float32Array(480);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * i) / buf.length);
    expect(rms(buf)).toBeCloseTo(0.7071, 2);
  });
});

describe("resampleTo16k", () => {
  it("rate sama -> array utuh tanpa salin ulang nilai", () => {
    const a = new Float32Array([0.1, 0.2, 0.3]);
    const out = resampleTo16k(a, 16000);
    expect(out).toBe(a); // referensi sama: nol alokasi di jalur umum
  });
  it("48k -> 16k: panjang 1/3, konstanta tetap konstanta", () => {
    const a = new Float32Array(4800).fill(0.5);
    const out = resampleTo16k(a, 48000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[out.length - 1]).toBeCloseTo(0.5, 6);
  });
  it("48k -> 16k: ramp linear tersample di titik yang benar", () => {
    const a = new Float32Array(480);
    for (let i = 0; i < a.length; i++) a[i] = i; // 1 unit per sampel 48k
    const out = resampleTo16k(a, 48000);
    expect(out.length).toBe(160);
    // tiap 3 sampel sumber -> tepat di grid: out[i] === i*3
    expect(out[1]).toBeCloseTo(3, 6);
    expect(out[50]).toBeCloseTo(150, 6);
  });
  it("upsample 8k -> 16k memanjang 2x dengan interpolasi di antara", () => {
    const a = new Float32Array([0, 1]); // 2 sampel pada 8k
    const out = resampleTo16k(a, 8000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0.5, 6); // titik antara
  });
  it("input kosong -> array kosong, bukan throw", () => {
    expect(resampleTo16k(new Float32Array(0), 48000).length).toBe(0);
  });
});

describe("shouldAutoStop", () => {
  const base = { silenceMs: 1500, maxMs: 30000 };
  it("belum bicara + belum max -> lanjut", () => {
    expect(shouldAutoStop(10_000, { spokeOnce: false, lastVoiceAt: 10_000, startedAt: 9_000, ...base })).toBeNull();
  });
  it("bicara lalu senyap >= silenceMs -> 'silence'", () => {
    expect(shouldAutoStop(10_501, { spokeOnce: true, lastVoiceAt: 9_000, startedAt: 9_000, ...base })).toBe('silence');
  });
  it("senyap tapi belum mencapai silenceMs -> lanjut", () => {
    expect(shouldAutoStop(10_400, { spokeOnce: true, lastVoiceAt: 9_000, startedAt: 9_000, ...base })).toBeNull();
  });
  it("durasi total >= maxMs -> 'max' meski terus bicara", () => {
    const t = 40_000;
    expect(shouldAutoStop(t, { spokeOnce: true, lastVoiceAt: t, startedAt: 9_000, ...base })).toBe('max');
  });
});
