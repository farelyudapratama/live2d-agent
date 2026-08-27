// Fase 3-5 tests — /api/model/analyze-sheet validation, applyExpression()'s
// preset path, and model-agnostic character identity.
//
// The endpoint's sanitising reducer is the important part here, so it is
// extracted from server.js and EXECUTED against adversarial LLM payloads rather
// than pattern-matched. Everything else (wiring, identity helpers) is asserted
// structurally or run in a vm sandbox, matching the fase1/fase2 suites.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// Slice the endpoint handler so assertions can't match a same-named thing
// elsewhere in server.js.
const epBlock = (() => {
  const a = srvSrc.indexOf("/api/model/analyze-sheet'");
  const b = srvSrc.indexOf('/api/animate-text', a);
  return a === -1 ? '' : srvSrc.slice(a, b === -1 ? a + 20000 : b);
})();

// ───────────────────────────────────────────────────────────────
section('1. Endpoint exists and is registered as POST');

ok('POST /api/model/analyze-sheet registered',
  /req\.method === 'POST' && req\.url\.split\('\?'\)\[0\] === '\/api\/model\/analyze-sheet'/.test(srvSrc));
ok('endpoint block found', epBlock.length > 500, epBlock.length + ' chars');
ok('server.js still parses', (() => {
  try { new (require('vm').Script)(srvSrc); return true; } catch (e) { return false; }
})());
ok('body size capped (no unbounded buffering)', /body\.length > 1e6/.test(epBlock));
ok('malformed JSON answered 400 not 500', /400.*\n?.*body JSON rusak|body JSON rusak/.test(epBlock));
// A 500 here would be indistinguishable from a server bug in the UI.
ok('LLM failure degrades to 200 + warning', /warning: err\.message/.test(epBlock),
  'UI shows a reason instead of a dead button');

// ───────────────────────────────────────────────────────────────
section('2. Prompt refuses to solicit forbidden fields');

ok("prompt forbids min/max/def/steps explicitly",
  /JANGAN menyertakan min, max, def, atau steps/.test(epBlock));
ok("prompt forbids category 'gerak'", /gerak.*TIDAK BOLEH diusulkan/.test(epBlock));
ok('prompt forbids inventing ids', /JANGAN mengarang id parameter/.test(epBlock));
ok("CATS excludes 'gerak'", /const CATS = \['emosi', 'properti', 'aksesoris'\]/.test(epBlock),
  'motions need timed keyframes, not a frozen pose');
ok('existing user names are sent to the LLM', /existingNames/.test(epBlock));

// ───────────────────────────────────────────────────────────────
section('3. Sanitising reducer executed against hostile payloads');

// Rebuild the reducer exactly as the endpoint runs it. Anything that diverges
// from server.js here would make these tests lie, so the body is sliced from
// source rather than retyped. The slice starts at the `ranges` map because the
// reducer closes over ranges/partIds/existingSet/str/seen/dropped — extracting
// only the reduce() call would leave those undefined.
const reducerSrc = (() => {
  const a = epBlock.indexOf('const ranges = new Map(params.map');
  const b = epBlock.indexOf('.slice(0, 12);', a);
  return a === -1 ? null : epBlock.slice(a, b + '.slice(0, 12);'.length);
})();
ok('reducer extracted from server.js', !!reducerSrc, reducerSrc ? reducerSrc.length + ' chars' : 'NOT FOUND');

function runReducer(parsed, params, parts, existing) {
  const sandbox = {
    parsed,
    params: params.map(p => ({ id: p.id, min: p.min, max: p.max, def: p.def })),
    parts: parts || [],
    existing: (existing || []).map(s => s.toLowerCase()),
    CATS: ['emosi', 'properti', 'aksesoris'],
    console: { warn() {}, log() {} },
    Number, Math, Object, Array, String, Set, Map,
  };
  vm.createContext(sandbox);
  vm.runInContext(reducerSrc + '\nglobalThis.__out = safe;', sandbox);
  return sandbox.__out;
}

const P = [
  { id: 'ParamMouthForm', min: -1, max: 1, def: 0 },
  { id: 'ParamEyeLOpen', min: 0, max: 1, def: 1 },
  { id: 'ParamCheek', min: 0, max: 1, def: 0 },
];
const PARTS = ['PartGlasses'];

if (reducerSrc) {
  // The core promise of this endpoint: ranges never come from the LLM.
  let out = runReducer([
    { name: 'Senang', category: 'emosi', values: { ParamMouthForm: 1 },
      min: -99, max: 99, def: 42, steps: [{ d: { ParamMouthForm: 1 }, ms: 500 }] },
  ], P, PARTS);
  ok('preset survives with valid fields', out.length === 1, JSON.stringify(out[0] || {}));
  ok('min/max/def stripped from LLM output', out.length === 1 &&
    !('min' in out[0]) && !('max' in out[0]) && !('def' in out[0]),
    'keys: ' + Object.keys(out[0] || {}).join(','));
  ok('steps stripped from LLM output', out.length === 1 && !('steps' in out[0]),
    'a frozen pose is not a motion');
  ok("source forced to 'ai'", out.length === 1 && out[0].source === 'ai');

  // Out-of-range values clamp instead of deforming the model.
  out = runReducer([{ name: 'Ekstrem', category: 'emosi', values: { ParamMouthForm: 999, ParamEyeLOpen: -50 } }], P, PARTS);
  ok('over-max value clamped to param max', out[0].values.ParamMouthForm === 1,
    'got ' + out[0].values.ParamMouthForm);
  ok('under-min value clamped to param min', out[0].values.ParamEyeLOpen === 0,
    'got ' + out[0].values.ParamEyeLOpen);

  // Hallucinated ids are the most common LLM failure on this task.
  out = runReducer([{ name: 'Halu', category: 'emosi', values: { ParamTidakAda: 1, ParamCheek: 0.5 } }], P, PARTS);
  ok('invented param id dropped', out.length === 1 && !('ParamTidakAda' in out[0].values));
  ok('real param id in same preset kept', out[0].values.ParamCheek === 0.5);

  out = runReducer([{ name: 'Kacamata', category: 'aksesoris', values: {}, parts: { PartGlasses: 1, PartHalu: 1 } }], P, PARTS);
  ok('invented part id dropped', !('PartHalu' in out[0].parts));
  ok('real part id kept', out[0].parts.PartGlasses === 1);
  out = runReducer([{ name: 'O', category: 'aksesoris', values: {}, parts: { PartGlasses: 7 } }], P, PARTS);
  ok('part opacity clamped to 0..1', out[0].parts.PartGlasses === 1, 'got ' + out[0].parts.PartGlasses);

  // Category gating.
  ok("category 'gerak' rejected at the reducer too",
    runReducer([{ name: 'Lambai', category: 'gerak', values: { ParamMouthForm: 1 } }], P, PARTS).length === 0,
    'defence in depth: prompt asks, reducer enforces');
  ok('unknown category rejected',
    runReducer([{ name: 'X', category: 'kategoriPalsu', values: { ParamMouthForm: 1 } }], P, PARTS).length === 0);
  ok('missing name rejected',
    runReducer([{ name: '', category: 'emosi', values: { ParamMouthForm: 1 } }], P, PARTS).length === 0);

  // A suggestion that shadows a user preset could never be reached anyway.
  ok('name colliding with existing user preset dropped',
    runReducer([{ name: 'Senang', category: 'emosi', values: { ParamMouthForm: 1 } }], P, PARTS, ['senang']).length === 0);
  ok('collision check is case-insensitive',
    runReducer([{ name: 'SeNaNg', category: 'emosi', values: { ParamMouthForm: 1 } }], P, PARTS, ['senang']).length === 0);
  ok('duplicate suggestions in one response deduped',
    runReducer([
      { name: 'Sedih', category: 'emosi', values: { ParamMouthForm: -1 } },
      { name: 'Sedih', category: 'emosi', values: { ParamMouthForm: -0.5 } },
    ], P, PARTS).length === 1);

  // An empty preset renders as an approvable row that does nothing.
  ok('preset with no valid values or parts dropped',
    runReducer([{ name: 'Kosong', category: 'emosi', values: { Halu: 1 }, parts: {} }], P, PARTS).length === 0);
  ok('NaN value dropped',
    runReducer([{ name: 'N', category: 'emosi', values: { ParamMouthForm: 'abc' } }], P, PARTS).length === 0);

  // Shape robustness — LLMs return all of these.
  ok('non-array response yields nothing', runReducer({ presets: [] }, P, PARTS).length === 0);
  ok('null entries skipped',
    runReducer([null, { name: 'A', category: 'emosi', values: { ParamMouthForm: 1 } }], P, PARTS).length === 1);
  ok('array entry (not object) skipped',
    runReducer([[1, 2, 3]], P, PARTS).length === 0);
  ok('values as array not object ignored safely',
    runReducer([{ name: 'A', category: 'emosi', values: [1, 2] }], P, PARTS).length === 0);
  ok('control chars stripped from name', (() => {
    const o = runReducer([{ name: 'Se\u0000na\u001Fng', category: 'emosi', values: { ParamMouthForm: 1 } }], P, PARTS);
    return o.length === 1 && o[0].name === 'Senang';
  })());
  ok('name capped at 60 chars', (() => {
    const o = runReducer([{ name: 'x'.repeat(300), category: 'emosi', values: { ParamMouthForm: 1 } }], P, PARTS);
    return o.length === 1 && o[0].name.length === 60;
  })());
  ok('at most 12 presets returned', (() => {
    const many = Array.from({ length: 40 }, (_, i) =>
      ({ name: 'P' + i, category: 'emosi', values: { ParamMouthForm: 0.1 } }));
    return runReducer(many, P, PARTS).length === 12;
  })());
}

// ───────────────────────────────────────────────────────────────
section('4. Endpoint input filtering (client side of the contract)');

ok('params without finite min/max rejected server-side',
  /Number\.isFinite\(Number\(p\.min\)\) && Number\.isFinite\(Number\(p\.max\)\)/.test(epBlock),
  'no range means nothing to clamp against');
ok('param/part count capped', (epBlock.match(/\.slice\(0, 300\)/g) || []).length >= 2);
ok('empty param list short-circuits before calling the LLM',
  /if \(!params\.length\)[\s\S]{0,160}return;/.test(epBlock), 'no wasted token spend');
ok('missing AI connection reported, not thrown',
  /tidak ada koneksi AI aktif/.test(epBlock));
ok('markdown fences stripped before JSON.parse', /replace\(\/```json\/gi/.test(epBlock),
  'LLMs wrap JSON in code fences constantly');
ok('bracket-scan fallback when direct parse fails', /match\(\/\\\[\\s\*\\\{/.test(epBlock));
ok('dropped count logged for diagnosis', /dropped.*invalid\/hallucinated preset/.test(epBlock));

// ───────────────────────────────────────────────────────────────
section('5. Client: analyzeSheetPresets() writes .ai only');

const asp = extractFn(appSrc, 'analyzeSheetPresets');
ok('analyzeSheetPresets() exists', !!asp);
if (asp) {
  ok('posts to /api/model/analyze-sheet', /\/api\/model\/analyze-sheet/.test(asp));
  ok('writes presets.ai', /sheet\.presets\.ai = incoming/.test(asp));
  // The guarantee is that NOTHING derived from the LLM response lands in
  // presets.user. `sheet.presets.user = []` (defensive init for sheets written
  // by an older build that had no .user field) is not a violation.
  //
  // Enumerate the assignments and check each one, rather than using a negative
  // lookahead: with `=\s*(?!\[\]...)` the engine can backtrack `\s*` to a
  // shorter match that makes the lookahead succeed, so such a pattern reports a
  // violation on text that is actually fine.
  ok('presets.user only ever read or defensively initialised', (() => {
    const writes = asp.match(/presets\.user\s*=[^=][^;\n]*/g) || [];
    return writes.every(w => /=\s*\[\]\s*$/.test(w.trim()));
  })(), 'writes found: ' + JSON.stringify(asp.match(/presets\.user\s*=[^=][^;\n]*/g) || []));
  ok('LLM payload never named on the left of a presets.user write',
    !/presets\.user\s*=\s*(incoming|parsed|safe|d\.presets)/.test(asp),
    'an unwanted suggestion must be a no-op, not data loss');
  ok("filters category 'gerak' client-side too", /p\.category !== 'gerak'/.test(asp));
  ok("re-normalises response with source 'ai'", /normalizePresetList\(\s*[\s\S]{0,80}'ai'\)/.test(asp));
  ok('persists to localStorage before network', asp.indexOf('localStorage.setItem') < asp.indexOf("'/api/sheet'"));
  ok('sheet-file write failure is non-fatal', /file write failed, kept locally/.test(asp));
  ok('capability cache invalidated after new presets', /invalidateCapabilityProfile\(\)/.test(asp));
  ok('throws when no sheet exists', /throw new Error\('Belum ada sheet/.test(asp));
}
ok('exposed on the debug surface as analyzePresets',
  /analyzePresets: analyzeSheetPresets/.test(appSrc));

section('5b. Analyze button runs both analyses independently');
const btnBlock = (() => {
  const a = appSrc.indexOf('if (shEls.analyze)');
  return a === -1 ? '' : appSrc.slice(a, a + 1600);
})();
ok('uses Promise.allSettled', /Promise\.allSettled/.test(btnBlock),
  'label failure must not deny preset suggestions');
ok('both analyses dispatched', /triggerAIParamClassification\(\)/.test(btnBlock) && /analyzeSheetPresets\(\)/.test(btnBlock));
ok('each outcome reported separately', /preset gagal/.test(btnBlock) && /label gagal/.test(btnBlock));
ok('button re-enabled in finally', /finally \{[\s\S]{0,120}analyze\.disabled = false/.test(btnBlock));

// ───────────────────────────────────────────────────────────────
section("6. applyExpression(): 'properti' presets now execute");

const ae = extractFn(appSrc, 'applyExpression');
ok('applyExpression() exists', !!ae);
if (ae) {
  const propIdx = ae.indexOf("findPreset(name, 'properti')");
  const nativeIdx = ae.indexOf('NATIVE mode');
  const emoIdx = ae.indexOf('state.supportedEmotions.hasOwnProperty(name)');
  ok('preset lookup present', propIdx !== -1);
  ok('preset checked BEFORE native .exp3 lookup', propIdx !== -1 && nativeIdx !== -1 && propIdx < nativeIdx,
    'user preset must win over a same-named builtin');
  ok('emotion engine checked FIRST (bigger blast radius)', emoIdx !== -1 && emoIdx < propIdx);
  ok("also resolves 'aksesoris' presets", /findPreset\(name, 'aksesoris'\)/.test(ae));
  ok('toggle-off returns to default', /state\.activeProperty = 'default'/.test(ae));
  ok('activeProperty tracked separately from activeEmotion',
    /state\.activeProperty = name/.test(ae) && !/state\.activeProperty = name;[\s\S]{0,60}activeEmotion = name/.test(ae),
    'a property is orthogonal to the face');
  ok('falls through when preset has no valid target',
    /had no valid target for this model/.test(ae),
    'must not report success on a stale preset');
}

// ───────────────────────────────────────────────────────────────
section('7. Model-agnostic identity: no hardcoded character');

const HARD = /神宫白子|Shiroko|白子/;
// Comments may still mention the model that was used for testing; only live
// code and markup matter.
const appNoComments = appSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
ok('no hardcoded character name in index.html markup', !HARD.test(htmlSrc));
ok('no hardcoded character name in app.js code', !HARD.test(appNoComments),
  'comments referencing the test model are fine');
ok('no hardcoded default model path', !/model\/[^'"]*\/面饼0\.model3\.json/.test(appNoComments));
ok('document title is generic in markup', /<title>Live2D Agent<\/title>/.test(htmlSrc));
ok('greeting bubble has an id to repaint', /id="greeting-bubble"/.test(htmlSrc));

const cn = extractFn(appSrc, 'characterName');
ok('characterName() exists', !!cn);
if (cn) {
  ok('displayName takes precedence', cn.indexOf('cfg.displayName') < cn.indexOf('state.modelPath'));
  ok('falls back to model folder name', /\/\^model\\\/\(\[\^\/\]\+\)\\\//.test(cn) || /model\\\//.test(cn));
  ok('decodes percent-encoded folder names', /decodeURIComponent/.test(cn),
    'CJK folder names arrive encoded');
  ok('generic final fallback', /return 'Live2D Agent'/.test(cn));
}

const ci = extractFn(appSrc, 'characterInitial');
ok('characterInitial() exists', !!ci);
ok('initial uses Array.from (astral-safe)', !!ci && /Array\.from\(n\)\[0\]/.test(ci),
  'name[0] would split a surrogate pair');

const aci = extractFn(appSrc, 'applyCharacterIdentity');
ok('applyCharacterIdentity() exists', !!aci);
if (aci) {
  ok('repaints document.title', /document\.title = name/.test(aci));
  ok('repaints .sb-name', /\.sb-name/.test(aci));
  ok('repaints existing agent bubbles', /\.msg\.agent \.msg-avatar/.test(aci),
    'bubbles drawn before the model resolved would keep the placeholder');
  ok('uses textContent not innerHTML', /textContent/.test(aci) && !/innerHTML/.test(aci));
  ok('spreads NodeList via Array.from', /Array\.from\(\$\$\(/.test(aci),
    'concat(NodeList) would nest the list');
}
ok('identity repainted on config apply', /applyModelConfig[\s\S]{0,900}applyCharacterIdentity\(\)/.test(appSrc));
ok('chat avatar derives from characterInitial()', /role === 'user' \? '🙂' : characterInitial\(\)/.test(appSrc));

section('7b. displayName is a first-class config field');
ok('displayName in MODEL_CONFIG_DEFAULTS', /displayName: '',/.test(appSrc));
ok('displayName normalised + capped', /raw\.displayName[\s\S]{0,160}slice\(0, 40\)/.test(appSrc));
ok('control chars stripped from displayName',
  /displayName === 'string'[\s\S]{0,120}\\u0000-\\u001F/.test(appSrc));
ok('input present in markup', /id="cfg-display-name"/.test(htmlSrc));
ok('input has a label association', /for="cfg-display-name"/.test(htmlSrc));
ok('input length capped in markup too', /id="cfg-display-name"[\s\S]{0,120}maxlength="40"/.test(htmlSrc));
ok('form reads displayName', /displayName: cfgEls\.displayName/.test(appSrc));
ok('form paints displayName', /cfgEls\.displayName\.value = c\.displayName/.test(appSrc));
ok('placeholder previews the derived name', /placeholder = '\(otomatis: ' \+ characterName\(\)/.test(appSrc));

section('7c. Default model resolution shared by boot and loadModel()');
const rap = extractFn(appSrc, 'resolveAnyModelPath');
ok('resolveAnyModelPath() exists', !!rap);
if (rap) {
  ok('asks the server for the model list', /\/api\/models/.test(rap));
  ok('resolves a concrete path', /\/api\/model\/path\?name=/.test(rap));
  ok('returns null instead of throwing', /return null/.test(rap));
}
ok('loadModel() uses the shared resolver', /modelPath = await resolveAnyModelPath\(\)/.test(appSrc));
ok('actionable error when no model installed', /Belum ada model terpasang/.test(appSrc));
ok('boot delegates to the same resolver', /const auto = await resolveAnyModelPath\(\)/.test(appSrc));

// ───────────────────────────────────────────────────────────────
section('8. config.json hygiene');
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) {}
ok('config.json parses', !!cfg);
if (cfg) {
  const ids = (cfg.connections || []).map(c => c.id);
  ok('broken connection conn_mtazqgo6 removed', ids.indexOf('conn_mtazqgo6') === -1);
  ok('activeId points at an existing connection', ids.indexOf(cfg.activeId) !== -1, cfg.activeId);
  ok('no connection has an invalid baseUrl', (cfg.connections || []).every(c => {
    if (!c.baseUrl) return true;
    try { new URL(c.baseUrl); return true; } catch (e) { return false; }
  }));
  // A FUTURE-dated stamp makes the app skip a working connection on boot.
  // A past-dated stamp is harmless and expected: server.js:438 writes this field
  // whenever a provider rate-limits, and server.js:426 only skips a connection
  // while the stamp is still in the future. Asserting the field is always absent
  // would forbid normal operation, so assert the property that actually matters.
  ok('no future-dated rateLimitedUntil stamps',
    (cfg.connections || []).every(c => {
      if (!c.rateLimitedUntil) return true;
      const t = new Date(c.rateLimitedUntil).getTime();
      return !Number.isFinite(t) || t <= Date.now();
    }));
  ok('no hardcoded foreign character in any systemPrompt',
    (cfg.connections || []).every(c => !/Lumine|genshin/i.test(c.systemPrompt || '')));
  ok('connection names are unique',
    new Set((cfg.connections || []).map(c => c.name)).size === (cfg.connections || []).length);
}

// ───────────────────────────────────────────────────────────────
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
