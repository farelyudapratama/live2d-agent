import { describe, expect, it } from "bun:test";
import { chromiumCandidates } from "../src/server/browser/discovery";

describe("browser discovery", () => {
  it("memprioritaskan Edge lokal/resmi lalu Chrome lokal/resmi", () => {
    expect(chromiumCandidates({ LOCALAPPDATA: "D:\\User\\Local" })).toEqual([
      "D:\\User\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "D:\\User\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]);
  });

  it("tidak membuat kandidat LOCALAPPDATA palsu saat env kosong", () => {
    const candidates = chromiumCandidates({});
    expect(candidates).toHaveLength(4);
    expect(candidates.every((path) => !path.startsWith("undefined"))).toBe(true);
  });
});
