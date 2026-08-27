// Fase 2 tests — tab 📋 Sheet: sheet viewer, preset list, preset editor.
//
// Same strategy as test-fase1-usernote-ui.js: pure helpers are extracted and
// executed for real in a vm sandbox; DOM wiring is asserted structurally against
// the source, because there is no DOM in node here.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');

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

// The Sheet pane's wiring lives inside wireUI(). Slice it out so assertions
// cannot accidentally match an identically-named thing elsewhere in the file.
const sheetBlock = (() => {
  const a = appSrc.indexOf('// ── Tab 📋 Sheet');
  const b = appSrc.indexOf('loadConns();', a);
  return a === -1 ? '' : appSrc.slice(a, b === -1 ? a + 20000 : b);
})();

section('1. Markup — tab and pane');
ok('tab button 📋 Sheet exists', /data-tab="sheet"/.test(htmlSrc));
ok('matching pane exists', /class="tab-pane" data-pane="sheet"/.test(htmlSrc));
ok('sheet pane sits between the model and ai panes',
  htmlSrc.indexOf('data-pane="sheet"') > htmlSrc.indexOf('data-pane="model"') &&
  htmlSrc.indexOf('data-pane="sheet"') < htmlSrc.indexOf('data-pane="ai"'));
ok('only the model tab starts active (one active tab)',
  (htmlSrc.match(/class="tab active"/g) || []).length === 1);
ok('div tags still balance', 
  (htmlSrc.match(/<div\b/g) || []).length === (htmlSrc.match(/<\/div>/g) || []).length,
  (htmlSrc.match(/<div\b/g) || []).length + ' open');
ok('note panel is still inside the Model pane (fase 1 not broken)',
  htmlSrc.indexOf('input-user-note') > htmlSrc.indexOf('data-pane="model"') &&
  htmlSrc.indexOf('input-user-note') < htmlSrc.indexOf('data-pane="sheet"'));

section('2. Markup — required ids');
for (const id of ['sheet-summary', 'sheet-cats', 'sheet-preset-list', 'sheet-status',
  'btn-sheet-analyze', 'preset-name', 'preset-cat', 'btn-preset-capture',
  'preset-capture-info', 'preset-values', 'btn-preset-save', 'btn-preset-clear',
  'preset-status']) {
  ok('#' + id + ' exists', htmlSrc.includes('id="' + id + '"'));
}
ok('category dropdown offers exactly the 4 known categories',
  ['emosi', 'properti', 'aksesoris', 'gerak']
    .every(c => new RegExp('<option value="' + c + '"').test(htmlSrc)));
ok('preset name input is length-capped in markup too',
  /id="preset-name"[^>]*maxlength="60"/.test(htmlSrc));
ok('sheet status is a live region', /id="sheet-status"[^>]*aria-live="polite"/.test(htmlSrc));
ok('preset status is a live region', /id="preset-status"[^>]*aria-live="polite"/.test(htmlSrc));
ok('category strip is a tablist', /id="sheet-cats"[^>]*role="tablist"/.test(htmlSrc));
ok('name input has an associated label', /<label class="cfg-row" for="preset-name">/.test(htmlSrc));
ok('category select has an associated label', /<label class="cfg-row" for="preset-cat">/.test(htmlSrc));

section('3. Styling');
ok('.preset-item styled', /\.preset-item\s*\{/.test(cssSrc));
ok('AI rows are visually distinguished', /\.preset-item\.is-ai/.test(cssSrc));
ok('active category chip styled', /\.sheet-cat\.active/.test(cssSrc));
ok('preset name input is styled (text inputs were unstyled before)',
  /\.cfg-row input\[type="text"\]\s*\{/.test(cssSrc));
ok('captured-value list is scroll-capped (a pose can be dozens of params)',
  /\.preset-values[\s\S]{0,160}max-height/.test(cssSrc));
ok('long preset names are ellipsized, not overflowing the sidebar',
  /\.p-name[\s\S]{0,200}text-overflow:\s*ellipsis/.test(cssSrc));
ok('interactive sheet controls have focus-visible outlines',
  /\.sheet-cat:focus-visible/.test(cssSrc) && /\.p-act:focus-visible/.test(cssSrc));
ok('destructive action has its own hover color', /\.p-act\.danger:hover/.test(cssSrc));
ok('estimated-range warning has a style hook', /\.sheet-warn/.test(cssSrc));

section('4. XSS / injection safety');
// Preset names come from a hand-editable sheets/*.json and from LLM output.
// Comments are stripped first: the pane explains its own no-innerHTML rule in
// prose, and matching that sentence would make this assertion self-defeating.
const sheetCode = sheetBlock
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok('sheet pane never assigns innerHTML', !/innerHTML/.test(sheetCode),
  'all painting via createElement + textContent');
ok('painting uses textContent', /\.textContent\s*=/.test(sheetBlock));
ok('rows are built with createElement', /document\.createElement\(/.test(sheetBlock));

section('5. Preset list behavior');
ok('list is built from resolvePresets() (user > ai precedence)',
  /resolvePresets\(sheet, sheetCatFilter\)/.test(sheetBlock));
ok('category counts also come from resolvePresets()',
  /resolvePresets\(sheet, cat\)\.length/.test(sheetBlock));
ok('AI entries are detected by source, not by a UI flag',
  /const isAI = p\.source === 'ai'/.test(sheetBlock));
ok('AI rows are badged 🤖', /🤖/.test(sheetBlock));
ok('user rows are badged distinctly', /'👤'/.test(sheetBlock));
ok('a shadowed AI suggestion is labelled as covered',
  /p\.suggestion \? '🤖 tertutup'/.test(sheetBlock));
ok('auto-renamed presets explain themselves via tooltip',
  /p\.renamedFrom/.test(sheetBlock));

section('6. AI suggestions cannot be applied directly');
// The whole point of the .ai branch: a suggestion is inert until approved.
const aiBranch = sheetBlock.slice(sheetBlock.indexOf('} else {'), sheetBlock.indexOf('box.appendChild(row);'));
ok('AI row offers Pakai (promote), not Terap (apply)',
  /'Pakai'/.test(aiBranch) && !/applyPreset\(/.test(aiBranch));
ok('promotion goes through applyAISuggestion()',
  /applyAISuggestion\(p\.category, p\.name\)/.test(aiBranch));
ok('Terap/Edit/Hapus are only offered on user presets',
  /if \(!isAI\) \{/.test(sheetBlock));
ok('a failed promotion re-enables the button (gerak name collision)',
  /useBtn\.disabled = false/.test(aiBranch));

section('7. Delete / edit path');
ok('delete asks for confirmation first', /confirm\('Hapus preset/.test(sheetBlock));
ok('delete calls deleteUserPreset()', /deleteUserPreset\(p\.category, p\.name\)/.test(sheetBlock));
ok('edit copies values instead of referencing the stored preset',
  /Object\.assign\(\{\}, p\.values \|\| \{\}\)/.test(sheetBlock),
  'editing the draft must not mutate the sheet');
ok('edit also copies parts', /Object\.assign\(\{\}, p\.parts \|\| \{\}\)/.test(sheetBlock));

section('8. Pose capture');
const capSrc = extractFn(sheetBlock, 'captureCurrentPose');
ok('captureCurrentPose() exists', !!capSrc);
if (capSrc) {
  ok('capture refuses without a sheet', /Belum ada sheet/.test(capSrc));
  ok('capture refuses without a loaded model', /Load model dulu/.test(capSrc));
  ok('only non-default params are captured (idle/blink must survive)',
    /Math\.abs\(cur - def\) > 1e-3/.test(capSrc));
  ok('params and parts are kept in separate bags',
    /const values = \{\}/.test(capSrc) && /const parts = \{\}/.test(capSrc),
    'different engine calls: setParameterValueById vs setPartOpacityById');
  ok('part opacity is read via the Cubism part accessor',
    /getPartOpacityById/.test(capSrc));
  ok('values are rounded to 3dp (no float noise in the sheet)',
    /toFixed\(3\)/.test(capSrc));
  ok('unreadable parts are skipped, not stored as 0',
    /if \(cur === null \|\| !Number\.isFinite\(cur\)\) continue/.test(capSrc));
}

section('9. Save path');
ok('save requires a name', /nama preset wajib diisi/.test(sheetBlock));
ok("'gerak' is refused by this editor (needs keyframes, not a frozen pose)",
  /kategori gerak butuh keyframe/.test(sheetBlock));
ok('save refuses an empty draft', /belum ada nilai/.test(sheetBlock));
ok('save routes through saveUserPreset() (single validation path)',
  /await saveUserPreset\(\{/.test(sheetBlock));
ok('save button is disabled while saving (no double-submit)',
  /shEls\.save\.disabled = true/.test(sheetBlock) && /shEls\.save\.disabled = false/.test(sheetBlock));
ok('save errors reach the user', /setPresetStatus\('gagal: ' \+ e\.message, 'err'\)/.test(sheetBlock));
ok('list jumps to the saved category so the result is visible',
  /sheetCatFilter = saved\.category/.test(sheetBlock));
ok('gerak name collision is pre-flighted while typing',
  /checkGerakName\(nm, state\.lastSheet\)/.test(sheetBlock));
ok('the pre-flight surfaces the suggested alternative name',
  /chk\.suggestion/.test(sheetBlock));

section('10. Analyze button');
// Fase 3 replaced the single sequential await with two independent analyses:
// parameter labelling (classify-params) and preset suggestions (analyze-sheet).
// Assertions updated to match — the failure-isolation property is the point.
ok('analyze dispatches parameter labelling',
  /triggerAIParamClassification\(\)/.test(sheetBlock));
ok('analyze dispatches preset suggestions',
  /analyzeSheetPresets\(\)/.test(sheetBlock));
ok('the two analyses are isolated via allSettled', /Promise\.allSettled/.test(sheetBlock),
  'one failing must not deny the other its result');
ok('analyze reports the preset suggestion count',
  /presets\.value && presets\.value\.count/.test(sheetBlock));
ok('analyze reports the labelled parameter count',
  /labels\.value && labels\.value\.count/.test(sheetBlock));
ok('each failure is attributed to its own analysis',
  /preset gagal: ' \+ presets\.reason\.message/.test(sheetBlock) &&
  /label gagal: ' \+ labels\.reason\.message/.test(sheetBlock));
ok('analyze button is disabled while running',
  /shEls\.analyze\.disabled = true/.test(sheetBlock));
ok('analyze button is always re-enabled',
  /finally \{[\s\S]{0,120}shEls\.analyze\.disabled = false/.test(sheetBlock),
  'an early return would leave the button permanently dead');

section('11. triggerAIParamClassification() is callable with no args');
const trig = extractFn(appSrc, 'triggerAIParamClassification');
ok('function exists', !!trig);
if (trig) {
  ok('derives the sheet when called without one', /sheet = state\.lastSheet \|\| loadCharacterSheet\(\)/.test(trig));
  ok('throws a clear error when there is no sheet at all',
    /throw new Error\('Belum ada sheet/.test(trig));
  ok('defaults classified to sheet.params', /classified = sheet\.params \|\| \[\]/.test(trig));
  ok('defaults roleIds to sheet.roleIds', /roleIds = sheet\.roleIds \|\| \{\}/.test(trig));
  ok('returns a count for the UI', /return \{ count: items\.length/.test(trig));
  ok('a non-OK response is an error now, not a silent return',
    /throw new Error\('server menolak/.test(trig));
  ok('errors are rethrown so the UI can report them', /throw e;/.test(trig));
  // The LLM is only allowed to add semantic meaning. Ranges come from Cubism.
  ok('LLM cannot overwrite min/max/def',
    !/pObj\.min\s*=/.test(trig) && !/pObj\.max\s*=/.test(trig) && !/pObj\.def\s*=/.test(trig));
  ok('unknown parameter ids from the LLM are dropped', /if \(!pObj\) continue/.test(trig));
  ok('AI grouping stays in paramGroups.ai, not pObj.group',
    /sheet\.paramGroups\.ai\[item\.id\]/.test(trig) && !/pObj\.group\s*=/.test(trig));
}
ok('the fire-and-forget caller has a .catch (function now throws)',
  /triggerAIParamClassification\(sheet, classified, roleIds\)\s*\n\s*\.catch\(/.test(appSrc),
  'otherwise a failed classify is an unhandled rejection');

section('12. Repaint follows the model');
ok('refreshSheetUI hook is declared at module scope',
  /let refreshSheetUI = \(\) => \{\};/.test(appSrc));
ok('hook is assigned inside wireUI', /refreshSheetUI = \(\) => \{/.test(sheetBlock));
ok('painted once on wire-up', /refreshSheetUI\(\);/.test(sheetBlock));
ok('loadModel() repaints the sheet pane on model swap',
  /try \{ refreshSheetUI\(\); \} catch \(e\) \{ console\.warn\('\[sheet\] UI refresh failed/.test(appSrc),
  'else Terap/Hapus could hit the previous model');
ok('re-inspection repaints too', /try \{ refreshSheetUI\(\); \} catch \(e\) \{\}/.test(appSrc));
ok('repaint reads live state first, storage second',
  /const sheet = state\.lastSheet \|\| loadCharacterSheet\(\);/.test(sheetBlock));

section('13. Exposed API surface used by the pane exists');
for (const fn of ['saveUserPreset', 'deleteUserPreset', 'applyAISuggestion',
  'resolvePresets', 'checkGerakName', 'applyPreset', 'loadCharacterSheet']) {
  ok(fn + '() is defined in app.js', new RegExp('function ' + fn + '\\(').test(appSrc));
}
ok('window.__live2dAgent.sheet namespace is exported', /sheet:\s*\{/.test(appSrc));

section('14. Draft state isolation');
ok('draft keeps params and parts separate',
  /let draft = \{ values: \{\}, parts: \{\} \}/.test(sheetBlock));
ok('clear resets both bags',
  /draft = \{ values: \{\}, parts: \{\} \};/.test(sheetBlock));
ok('list filter is independent of the editor category dropdown',
  /let sheetCatFilter = 'emosi'/.test(sheetBlock),
  'browsing gerak while authoring emosi must not fight the user');

section('15. Summary panel honesty');
ok('estimated ranges are warned about, not hidden',
  /sheet\.rangesEstimated/.test(sheetBlock));
ok('the warning names the provenance', /sheet\.rangeSource/.test(sheetBlock));
ok('schema version is shown', /'Skema', 'v'/.test(sheetBlock));
ok('a missing sheet points the user at Inspeksi Model',
  /Inspeksi Model/.test(sheetBlock));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
