import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");

describe("kontrak bundle HTML", () => {
  it("bundle dimuat sebelum app legacy", () => {
    const html = readFileSync(join(root, "static/index.html"), "utf8");
    expect(html.indexOf('src="js/bundle.js"')).toBeGreaterThan(-1);
    expect(html.indexOf('src="js/bundle.js"')).toBeLessThan(html.indexOf('src="js/app.js"'));
  });

  it("bridge ekspresi dipasang bundle dan adapter legacy fail-loud", () => {
    const entry = readFileSync(join(root, "src/client/bundle-entry.ts"), "utf8");
    const app = readFileSync(join(root, "static/js/app.js"), "utf8");
    expect(entry).toContain("window.__nativeExpressions = { collect: collectNativeExpressions }");
    expect(app).toContain("window.__nativeExpressions.collect(m)");
    expect(app).toContain("TS core __nativeExpressions belum terpasang");
    expect(app).not.toContain("em.definitions.map");
  });
});
