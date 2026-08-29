# CRITICAL UI & FLOW CONSTRAINTS

> Diporting dari `docs/CRITICAL UI & FLOW CONSTRAINTS.md` repo v1. Aturannya
> tetap mengikat di v2 — malah lebih relevan, karena keputusan hybrid v2
> (mempertahankan `static/js/app.js` persis v1) berdiri di atas pagar ini.
> Referensi file sudah diperbarui ke layout v2.

## DO NOT REDESIGN THE EXISTING APPLICATION

The existing UI and user flow are already established and must be preserved.

The Motion Studio feature is an ADDITIVE feature.

Do NOT redesign, restructure, replace, or remove the existing UI.

Do NOT change:

- existing navigation
- existing chat interface
- existing model loading flow
- existing character selection flow
- existing settings flow
- existing preset UI
- existing emotion UI
- existing gesture UI
- existing response rendering
- existing buttons
- existing layouts
- existing terminology
- existing user workflow

unless a change is absolutely required for Motion Studio integration.

If an integration point is required, make the smallest possible change.

---

# 1. Existing UI Is The Source Of Truth

Before modifying any UI:

1. Inspect the current application.
2. Identify existing navigation and panels.
3. Identify the current preset/gesture/emotion workflow.
4. Identify the current chat → LLM → animation flow.
5. Identify existing reusable UI components.
6. Reuse existing styles, components, buttons, dialogs, panels, and layout conventions.

Do NOT create a new visual design system unless the existing application has no suitable component.

The Motion Studio must visually belong to the existing application.

It must NOT look like a separate unrelated application.

---

# 2. Motion Studio Must Be An Additive Feature

The preferred integration is:

```text
EXISTING APPLICATION
        │
        ├── Existing UI
        ├── Existing Chat
        ├── Existing Emotion System
        ├── Existing Gesture System
        └── NEW: Motion Studio
```

Motion Studio should be accessible through an additional entry point (tab 🎬 Motion).

Do NOT replace an existing section.

Do NOT move existing controls unless necessary.

---

# 3. Existing Chat Flow Must Remain Identical

The current user flow:

```text
User → Chat → LLM → Response → Emotion / Gesture → Live2D
```

must continue working exactly as before.

Motion Studio extends this flow internally:

```text
User → Chat → LLM → Response → Emotion / Gesture / Motion → Motion Runtime → Live2D
```

The user should NOT be forced to open Motion Studio before chatting.

The user should NOT have to manually select a motion for normal conversations.

The LLM integration must remain transparent.

---

# 4. Existing Gesture System Must Remain Compatible

Do NOT delete or replace the existing gesture system.

Existing gestures such as:

```text
nod
shake
tilt_curious
lean_excited
recoil_surprised
look_away_shy
laugh_bounce
think
wave_hi
```

must continue to work.

Motion Registry wraps/exposes them internally (`registerGestureLibrary`,
`src/client/animation/motion-registry.ts`).

This is an architectural integration, not a UI migration.

Existing calls such as:

```js
playGesture("wave_hi")
```

must continue working unless there is a compelling reason to internally route them through the new Motion Runtime.

If routing them through the new runtime, preserve the existing public behavior.

---

# 5. Existing Native Motion System Must Remain

Do NOT remove or replace:

- `.motion3.json`
- motion taxonomy (`static/js/motion-taxonomy.js`)
- native motion groups
- model motion discovery
- existing motion playback

The Motion Registry consumes these systems.

Conceptually:

```text
Existing Native Motion → Motion Registry → Motion Runtime
```

NOT:

```text
Existing Native Motion → DELETE → New Motion System
```

---

# 6. Existing Presets Must Remain

Existing preset systems must continue working.

Do not migrate or rewrite existing presets unless explicitly necessary.

Existing:

```text
emotion presets
property presets
accessory presets
gesture presets
AI presets
user presets
```

must remain functional.

The Motion Studio creates a new Motion Asset format, but it must not silently convert or destroy old assets.

---

# 7. Backward Compatibility Is Mandatory

The following must remain valid:

### Existing LLM response

```json
{
  "text": "Halo!",
  "emotion": "senang",
  "gesture": "wave_hi",
  "intensity": 0.8
}
```

### New optional format

```json
{
  "text": "Halo!",
  "actions": [
    { "type": "emotion", "id": "senang", "intensity": 0.8 },
    { "type": "motion",  "id": "wave_hi", "intensity": 0.9 }
  ]
}
```

Normalize both internally.

Do NOT force an immediate migration of the existing LLM protocol.

---

# 8. Do Not Change Existing Visual Style

The Motion Studio must reuse:

- existing colors
- existing typography
- existing spacing
- existing border radius
- existing panel style
- existing buttons
- existing icons where available
- existing dark/light theme behavior
- existing responsive behavior

Do not introduce a completely new CSS framework.

Do not rewrite the entire stylesheet.

Do not rename existing CSS classes unnecessarily.

---

# 9. Motion Studio Should Be Isolated

In v2 the motion core lives as TypeScript, bundled before `app.js`:

```text
src/client/animation/motion-dsl.ts        → static/js/bundle.js
src/client/animation/motion-registry.ts   → static/js/bundle.js
src/client/animation/motion-runtime.ts    → static/js/bundle.js
src/client/agent/{brain,directive-parser}.ts → static/js/bundle.js
static/js/motion-editor.js                (isolated, legacy parity)
```

The bridge is `window.MotionDSL` / `window.MotionRegistry` /
`window.MotionRuntime` / `window.__agent`, installed by
`src/client/bundle-entry.ts` and consumed by `static/js/app.js` +
`static/js/motion-editor.js`.

Only add minimal integration code to existing files.

Avoid putting Motion Studio implementation into `app.js`.

Keep the new feature modular.

---

# 10. Existing Runtime Behavior Has Priority

If the new Motion Runtime conflicts with existing animation behavior:

DO NOT immediately rewrite the existing behavior.

First identify:

1. what currently owns the parameter
2. why it is being written
3. whether the new runtime can integrate with that owner
4. whether an adapter is sufficient

Preserve working behavior wherever possible.

The Motion Runtime should gradually become the common execution layer rather than forcing a risky rewrite.

---

# 11. UI Changes Require Justification

Before changing any existing UI element, ask:

> Is this change strictly necessary for Motion Studio?

If NO: do not change it.

If YES: make the smallest possible modification.

Example:

GOOD:

```text
Existing Tools
    ├── Existing Tool A
    ├── Existing Tool B
    └── Motion Studio  ← new
```

BAD:

```text
New redesigned navigation
New sidebar
New dashboard
New chat layout
New settings layout
```

The latter is explicitly prohibited.

---

# 12. Motion Studio Entry Point

Use the least invasive integration point available.

### Preferred

Add a single `Motion Studio` tab/button inside the existing tab bar, opening through patterns the application already has (panel/modal).

### Only if necessary

Create a dedicated panel/page.

Even then, preserve the application's existing header, navigation, theme, and visual language.

---

# 13. Existing User Flow Must Remain Possible

A user who does not care about Motion Studio should be able to use the application exactly as before.

This is a critical acceptance criterion.

```text
Open application → Load model → Chat → AI responds → Character animates
```

must still work without ever opening Motion Studio.

Motion Studio is an advanced capability, not a required step.

---

# 14. No Forced Migration

Do NOT require the user to:

- recreate gestures
- recreate emotions
- recreate presets
- reconfigure models
- regenerate character sheets
- change LLM prompts manually
- manually import existing motions

The new system should discover/adapt existing capabilities where possible.

---

# 15. Implementation Rule

Before coding:

### STEP 1 — Audit

Inspect the repository and document current entry points, navigation, preset/gesture/motion systems, LLM response format, animation execution path, model capability system.

### STEP 2 — Integration Plan

Identify the smallest set of files that need modification.

### STEP 3 — Implement Core

Build DSL / Registry / Runtime without changing the UI. (In v2: `src/client/animation/*.ts`.)

### STEP 4 — Integrate Existing Systems

Connect existing gestures, native motions, taxonomy, presets to the runtime.

### STEP 5 — Add Motion Studio UI

Add Motion Studio as an isolated feature. (`static/js/motion-editor.js`.)

### STEP 6 — Integrate LLM

Make new motions discoverable to the LLM. (`catalogForLLM`, prompt di `src/client/agent/brain.ts`.)

### STEP 7 — Regression Test

Verify that all existing user flows still work.

---

# 16. Explicit Prohibited Actions

Unless explicitly requested by the user, DO NOT:

- redesign the application
- replace the current UI
- rewrite `static/js/app.js` piecemeal without parity locks (when porting it to TS, port it WHOLE and keep behavior byte-faithful — see README §Status rewrite)
- rewrite the entire animation engine
- replace the current preset system
- remove the current gesture library
- remove native `.motion3.json` support
- change the current chat workflow
- change the LLM provider
- change the current model loading workflow
- change existing terminology
- migrate all existing assets
- introduce a new framework unnecessarily
- break backward compatibility

---

# 17. Final Acceptance Test

The implementation is NOT considered successful if Motion Studio works but existing functionality changes unexpectedly.

The final application must satisfy:

```text
Existing UI (unchanged) → Existing application
    ├── existing chat works
    ├── existing presets work
    ├── existing gestures work
    ├── existing motions work
    ├── existing models work
    └── existing LLM flow works
       +
NEW: Motion Studio → Motion Registry → Motion Runtime → LLM can use new motions
```

The goal is:

> **Add a powerful Motion Studio without making the existing application feel like a different application.**
