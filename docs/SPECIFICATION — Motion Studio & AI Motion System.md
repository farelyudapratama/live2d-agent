Sebelum mengubah kode, audit dulu repository dan buat implementation plan berdasarkan SPEC ini. Jangan langsung implement. Identifikasi file yang harus diubah, API yang sudah ada, potensi konflik dengan gesture/taxonomy/LLM system, lalu setelah itu implementasikan secara bertahap

# SPECIFICATION — Motion Studio & AI Motion System

## 0. Role

You are an expert frontend/backend engineer specializing in:

- Live2D Cubism / Live2D Web rendering
- animation timelines
- keyframe interpolation
- animation state machines
- AI/LLM tool integration
- JavaScript/Node.js applications
- UX for creative tools

Your task is to implement a **Motion Studio / Motion Editor** and integrate it into the existing Live2D AI character application.

Do NOT rewrite the existing application from scratch.

First inspect and understand the existing architecture, especially:

- `index.html`
- `js/app.js`
- `agent.js`
- `server.js`
- `js/motion-taxonomy.js`
- existing character sheet / preset system
- existing gesture system
- existing LLM animation/directive pipeline

The current application already has:

- semantic emotions
- gesture presets
- native `.motion3.json` discovery
- motion taxonomy
- model capability detection
- model-agnostic parameter roles
- LLM-generated response segments
- emotion/gesture/intensity directives
- motion playback guards
- AI pose system
- micro-gesture scheduler

Preserve these systems and extend them instead of creating parallel incompatible systems.

---

# 1. Main Goal

Build a system where the user can visually create/edit motions and then make those motions available to the LLM.

The final architecture should be:

USER
 ↓
CHAT / LLM
 ↓
AI MOTION DIRECTOR
 ↓
MOTION REGISTRY
 ↓
MOTION SCHEDULER
 ↓
MOTION RUNTIME
 ↓
LIVE2D MODEL

The LLM must NOT directly manipulate Live2D parameter IDs.

The LLM should only select semantic motion IDs and high-level properties.

Example:

```json
{
  "text": "Halo semuanya!",
  "actions": [
    {
      "type": "emotion",
      "id": "senang",
      "intensity": 0.8
    },
    {
      "type": "motion",
      "id": "wave_hi",
      "intensity": 0.9
    }
  ]
}
```

The runtime translates semantic actions into actual model animation.

---

# 2. Core Design Principle

Create a new abstraction:

## Motion Asset

A Motion Asset is a model-independent semantic animation definition.

It may be backed by:

1. user-created keyframes
2. an existing native `.motion3.json`
3. a procedural gesture
4. a combination of multiple motions
5. future AI-generated animation

All of these must appear to the LLM as the same thing:

```text
motion ID
description
tags
emotion compatibility
duration
intensity range
availability
```

---

# 3. Do NOT expose raw Live2D parameters to the LLM

Bad:

```json
{
  "ParamAngleX": -12,
  "ParamAngleY": 8,
  "ParamEyeBallX": -0.2
}
```

Good:

```json
{
  "type": "motion",
  "id": "think",
  "intensity": 0.7
}
```

The semantic layer must use role names such as:

```text
angleX
angleY
eyeX
eyeY
bodyX
bodyY
bodyZ
mouthForm
```

The existing model-role resolution system should translate these into actual parameter IDs.

Never assume that different Live2D models use the same parameter IDs.

---

# 4. Motion Studio UI

Add a dedicated Motion Studio interface.

The interface should feel like a lightweight professional animation editor rather than a debug panel.

Suggested structure:

```text
┌─────────────────────────────────────────────────────────────┐
│ Motion Studio                         Preview  Save  Test  │
├─────────────────┬───────────────────────────────────────────┤
│ Motion Library  │                                           │
│                 │               LIVE2D PREVIEW              │
│ + New Motion    │                                           │
│                 │                    MODEL                  │
│ wave_hi         │                                           │
│ think           │                                           │
│ laugh           │                                           │
│ shy             │                                           │
│ surprised       │                                           │
│                 │                                           │
├─────────────────┴───────────────────────────────────────────┤
│ Timeline                                                    │
│                                                             │
│ 0s       0.5s       1s       1.5s       2s                 │
│ │────────│──────────│────────│─────────│                   │
│                                                             │
│ Head X       ●────────●────────────●                       │
│ Head Y       ────●────────────●──────                       │
│ Body Z       ───────●──────────────●                        │
│ Eye X        ●────────────────────────                       │
│ Eye Y        ───●────────────────────                       │
│ Smile        ─────────●────────●──────                       │
└─────────────────────────────────────────────────────────────┘
```

Do not make the UI overly complicated initially.

Prioritize:

- clarity
- responsive preview
- easy keyframe editing
- playback
- save/load
- semantic metadata
- AI compatibility

---

# 5. Motion Editor Modes

The editor must support two levels.

## 5.1 Semantic Mode

Primary/default mode.

Expose:

### Head

- Turn X
- Turn Y
- Tilt/Z

### Eyes

- Look X
- Look Y

### Body

- Lean X
- Lean Y
- Rotation

### Face

- Smile
- Mouth Open
- Eye openness where supported
- Brow where supported

### Energy

- Bounce
- movement amplitude

These are abstract semantic roles.

---

## 5.2 Advanced Mode

Allow advanced users to inspect actual resolved parameters.

Example:

```text
Semantic Role      Actual Parameter

angleX             ParamAngleX
angleY             ParamAngleY
bodyZ              ParamBodyAngleZ
eyeX               ParamEyeBallX
eyeY               ParamEyeBallY
```

Advanced mode is optional and must never be required for normal motion creation.

---

# 6. Timeline

Implement a lightweight keyframe timeline.

Each track represents one semantic property.

Example:

```json
{
  "target": "angleY",
  "keys": [
    { "t": 0.0, "v": 0 },
    { "t": 0.3, "v": -8 },
    { "t": 0.8, "v": -5 },
    { "t": 1.2, "v": 0 }
  ]
}
```

Required operations:

- add keyframe
- delete keyframe
- move keyframe
- edit value
- edit timestamp
- duplicate keyframe
- scrub timeline
- play
- pause
- stop
- loop
- change duration

Use smooth interpolation.

Prefer:

- linear
- ease-in
- ease-out
- ease-in-out

The editor must not cause abrupt parameter snapping unless the user explicitly selects stepped interpolation.

---

# 7. Motion File Format

Create an internal motion format.

Suggested:

```text
motions/
  <model>/
    catalog.json
    wave_hi.motion.json
    think.motion.json
    laugh.motion.json
```

Example:

```json
{
  "version": 1,
  "id": "wave_hi",
  "name": "Wave Hi",

  "description": "Melambaikan tangan dengan ceria.",

  "tags": [
    "greeting",
    "hello",
    "goodbye",
    "friendly",
    "happy"
  ],

  "duration": 1.4,

  "loop": false,

  "intensity": {
    "min": 0.3,
    "max": 1.0,
    "default": 0.8
  },

  "emotionCompatibility": {
    "senang": 1.0,
    "normal": 0.7,
    "malu": 0.3,
    "sedih": 0.1
  },

  "tracks": [
    {
      "target": "angleX",
      "keys": [
        { "t": 0, "v": 0 },
        { "t": 0.3, "v": 5 },
        { "t": 0.6, "v": -5 },
        { "t": 0.9, "v": 5 },
        { "t": 1.2, "v": -3 },
        { "t": 1.4, "v": 0 }
      ]
    }
  ]
}
```

Keep the format extensible.

---

# 8. Motion Registry

Create a central registry.

Example API:

```js
motionRegistry.register(asset);

motionRegistry.get("wave_hi");

motionRegistry.has("wave_hi");

motionRegistry.list();

motionRegistry.search({
  tags: ["greeting", "happy"]
});
```

The registry should combine:

1. user motions
2. native `.motion3.json` motions
3. built-in gestures
4. future generated motions

Each asset should have:

```text
id
name
description
source
tags
duration
emotionCompatibility
intensityRange
cooldown
priority
capabilities
```

Example:

```json
{
  "id": "wave_hi",
  "source": "user",
  "tags": ["greeting", "happy"],
  "duration": 1.4,
  "cooldown": 3000,
  "priority": 50
}
```

---

# 9. Native `.motion3.json` Integration

Do NOT replace the existing motion taxonomy.

The current application already discovers and classifies native motion clips.

Keep that mechanism.

Native clips should be converted into registry entries such as:

```json
{
  "id": "native:Happy_01",
  "source": "native",
  "type": "motion3",
  "description": "Native Live2D motion",
  "duration": 2.1
}
```

If semantic information can be inferred from taxonomy, attach it.

Example:

```json
{
  "tags": ["happy"],
  "semanticVerb": "bounce"
}
```

The existing taxonomy system should remain the authoritative discovery mechanism for native motion clips.

---

# 10. Built-in Gesture Integration

Existing gesture library entries such as:

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

must NOT be duplicated unnecessarily.

Instead, expose them through the Motion Registry as procedural/built-in Motion Assets.

For example:

```json
{
  "id": "wave_hi",
  "source": "builtin",
  "type": "gesture"
}
```

If an existing user preset has the same semantic name, follow the existing precedence rules rather than silently overwriting it.

Preserve the current reserved-name protection.

---

# 11. Motion Runtime

Create:

```text
js/motion-runtime.js
```

This should become the single runtime interface for animation playback.

Suggested API:

```js
motion.play("wave_hi", {
  intensity: 0.8
});
```

```js
motion.stop("wave_hi");
```

```js
motion.stopAll();
```

```js
motion.isPlaying("wave_hi");
```

```js
motion.getActive();
```

```js
motion.listAvailable();
```

Do not let unrelated parts of the application directly manipulate motion state whenever possible.

---

# 12. Motion Scheduler

Create a scheduler to prevent multiple systems from fighting over the same parameters.

Priority example:

```text
100  manual user control
 90  native motion clip
 80  explicit LLM motion
 60  gesture
 40  emotion
 20  idle/fidget
 10  breathing
```

These values are conceptual and may be adjusted during implementation.

The scheduler must understand ownership.

Example:

```text
Native motion playing
        ↓
native motion owns head/body parameters
        ↓
AI pose must not fight it
```

The existing application already implements a clip-playing guard because simultaneous writers create twitching/fighting behavior. Preserve and generalize this behavior. 
---

# 13. Blending

Motion transitions must be smooth.

Support:

```js
motion.play("wave_hi", {
  intensity: 0.8,
  blendIn: 200,
  blendOut: 300
});
```

Do not snap directly from:

```text
idle → motion → idle
```

Prefer:

```text
idle
  \
   \____ motion
          \
           \____ idle
```

---

# 14. Intensity

Intensity must scale the semantic motion.

For example:

```text
wave_hi @ 0.3
```

should be subtle.

```text
wave_hi @ 1.0
```

should be energetic.

Do not simply multiply every parameter blindly.

The system should support per-track scaling where appropriate.

Example:

```json
{
  "target": "angleX",
  "intensityScale": 1.0
}
```

```json
{
  "target": "bodyY",
  "intensityScale": 0.5
}
```

---

# 15. Motion Metadata Editor

Every motion should have an editable metadata panel.

Fields:

```text
Name
ID
Description
Tags

Compatible emotions:
  happy
  sad
  shy
  angry
  surprised
  normal

Intensity:
  min
  default
  max

Cooldown

Priority

Loop

AI enabled
```

Example:

```text
Name:
Wave Hi

Description:
Melambaikan tangan dengan antusias untuk menyapa.

Tags:
greeting, hello, friendly, happy

Emotion:
senang ██████████ 1.0
normal  ███████   0.7
malu    ███       0.3
sedih   █         0.1
```

---

# 16. AI Analyze Motion

Add an optional button:

```text
✨ Analyze Motion
```

The AI should receive a semantic representation of the motion, NOT arbitrary internal application state.

Example:

```json
{
  "duration": 1.4,
  "tracks": [
    {
      "target": "angleX",
      "range": [-5, 5],
      "keyframes": 6
    },
    {
      "target": "bodyY",
      "range": [-4, 2],
      "keyframes": 4
    }
  ]
}
```

AI returns:

```json
{
  "description": "Melambaikan tangan dengan ceria.",
  "tags": [
    "greeting",
    "friendly",
    "happy"
  ],
  "emotionCompatibility": {
    "senang": 1,
    "normal": 0.7,
    "malu": 0.3
  }
}
```

The user must approve the result before saving.

---

# 17. AI Motion Generation — Future-ready

Design the data model so that later the application can support:

User:

> "Buat gerakan malu, kepala sedikit menunduk lalu melihat ke samping."

AI should eventually generate semantic Motion DSL:

```json
{
  "name": "shy_look_away",
  "duration": 1.8,

  "tracks": [
    {
      "target": "angleY",
      "keys": [
        { "t": 0, "v": 0 },
        { "t": 0.4, "v": -8 },
        { "t": 1.2, "v": -6 },
        { "t": 1.8, "v": 0 }
      ]
    },
    {
      "target": "eyeX",
      "keys": [
        { "t": 0, "v": 0 },
        { "t": 0.6, "v": -0.5 },
        { "t": 1.5, "v": -0.6 },
        { "t": 1.8, "v": 0 }
      ]
    }
  ]
}
```

Then:

```text
AI generated
      ↓
Preview
      ↓
User approval
      ↓
Save
      ↓
Motion Registry
      ↓
Available to LLM
```

Do not make this feature mandatory for the first implementation.

Prepare the architecture for it.

---

# 18. LLM Integration

The current LLM pipeline already generates response segments containing:

```text
text
emotion
gesture
intensity
```

Keep backward compatibility.

The new system should support:

```json
[
  {
    "text": "Halo semuanya!",
    "emotion": "senang",
    "gesture": "wave_hi",
    "intensity": 0.9
  }
]
```

AND preferably evolve toward:

```json
[
  {
    "text": "Halo semuanya!",
    "actions": [
      {
        "type": "emotion",
        "id": "senang",
        "intensity": 0.8
      },
      {
        "type": "motion",
        "id": "wave_hi",
        "intensity": 0.9
      }
    ]
  }
]
```

Do not break the old format.

Normalize both formats into a common internal representation.

---

# 19. Motion Catalog sent to the LLM

The LLM should receive a compact registry.

Example:

```json
{
  "motions": [
    {
      "id": "wave_hi",
      "description": "Melambaikan tangan dengan ceria.",
      "tags": [
        "greeting",
        "hello",
        "friendly"
      ],
      "compatibleEmotions": [
        "senang",
        "normal"
      ]
    },

    {
      "id": "think",
      "description": "Pose berpikir.",
      "tags": [
        "thinking",
        "uncertain",
        "question"
      ],
      "compatibleEmotions": [
        "normal",
        "bingung"
      ]
    }
  ]
}
```

The LLM must obey:

```text
Only use motion IDs present in the registry.

Never invent motion IDs.

Prefer semantically appropriate motions.

Do not use a motion that strongly contradicts the current emotion.

Respect cooldown and availability.
```

---

# 20. LLM Must NOT Have Unlimited Motion Freedom

The LLM should select from available assets.

Bad:

```text
"gesture": "do_a_cute_hair_flip"
```

if the motion does not exist.

Good:

```text
"motion": "wave_hi"
```

if `wave_hi` exists.

The server/runtime must validate every action.

Unknown motion:

```text
→ reject
→ remove
→ fallback to neutral/no motion
```

Do not execute arbitrary IDs from the LLM.

The existing server already validates LLM emotions and gestures against available capabilities and clamps intensity. Preserve this safety pattern.

---

# 21. Context-aware Motion Selection

Eventually the Motion Director should consider:

```text
conversation context
current emotion
previous motion
motion cooldown
current motion
model capabilities
motion compatibility
intensity
```

Example:

User:

> "Aku pergi dulu."

Possible:

```text
emotion = sedih / normal
motion = wave_goodbye
```

User:

> "HAHAHAHA itu lucu banget"

Possible:

```text
emotion = senang
motion = laugh_bounce
```

User:

> "Tunggu... aku harus mikir."

Possible:

```text
emotion = normal
motion = think
```

The LLM should be the semantic director.

The runtime should be the deterministic executor.

---

# 22. Idle System

Do not remove the current micro-gesture/idle system.

The application already uses emotion-weighted micro-gestures to keep the character alive between sentences.

Instead, make idle behavior the lowest-priority motion layer.

Example:

```text
LLM motion
   ↓
gesture
   ↓
emotion
   ↓
idle
```

Idle must automatically stand down when a higher-priority motion owns the relevant parameters.

---

# 23. Model Capability Awareness

Every Motion Asset must be evaluated against model capabilities.

Example:

```json
{
  "requires": [
    "head",
    "eyes",
    "body"
  ]
}
```

If the model lacks body parameters:

```text
Do not fail.

Degrade gracefully.

Use available tracks only.
```

For example:

```text
wave_hi
requires:
  head
  body

model:
  head = yes
  body = no

Result:
  play head component
  skip body component
```

The current application already tracks capabilities such as:

```text
hasHead
hasEyes
hasMouth
hasBody
hasBrow
hasHair
params
motionGroups
```

Reuse this capability system.

---

# 24. User Experience Requirements

The editor should feel:

- fast
- visual
- understandable
- forgiving
- non-destructive
- easy to preview

Avoid:

- excessive modal dialogs
- raw JSON as the primary UI
- exposing hundreds of Live2D parameters by default
- requiring users to understand Cubism internals
- unnecessary configuration

Useful controls:

```text
New
Duplicate
Rename
Delete
Undo
Redo
Play
Pause
Stop
Loop
Reset
Save
Save As
Preview
Analyze with AI
```

---

# 25. Undo / Redo

Implement undo/redo for timeline edits.

At minimum support:

```text
add keyframe
delete keyframe
move keyframe
change value
change duration
change metadata
```

Do not persist every tiny editor state change to disk.

Persist only on explicit save or controlled autosave.

---

# 26. Persistence

Use the existing application's persistence conventions.

Motion assets should be saved per model.

Suggested:

```text
motions/<model>/catalog.json
motions/<model>/<motion-id>.motion.json
```

Do not silently overwrite an existing user motion.

When IDs conflict:

```text
ask user
or
generate a safe unique ID
```

Respect the existing user-vs-AI precedence rules where applicable. The current system already treats user-authored presets as authoritative over AI suggestions.

---

# 27. API

Add APIs only where necessary.

Potential endpoints:

```text
GET  /api/motions?model=<model>
GET  /api/motions/<id>?model=<model>
POST /api/motions
PUT  /api/motions/<id>
DELETE /api/motions/<id>
POST /api/motions/analyze
```

If the application can safely keep some operations client-side, do so.

Do not move API keys to the browser.

The current architecture correctly keeps the LLM API key on the server. Preserve that design.

---

# 28. Security / Validation

Never trust LLM-generated motion IDs.

Validate:

```text
motion exists
motion enabled
model supports motion
intensity within range
duration valid
targets valid
keyframe values within safe ranges
```

Clamp values where appropriate.

Prevent:

```text
NaN
Infinity
invalid timestamps
negative duration
unknown target
unknown motion
```

---

# 29. Testing

Add automated tests.

At minimum:

### Registry

```text
register motion
get motion
remove motion
search motion
duplicate ID handling
```

### Parser

```text
valid motion JSON
invalid JSON
missing fields
invalid keyframes
unknown targets
```

### Runtime

```text
play
stop
blend
intensity
cooldown
priority
ownership
```

### LLM

```text
valid motion
unknown motion
invalid intensity
old response format
new actions format
```

### Capability

```text
full model
head-only model
eye-less model
body-less model
```

Do not regress the existing test suite.

The current repository has an established automated test suite and should remain green.

---

# 30. Implementation Strategy

Do NOT implement everything in one huge change.

Implement in this order:

## Phase 1

Create:

```text
motion-dsl.js
motion-registry.js
motion-runtime.js
```

with no major UI changes.

---

## Phase 2

Connect existing:

```text
GESTURE_LIBRARY
motion taxonomy
native motion3 clips
```

to the Motion Registry.

---

## Phase 3

Create Motion Studio UI.

First support:

```text
create motion
timeline
semantic tracks
keyframes
preview
save
load
```

---

## Phase 4

Add:

```text
metadata editor
tags
emotion compatibility
intensity
cooldown
priority
```

---

## Phase 5

Integrate LLM.

Support both:

```text
gesture
```

and:

```text
actions[]
```

formats.

---

## Phase 6

Add AI Analyze Motion.

---

## Phase 7

Prepare AI Motion Generation.

Do not block the core implementation on this feature.

---

# 31. Important Architectural Rule

There must be exactly one conceptual pipeline for motion execution:

```text
Motion Asset
     ↓
Motion Registry
     ↓
Motion Scheduler
     ↓
Motion Runtime
     ↓
Live2D
```

Do not create multiple competing motion engines.

Existing systems may be adapted into this pipeline.

Avoid having:

```text
app.js → direct motion
agent.js → direct motion
gesture system → direct motion
editor → direct motion
```

Instead:

```text
app.js
agent.js
editor
idle system
       ↓
Motion Runtime
       ↓
Live2D
```

---

# 32. Quality Bar

The implementation is considered successful only if:

### User can

- create a motion visually
- edit keyframes
- preview it immediately
- save it
- reload it
- assign semantic metadata
- see it in the Motion Registry
- use it from chat

### LLM can

- discover available motions
- select an appropriate motion
- select intensity
- combine motion with emotion
- never invent unavailable motion IDs

### Runtime can

- blend animations
- prevent conflicting parameter writers
- respect priorities
- respect cooldown
- degrade based on model capabilities
- fall back gracefully

### Existing application

- continues working
- existing gestures continue working
- existing native `.motion3.json` motions continue working
- existing character sheets continue working
- existing LLM response format continues working
- existing tests remain passing

---

# 33. Final Principle

The purpose of Motion Studio is NOT merely to make an animation timeline.

The real objective is:

> Turn animation into a semantic capability that an AI agent can understand and use.

The final system should make this possible:

```text
User creates:

"shy_look_away"

        ↓

Motion Studio stores:

description:
"Menundukkan kepala lalu mengalihkan pandangan."

tags:
["shy", "embarrassed", "cute"]

emotionCompatibility:
{
  "malu": 1.0,
  "senang": 0.4,
  "sedih": 0.3
}

        ↓

Motion Registry

        ↓

LLM sees:

shy_look_away
"Menundukkan kepala lalu mengalihkan pandangan."

        ↓

User says something embarrassing

        ↓

LLM:

emotion = malu
motion = shy_look_away
intensity = 0.8

        ↓

Motion Scheduler

        ↓

Motion Runtime

        ↓

Live2D character performs the motion.
```

That is the target architecture.

Do not optimize for maximum feature count.

Optimize for:

**semantic clarity + deterministic execution + smooth animation + extensibility + compatibility with the existing project.**