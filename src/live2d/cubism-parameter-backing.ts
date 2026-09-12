/**
 * live2d/cubism-parameter-backing.ts — adapter CubismModel resmi →
 * CubismParameterBacking (interface polos milik ParameterApi).
 *
 * Modul ini SENGAJA hanya menyebut `CubismModel` lewat `import type` (dihapus
 * saat compile) dan HANYA memanggil method pada objek model yang diberikan —
 * tidak ada global WASM/core, sehingga bisa dites dengan duck-typed fake model
 * (lihat test/parameter-api.test.ts) tanpa memuat framework asli.
 *
 * Mapping id → indeks dibangun SEKALI saat konstruksi (parameter model tidak
 * berubah selama model hidup), sehingga get/set by-ID O(1) via indeks dan
 * tidak memancing side-effect getIdManager() berulang.
 */

import type { CubismParameterBacking } from "./parameter-api";

/**
 * Kontrak minimal method yang kita panggil pada model Cubism. Didefinisikan lokal
 * (BUKAN import type dari framework resmi) agar modul ini — dan seluruh program
 * tsc — TIDAK menarik sumber framework ke dalam type-check (framework resmi
 * tidak lolos strict null-check; ia di-build via Bun.build, bukan tsc). Pendekatan
 * ini juga membuat adapter model-agnostic: objek apa pun dengan method tersebut
 * (CubismModel asli, fake model di test, dsb.) bisa dipakai.
 */
interface CubismModelLike {
  getParameterCount(): number;
  getParameterId(index: number): { getString(): string };
  getParameterValueByIndex(index: number): number;
  getParameterMinimumValue(index: number): number;
  getParameterMaximumValue(index: number): number;
  getParameterDefaultValue(index: number): number;
  setParameterValueByIndex(index: number, value: number, weight: number): void;
  update(): void;
  getModel(): unknown;
}

/**
 * Bangun backing ParameterApi dari sebuah CubismModel (CubismUserModel._model).
 * @param model instance CubismModel yang SUDAH dimuat.
 */
export function createCubismModelBacking(model: CubismModelLike): CubismParameterBacking {
  const count = model.getParameterCount();

  // Cache id → indeks (model-agnostic: baca ID asli dari model).
  const indexById = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    indexById.set(model.getParameterId(i).getString(), i);
  }

  const at = (id: string): number => {
    const i = indexById.get(id);
    return i === undefined ? -1 : i;
  };

  return {
    getParameterCount: () => count,
    getParameterId: (i: number) => model.getParameterId(i).getString(),
    getParameterValue: (id: string) => {
      const i = at(id);
      return i < 0 ? 0 : model.getParameterValueByIndex(i);
    },
    getParameterMinimum: (id: string) => {
      const i = at(id);
      return i < 0 ? 0 : model.getParameterMinimumValue(i);
    },
    getParameterMaximum: (id: string) => {
      const i = at(id);
      return i < 0 ? 0 : model.getParameterMaximumValue(i);
    },
    getParameterDefault: (id: string) => {
      const i = at(id);
      return i < 0 ? 0 : model.getParameterDefaultValue(i);
    },
    setParameterValue: (id: string, value: number) => {
      const i = at(id);
      // i valid → tulis via indeks (Cubism sendiri juga clamp → idempoten
      // dengan clamp API). id tak dikenal → abaikan (aman, tak buat param baru).
      if (i >= 0) model.setParameterValueByIndex(i, value, 1);
    },
    update: () => model.update(),
    isAlive: () => !!(model && model.getModel()),
  };
}
