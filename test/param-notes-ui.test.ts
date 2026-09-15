/**
 * test/param-notes-ui.test.ts — Migrated from test/legacy/test-param-notes-ui.js.
 *
 * Preserves all 26 production invariants:
 * 1. UI pencarian popup paramnotes (search input, input wiring, filter matching, group toggle, CSS rules)
 * 2. Group header grouping, count labels, and Parts special handling
 * 3. CDI3 original rigger labels & groups (prefetch, model3.json link, clean reset on model switch, sheet patch, popup bridge)
 * 4. AI sheet analysis payload including groups
 * 5. Preset pose reset & adopted expressions test buttons (part opacity restoration, production handle integration, complete state reset)
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const appSrc = readFileSync(join(ROOT, "static/js/app.js"), "utf8");
const htmlSrc = readFileSync(join(ROOT, "static/index.html"), "utf8");
const cssSrc = readFileSync(join(ROOT, "static/css/app.css"), "utf8");
const serverSrc = readFileSync(join(ROOT, "src/server/index.ts"), "utf8");

describe("Param Notes UI & Preset Pose Invariants", () => {
  describe("1. Search box in paramnotes popup", () => {
    test("input #pn-search exists in index.html inside paramnotes popup", () => {
      expect(/id="paramnotes-popup"[\s\S]{0,2000}id="pn-search"/.test(htmlSrc)).toBe(true);
    });

    test("pnSearch is wired to input event", () => {
      expect(/const pnSearch = \$\('#pn-search'\);/.test(appSrc)).toBe(true);
      expect(/pnSearch\.addEventListener\('input', applyPnFilter\)/.test(appSrc)).toBe(true);
    });

    test("applyPnFilter reads notes currently being edited", () => {
      expect(/function applyPnFilter\(\)[\s\S]{0,600}\.pn-input[\s\S]{0,300}pn-hidden/.test(appSrc)).toBe(true);
    });

    test("group headers with no visible rows are also hidden", () => {
      expect(/pn-group-header[\s\S]{0,900}classList\.toggle\('pn-hidden', !anyInGroup\)/.test(appSrc)).toBe(true);
    });

    test("CSS definitions for .pn-hidden and .pn-group-header exist", () => {
      expect(/\.pn-row\.pn-hidden \{ display: none; \}/.test(cssSrc)).toBe(true);
      expect(/\.pn-group-header \{/.test(cssSrc)).toBe(true);
    });
  });

  describe("2. Group headers from resolveParamGroup", () => {
    test("renderParamNotesPopup groups params before rendering", () => {
      expect(/const byGroup = new Map\(\);[\s\S]{0,600}appendGroupHeader\(pnList, g, members\.length\)/.test(appSrc)).toBe(true);
    });

    test("appendGroupHeader writes title and param count", () => {
      expect(/function appendGroupHeader\(list, title, count\)[\s\S]{0,500}textContent = count \+ ' param'/.test(appSrc)).toBe(true);
    });

    test("Parts remain their own group at the end", () => {
      expect(/appendGroupHeader\(pnList, 'Bagian \(Parts\)', parts\.length\)/.test(appSrc)).toBe(true);
    });
  });

  describe("3. Rigger labels and groups from cdi3", () => {
    test("prefetchCdiInfo is triggered during loadModel as fire-and-forget", () => {
      expect(/prefetchOverlayGate\(\);[\s\S]{0,120}prefetchCdiInfo\(\)/.test(appSrc)).toBe(true);
    });

    test("cdi3 is resolved via DisplayInfo from model3.json", () => {
      expect(/FileReferences && m3\.FileReferences\.DisplayInfo/.test(appSrc)).toBe(true);
    });

    test("state.cdiInfo is cleared when model is changed", () => {
      expect(/state\.cdiInfo = null;/.test(appSrc)).toBe(true);
    });

    test("inspectModel uses cdi3 label when present, raw id as fallback", () => {
      expect(/const label = \(cdiById && cdiById\.get\(rp\.id\) && cdiById\.get\(rp\.id\)\.label\) \|\| rp\.id;/.test(appSrc)).toBe(true);
    });

    test("rigger group title is prefixed with 'Rig: ' + member label", () => {
      expect(/function cdiGroupTitle\(gid\)[\s\S]{0,500}'Rig: ' \+ named\[0\]/.test(appSrc)).toBe(true);
    });

    test("existing sheet is patched in-place when cdi3 arrives", () => {
      expect(/p\.label !== info\.label\) \{ p\.label = info\.label; changed = true; \}/.test(appSrc)).toBe(true);
    });

    test("popup re-render communicates only through window.__pnRefreshIfOpen bridge", () => {
      expect(/window\.__pnRefreshIfOpen\(\)/.test(appSrc)).toBe(true);
      expect(/window\.__pnRefreshIfOpen = \(\) => \{/.test(appSrc)).toBe(true);
    });
  });

  describe("4. AI sheet analysis payload includes param groups", () => {
    test("allParams includes group resolved via resolveParamGroup", () => {
      expect(/\.map\(p => \(\{ id: p\.id, min: p\.min, max: p\.max, def: p\.def, label: p\.label \|\| '',[\s\S]{0,200}group: resolveParamGroup\(sheet, p\.id, p\.group\) \}\)\)/.test(appSrc)).toBe(true);
    });

    test("server formats [grup: ...] into prompt lines", () => {
      expect(/\[grup: \$\{p\.group\.trim\(\)\.slice\(0, ?40\)\}\]/.test(serverSrc)).toBe(true);
    });

    test("server validates group is non-empty string before usage", () => {
      expect(/typeof p\.group==="string"&&p\.group\.trim\(\)/.test(serverSrc)).toBe(true);
    });
  });

  describe("5. Preset pose reset & adopted expressions testing", () => {
    test("applyPreset tracks sticky params for Reset Pose", () => {
      expect(/setSticky\(id, Math\.max\(lo, Math\.min\(hi, Number\(raw\)\)\), 1\);[\s\S]{0,80}presetPoseParams\.add\(id\);/.test(appSrc)).toBe(true);
    });

    test("part opacity is captured BEFORE modification as restoration basis", () => {
      expect(/if \(!presetPoseParts\.has\(id\)\) \{[\s\S]{0,400}getPartOpacityById\(id\);/.test(appSrc)).toBe(true);
    });

    test("releasePresetPose restores parts and resets emotions in fallback legacy path", () => {
      expect(/function releasePresetPose\(\)[\s\S]{0,900}delete state\.overrides\[id\];[\s\S]{0,2000}setPartOpacityById\(id,[\s\S]{0,1600}resetEmotion\(\);/.test(appSrc)).toBe(true);
    });

    test("releasePresetPose restores parts through handle.setPartOpacity in production path", () => {
      expect(/function releasePresetPose\(\)[\s\S]{0,900}delete state\.overrides\[id\];[\s\S]{0,2000}state\.handle\.setPartOpacity\(id,[\s\S]{0,2000}resetEmotion\(\);/.test(appSrc)).toBe(true);
    });

    test("releasePresetPose clears overrides, stops motion, clears aiPose, and resets params to default", () => {
      expect(/for \(const id in state\.overrides\) delete state\.overrides\[id\];[\s\S]*?stopAllMotions\(\);[\s\S]*?state\.aiPose = \{[\s\S]*?pokeActual\(id, def\);/.test(appSrc)).toBe(true);
    });

    test("Reset Pose button exists above preset list", () => {
      expect(/resetBtn\.textContent = 'Reset Pose';/.test(appSrc)).toBe(true);
    });

    test("each adopted expression has a test button wired to setExpression", () => {
      expect(/testBtn\.textContent = 'tes';/.test(appSrc)).toBe(true);
      expect(/window\.__live2dAgent\.setExpression\(e\.Name, 1\)/.test(appSrc)).toBe(true);
    });

    test("system prompt hint explains connection scope without persona conflict", () => {
      expect(/Persona karakter jangan di sini: pakai Catatan Karakter/.test(htmlSrc)).toBe(true);
    });
  });
});
