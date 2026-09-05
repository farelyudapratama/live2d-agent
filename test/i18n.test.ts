/**
 * test/i18n.test.ts — guard sistem localization.
 *
 * Menjaga tiga kontrak:
 *  1. PARITY  — setiap kunci dict-id ada di dict-en, dan sebaliknya. Menambah
 *     kunci di satu file tanpa pasangannya = gagal di sini.
 *  2. COVERAGE — semua nilai data-i18n* di index.html & pet.html harus jadi
 *     kunci yang dikenal (mencegah typo kunci → UI menampilkan nama kunci).
 *  3. CORE — t(): fallback ke kamus id, fallback terakhir ke nama kunci,
 *     interpolasi {var} dan variabel tak dikenal dibiarkan apa adanya.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { DICT_ID } from "../src/client/i18n/dict-id";
import { DICT_EN } from "../src/client/i18n/dict-en";
import { t } from "../src/client/i18n/index";

const REPO = join(import.meta.dir, "..");

function htmlKeys(file: string): string[] {
  const html = readFileSync(join(REPO, file), "utf8");
  const re = /data-i18n(?:-html|-ph|-title|-aria)?="([^"]+)"/g;
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) keys.push(m[1]);
  return keys;
}

describe("i18n dictionaries", () => {
  test("parity: dict-id ↔ dict-en", () => {
    const id = Object.keys(DICT_ID);
    const en = Object.keys(DICT_EN);
    const onlyId = id.filter((k) => !(k in DICT_EN));
    const onlyEn = en.filter((k) => !(k in DICT_ID));
    expect(onlyId).toEqual([]);
    expect(onlyEn).toEqual([]);
  });

  test("tidak ada nilai kosong", () => {
    for (const [k, v] of Object.entries(DICT_ID)) expect(typeof v === "string" && v.length > 0, `${k} kosong di dict-id`).toBe(true);
    for (const [k, v] of Object.entries(DICT_EN)) expect(typeof v === "string" && v.length > 0, `${k} kosong di dict-en`).toBe(true);
  });

  test("placeholder {var} konsisten antar bahasa", () => {
    const vars = (s: string) => (s.match(/\{(\w+)\}/g) || []).sort().join(",");
    for (const k of Object.keys(DICT_ID)) {
      expect(vars(DICT_EN[k] ?? ""), `placeholder beda pada kunci ${k}`).toBe(vars(DICT_ID[k]));
    }
  });
});

describe("i18n markup coverage", () => {
  for (const file of ["static/index.html", "static/pet.html"]) {
    test(`${file} — semua kunci data-i18n* dikenal`, () => {
      const missing = htmlKeys(file).filter((k) => !(k in DICT_ID) || !(k in DICT_EN));
      expect(missing).toEqual([]);
    });
  }

  test("index.html memuat core i18n via bundle.js; pet.html via i18n.js", () => {
    expect(readFileSync(join(REPO, "static/index.html"), "utf8")).toContain('src="js/bundle.js"');
    expect(readFileSync(join(REPO, "static/pet.html"), "utf8")).toContain('src="js/i18n.js');
  });

  test("elemen ber-data-i18n tidak boleh punya elemen anak — sweep menimpa textContent dan akan menghapusnya (kasus #btn-add-conn)", () => {
    // Tanda bahaya: tag pembuka ber-atribut data-i18n= (bukan -html/-ph/-title/
    // -aria) langsung diikuti tag lain — berarti ada elemen anak yang akan
    // terhapus saat apply() menimpa textContent.
    const dangerous = /<[a-zA-Z]+[^>]*\sdata-i18n="[^"]*"[^>]*>\s*</;
    for (const file of ["static/index.html", "static/pet.html"]) {
      const hit = readFileSync(join(REPO, file), "utf8").match(dangerous);
      expect(hit === null, `${file} memuat data-i18n pada elemen beranak: ${hit ? hit[0].slice(0, 90) : ""}`).toBe(true);
    }
  });
});

describe("i18n core t()", () => {
  test("kunci dikenal → teks kamus", () => {
    expect(t("chat.send")).toBe("Kirim");
  });

  test("kunci tidak dikenal → jatuh ke nama kunci (tidak pernah crash)", () => {
    expect(t("__kunci_palsu_42__")).toBe("__kunci_palsu_42__");
  });

  test("interpolasi {var} + variabel tak dikenal dibiarkan", () => {
    const out = t("chat.greetName", { name: "Hatsune", tidakAda: "x" });
    expect(out).toContain("Hatsune");
    expect(out).not.toContain("{name}");
  });
});
