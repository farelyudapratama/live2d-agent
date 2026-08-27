// Fase 1 tests — userNote editor UI + persistence path.
//
// sanitizeUserNote() is extracted and run for real (vm sandbox); the DOM/fetch
// wiring is asserted structurally against the source, since there is no DOM here.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
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

section('1. Markup');
ok('textarea #input-user-note exists', /id="input-user-note"/.test(htmlSrc));
ok('save button #btn-save-note exists', /id="btn-save-note"/.test(htmlSrc));
ok('status element #note-status exists', /id="note-status"/.test(htmlSrc));
ok('status is a live region (screen readers announce saves)',
  /id="note-status"[^>]*aria-live="polite"/.test(htmlSrc));
ok('status has role=status', /id="note-status"[^>]*role="status"/.test(htmlSrc));
ok('textarea is described by the hint text',
  /id="input-user-note"[\s\S]{0,220}aria-describedby="note-hint"/.test(htmlSrc));
ok('hint element carries the referenced id', /id="note-hint"/.test(htmlSrc));
ok('div tags balance',
  (htmlSrc.match(/<div\b/g) || []).length === (htmlSrc.match(/<\/div>/g) || []).length,
  (htmlSrc.match(/<div\b/g) || []).length + ' open');
ok('note panel lives in the Model pane (per-model setting)',
  htmlSrc.indexOf('input-user-note') > htmlSrc.indexOf('data-pane="model"') &&
  htmlSrc.indexOf('input-user-note') < htmlSrc.indexOf('data-pane="ai"'));

section('2. Styling / focus visibility');
ok('.note-box textarea is styled', /\.note-box textarea\s*\{/.test(cssSrc));
ok('textarea has a visible focus-visible outline',
  /\.note-box textarea:focus-visible/.test(cssSrc));
ok('save button has a visible focus-visible outline',
  /#btn-save-note:focus-visible/.test(cssSrc));
ok('ok/err status colors defined',
  /\.note-status\.ok/.test(cssSrc) && /\.note-status\.err/.test(cssSrc));
ok('textarea uses box-sizing so it cannot overflow the sidebar',
  /\.note-box textarea[\s\S]{0,200}box-sizing:\s*border-box/.test(cssSrc));

section('3. sanitizeUserNote() behavior');
const sanSrc = extractFn(appSrc, 'sanitizeUserNote');
const capMatch = appSrc.match(/const MAX_USER_NOTE\s*=\s*(\d+)/);
ok('MAX_USER_NOTE is declared', !!capMatch, capMatch ? capMatch[1] : 'missing');
ok('sanitizeUserNote() exists', !!sanSrc);

if (sanSrc && capMatch) {
  const CAP = Number(capMatch[1]);
  const sb = { MAX_USER_NOTE: CAP };
  vm.createContext(sb);
  vm.runInContext(sanSrc + '\nthis.s = sanitizeUserNote;', sb);
  const s = sb.s;

  ok('null becomes empty string', s(null) === '');
  ok('undefined becomes empty string', s(undefined) === '');
  ok('plain text passes through', s('dia pemalu') === 'dia pemalu');
  ok('newlines are PRESERVED (formatting matters in prose)',
    s('baris satu\nbaris dua') === 'baris satu\nbaris dua');
  ok('tabs are preserved', s('a\tb') === 'a\tb');
  ok('NUL is stripped', s('a\u0000b') === 'ab');
  ok('bell/backspace control chars stripped', s('a\u0007\u0008b') === 'ab');
  ok('DEL is stripped', s('a\u007Fb') === 'ab');
  ok('ESC is stripped (no terminal escape sequences)', s('a\u001Bb') === 'ab');
  ok('carriage return is normalized to newline (CRLF paste)', s('a\r\nb') === 'a\nb');
  ok('lone CR becomes a newline', s('a\rb') === 'a\nb');
  ok('over-cap input is truncated to the cap', s('x'.repeat(CAP + 500)).length === CAP,
    'len=' + s('x'.repeat(CAP + 500)).length);
  ok('exactly-at-cap input is untouched', s('y'.repeat(CAP)).length === CAP);
  // Truncating UTF-16 at a fixed index can slice an emoji in half.
  const emojiNote = 'z'.repeat(CAP - 1) + '🐱';
  const cut = s(emojiNote);
  ok('truncation never leaves a broken surrogate half',
    !/[\uD800-\uDBFF]$/.test(cut) && cut.length <= CAP,
    'len=' + cut.length + ', ends with lone surrogate: no');
  ok('a number is coerced, not crashed', s(42) === '42');
  ok('an object is coerced to a string', typeof s({ a: 1 }) === 'string');
  ok('unicode/emoji survive', s('だいすき 🐱') === 'だいすき 🐱');
  // Markup is NOT escaped here on purpose: the note goes into a textarea .value
  // and into a JSON prompt body, never into innerHTML.
  ok('angle brackets are left intact (not double-escaped)',
    s('<b>hi</b>') === '<b>hi</b>');
}

section('4. Persistence wiring');
ok('saveUserNote() exists', /async function saveUserNote\(/.test(appSrc));
ok('note is stored inside the character sheet, not a separate key',
  /sheet\.userNote\s*=\s*note/.test(appSrc));
ok('save stamps the current schemaVersion',
  /sheet\.schemaVersion\s*=\s*SHEET_SCHEMA_VERSION/.test(appSrc));
ok('save writes localStorage', /localStorage\.setItem\(characterSheetKey\(\), JSON\.stringify\(sheet\)\)/.test(appSrc));
ok('save POSTs to /api/sheet', /fetch\(API \+ '\/api\/sheet'/.test(appSrc));
const saveBlock = appSrc.slice(appSrc.indexOf('async function saveUserNote('),
  appSrc.indexOf('async function refreshUserNoteUI('));
ok('localStorage write happens BEFORE the network write',
  saveBlock.indexOf('localStorage.setItem') < saveBlock.indexOf("fetch(API + '/api/sheet'"),
  'local-first, survives server failure');
ok('a missing sheet is created rather than dropping the note',
  /sheet = inspectModel\(\)/.test(saveBlock));
ok('saving with no model loaded raises a clear error',
  /Load model dulu sebelum menyimpan catatan/.test(saveBlock));
ok('server failure is surfaced, not swallowed',
  /throw new Error\(detail\.error/.test(saveBlock));
ok('agent capability cache is invalidated after save',
  /invalidateCapabilityProfile/.test(saveBlock));

section('5. UI refresh follows the model');
ok('refreshUserNoteUI() exists', /async function refreshUserNoteUI\(/.test(appSrc));
ok('loadModel() refreshes the note textarea',
  /refreshUserNoteUI\(\)\.catch/.test(appSrc));
ok('re-inspection refreshes the textarea from persisted state',
  /refreshUserNoteUI\(\);/.test(appSrc));
ok('save button is disabled while saving (no double-submit)',
  /noteBtn\.disabled = true/.test(appSrc) && /noteBtn\.disabled = false/.test(appSrc));
ok('save errors reach the user via the status line',
  /setNoteStatus\('gagal: ' \+ e\.message, 'err'\)/.test(appSrc));
ok('Ctrl/Cmd+Enter saves', /\(ev\.ctrlKey \|\| ev\.metaKey\) && ev\.key === 'Enter'/.test(appSrc));
ok('textarea is corrected to the sanitized value after save',
  /if \(saved !== noteBox\.value\) noteBox\.value = saved/.test(appSrc));

section('6. Prompt injection into the LLM');
ok('agent reads userNote from the capability profile',
  /capProfile\.userNote/.test(agentSrc));
ok('note block is only added when a note exists', /const noteBlock = note \? `/.test(agentSrc));
ok('note is trimmed before use', /\.userNote\.trim\(\)/.test(agentSrc));
ok('note is delimited with explicit begin/end markers',
  /awal catatan/.test(agentSrc) && /akhir catatan/.test(agentSrc));
ok('note is labelled as descriptive data, not instructions',
  /DATA DESKRIPTIF, bukan instruksi teknis/.test(agentSrc));
const capBlockIdx = agentSrc.indexOf('${noteBlock}');
const emotionIdx = agentSrc.indexOf('=== DAFTAR EMOSI ===');
ok('note appears BEFORE the directive format spec',
  capBlockIdx !== -1 && emotionIdx !== -1 && capBlockIdx < emotionIdx,
  'directives stated last, so they win');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
