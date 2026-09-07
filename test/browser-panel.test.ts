import { describe, expect, it } from "bun:test";
import { normalizeAddress, previewPoint } from "../src/client/browser/panel";

describe("browser panel utilities", () => {
  it("menormalisasi alamat ke URL https", () => {
    expect(normalizeAddress(" example.com/path ")).toBe("https://example.com/path");
    expect(normalizeAddress("http://localhost:3000/a")).toBe("http://localhost:3000/a");
    expect(normalizeAddress("")).toBe("https://example.com");
    expect(() => normalizeAddress("http://[rusak")).toThrow();
  });

  it("memetakan klik preview ke koordinat 0..1", () => {
    const rect = { left: 10, top: 20, width: 400, height: 200 };
    expect(previewPoint(210, 120, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(previewPoint(9, 120, rect)).toBeNull();
    expect(previewPoint(210, 221, rect)).toBeNull();
    expect(previewPoint(10, 20, { ...rect, width: 0 })).toBeNull();
  });
});
