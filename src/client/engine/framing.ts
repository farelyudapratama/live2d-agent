/**
 * client/engine/framing.ts — Rumus framing model Live2D ke panggung (murni).
 * Dipakai legacy app.js `frameModel` via `window.__framing.computeFrame`
 * (port "port saat disentuh"; app.js menyisakan fallback rumus lama bila
 * bundle belum terpasang).
 *
 * Prinsip anti-gepeng (permintaan user): skala karakter TIDAK boleh dibatasi
 * lebar panel untuk mode "upper"/"full" — keduanya fungsi TINGGI panggung
 * saja, karena tinggi stage tidak berubah saat splitter didrag. Lebar panel
 * hanya menggeser pan (x = center) dan memotong sisi kiri/kanan; panel kiri
 * diperkecil → karakter tetap sama besar, bukan ikut mengecil.
 * Hanya mode "fit" (dobel-klik / reset / framing lama) yang benar-benar
 * menyesuaikan diri ke lebar.
 *
 * natW/natH = ukuran natural model (bounds / scale saat itu) — sudah
 * divalidasi pemanggil; fungsi tetap menolak input tak masuk akal.
 */

export type FrameMode = "upper" | "full" | "fit";

export interface Frame {
  scale: number;
  x: number;
  y: number;
}

export function computeFrame(
  natW: number,
  natH: number,
  W: number,
  H: number,
  mode: FrameMode,
): Frame | null {
  const ok = [natW, natH, W, H].every(Number.isFinite);
  if (!ok || natW <= 1 || natH <= 1 || W <= 1 || H <= 1) return null;
  let scale: number;
  if (mode === "full") {
    // Full body: 82% tinggi panggung.
    scale = (H * 0.82) / natH;
  } else if (mode === "upper") {
    // Upper: fokus atas, sedikit crop bawah (105% tinggi) — lebar tidak
    // membatasi; panel sempit memotong sisi, bukan mengecilkan karakter.
    scale = (H * 1.05) / natH;
  } else {
    // Fit: seluruh model muat (dobel-klik / fallback).
    scale = Math.min(W / natW, H / natH) * 0.9;
  }
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const bw = natW * scale;
  const bh = natH * scale;
  return { scale, x: W / 2 - bw / 2, y: (H - bh) / 2 };
}
