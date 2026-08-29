/**
 * client/main.ts — Client entry point.
 * Initializes all modules and wires them together.
 * This is the "glue" layer — minimal, just connecting modules.
 */

import { AnimationLayer } from "./animation/layer";
import { MotionRegistry } from "./animation/motion-registry";
import { MotionRuntime } from "./animation/motion-runtime";
import { AgentBrain } from "./agent/brain";
import { ChatUI } from "./modules/chat-ui";
import { CameraPresence } from "./modules/camera-presence";
import type { ParsedSegment, CapabilityProfile } from "../shared/types";

// ── Globals (for cross-module access) ──────────────────────────
const API = (typeof location !== "undefined" && /^https?:$/.test(location.protocol))
  ? location.origin
  : "http://127.0.0.1:8310";

// ── Initialize modules ─────────────────────────────────────────
const animLayer = new AnimationLayer();
const registry = new MotionRegistry();
const runtime = new MotionRuntime(registry, {
  getPoseBase: () => ({ ...animLayer.target }),
  applyPoseDelta: (d) => {
    const cur = animLayer.target;
    if (d.angleX !== undefined) cur.angleX += d.angleX;
    if (d.angleY !== undefined) cur.angleY += d.angleY;
    if (d.angleZ !== undefined) cur.angleZ += d.angleZ;
    if (d.eyeBallX !== undefined) cur.eyeBallX += d.eyeBallX;
    if (d.eyeBallY !== undefined) cur.eyeBallY += d.eyeBallY;
    if (d.bodyAngleX !== undefined) cur.bodyAngleX += d.bodyAngleX;
    if (d.bodyAngleY !== undefined) cur.bodyAngleY += d.bodyAngleY;
    if (d.bodyAngleZ !== undefined) cur.bodyAngleZ += d.bodyAngleZ;
    if (d.mouthForm !== undefined) cur.mouthForm += d.mouthForm;
    if (d.mouthOpen !== undefined) cur.mouthOpen += d.mouthOpen;
  },
  clearPoseDelta: () => {
    // Reset to neutral — let ease engine handle smooth return
    animLayer.releaseAILock();
  },
  applyParamDrive: () => {}, // TODO: implement raw param drive
  releaseParamDrive: () => {},
});

const agent = new AgentBrain({
  onSegments: (segments) => playSegments(segments),
  onThinking: (on) => chatUI.setThinking(on),
});

const chatUI = new ChatUI({
  onSend: (text) => agent.think(text),
});

const camera = new CameraPresence({
  onMood: (mood) => agent.setMood(mood, "camera"),
  onPresence: (present) => agent.setPresence(present),
});

// ── Main render loop ───────────────────────────────────────────
let lastFrame = performance.now();

function renderLoop(): void {
  const now = performance.now();
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  const pose = animLayer.update(dt);

  // Write pose to Live2D model (if loaded)
  const l2d = (window as any).__live2dAgent;
  if (l2d?.isReady?.()) {
    const cm = l2d.coreModel?.();
    if (cm) {
      try {
        cm.setParameterValueById("ParamAngleX", pose.angleX, 1);
        cm.setParameterValueById("ParamAngleY", pose.angleY, 1);
        cm.setParameterValueById("ParamAngleZ", pose.angleZ, 1);
        cm.setParameterValueById("ParamEyeBallX", pose.eyeBallX, 1);
        cm.setParameterValueById("ParamEyeBallY", pose.eyeBallY, 1);
        cm.setParameterValueById("ParamMouthForm", pose.mouthForm, 1);
        cm.setParameterValueById("ParamMouthOpenY", pose.mouthOpen, 1);
        cm.setParameterValueById("ParamBodyAngleX", pose.bodyAngleX, 1);
        cm.setParameterValueById("ParamBodyAngleY", pose.bodyAngleY, 1);
        cm.setParameterValueById("ParamBodyAngleZ", pose.bodyAngleZ, 1);
        cm.setParameterValueById("ParamBreath", pose.breath, 1);
      } catch {}
    }
  }

  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ── Mouse follow ───────────────────────────────────────────────
document.addEventListener("mousemove", (e) => {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const x = (e.clientX - cx) / cx;
  const y = (e.clientY - cy) / cy;
  animLayer.setMouseFollow(x, y);
});

// ── Play segments sequentially ─────────────────────────────────
let aiLocked = false;

function playSegments(segments: ParsedSegment[]): void {
  if (!segments.length) return;
  aiLocked = true;

  let i = 0;
  function next(): void {
    if (i >= segments.length) {
      aiLocked = false;
      animLayer.releaseAILock();
      return;
    }
    const seg = segments[i++];
    applyActions(seg.actions);
    chatUI.addMessage("agent", seg.text);
    // Auto-advance after a delay (simulates TTS timing)
    setTimeout(next, 180 + (seg.text.length * 30));
  }
  next();
}

function applyActions(actions: ParsedSegment["actions"]): void {
  // Emotion → set expression on model
  if (actions.emotion) {
    const l2d = (window as any).__live2dAgent;
    l2d?.setExpression?.(actions.emotion);
  }

  // Build pose
  const pose: Record<string, number> = {};

  if (actions.head) {
    pose.angleX = clamp(actions.head.x, -30, 30);
    pose.angleY = clamp(actions.head.y, -30, 30);
  }
  if (actions.eyes) {
    pose.eyeBallX = clamp(actions.eyes.x, -1, 1);
    pose.eyeBallY = clamp(actions.eyes.y, -1, 1);
  }
  if (actions.body) {
    pose.bodyAngleX = clamp(actions.body.x, -30, 30);
    pose.bodyAngleY = clamp(actions.body.y, -30, 30);
    pose.bodyAngleZ = clamp(actions.body.z, -30, 30);
  }
  if (actions.mouth) {
    pose.mouthForm = clamp(actions.mouth.form, -1, 1);
  }

  if (Object.keys(pose).length) {
    animLayer.setAIPose(pose);
  }

  // Gesture
  if (actions.gesture) {
    animLayer.applyGesture(actions.gesture);
  }

  // Motion (from Motion Studio)
  if (actions.motion) {
    runtime.play(actions.motion, {
      fromLLM: true,
      intensity: actions.intensity,
      priority: 80,
    });
  }

  // Accessories
  if (actions.accessories) {
    const l2d = (window as any).__live2dAgent;
    for (const [param, val] of Object.entries(actions.accessories)) {
      l2d?.setAccessory?.(param, val);
    }
  }

  // Property/Expression
  if (actions.property) {
    const l2d = (window as any).__live2dAgent;
    l2d?.setExpression?.(actions.property);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Proactive event loop ───────────────────────────────────────
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function startIdleTimer(): void {
  const events = (window as any).__appEvents ?? { idleMs: 1_800_000 };
  idleTimer = setTimeout(() => {
    if (!agent.isBusy()) {
      agent.reactEvent("idle");
    }
    startIdleTimer(); // restart
  }, events.idleMs ?? 1_800_000);
}
startIdleTimer();

// ── Tab visibility (presence fallback) ─────────────────────────
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // User might have left — but camera is the primary source
    // Only use tab visibility when camera is off
    if (!camera.isEnabled()) {
      // Don't immediately trigger away — wait for awayHiddenMs
    }
  }
});

// ── Expose for other modules ───────────────────────────────────
(window as any).__live2dAgent = {
  ...(window as any).__live2dAgent,
  isReady: () => !!(window as any).__live2dAgent?.model,
  coreModel: () => (window as any).__live2dAgent?.model?.internalModel?.coreModel,
  setExpression: (name: string) => {
    try {
      (window as any).__live2dAgent?.model?.expression?.(name);
    } catch {}
  },
  setAccessory: (param: string, val: number) => {
    const cm = (window as any).__live2dAgent?.coreModel?.();
    if (cm) cm.setParameterValueById(param, val, 1);
  },
  speak: (text: string, cb?: () => void) => {
    // TTS placeholder — integrate with TTS endpoint
    console.log("[tts]", text);
    setTimeout(cb ?? (() => {}), 1000);
  },
  lockAI: () => { aiLocked = true; },
  unlockAI: () => { aiLocked = false; animLayer.releaseAILock(); },
  playMotion: (id: string, opts?: any) => runtime.play(id, opts),
  playGesture: (name: string) => animLayer.applyGesture(name),
  setAIPose: (pose: any) => animLayer.setAIPose(pose),
  setRawDrive: () => {}, // TODO
  readParameter: (id: string) => {
    const cm = (window as any).__live2dAgent?.coreModel?.();
    return cm ? cm.getParameterValueById(id) : 0;
  },
  listModelParams: () => [], // TODO: populate from inspection
  freezeForEdit: () => animLayer.freeze(),
  unfreezeForEdit: () => animLayer.unfreeze(),
  stopAllMotions: () => runtime.stopAll(),
  registerUserMotion: (asset: any) => registry.register({ ...asset, source: "user" }),
  removeUserMotion: (id: string) => registry.remove(id, "user"),
  listRegistryMotions: () => registry.list(),
  getCapabilityProfile: async (): Promise<CapabilityProfile | null> => {
    try {
      const resp = await fetch(API + "/api/config");
      if (!resp.ok) return null;
      // Build minimal profile — full implementation needs model inspection
      return {
        emotions: ["senang", "tersenyum", "sedih", "malu", "kaget", "kesal", "bingung", "normal"],
        nativeExpressions: [],
        accessories: [],
        properties: [],
        gestures: ["nod", "shake", "tilt_curious", "lean_excited", "recoil_surprised", "look_away_shy", "laugh_bounce", "think", "wave_hi"],
        motionCatalog: registry.catalogForLLM() as any,
        sheet: null,
        userNote: "",
        roleIds: {},
        paramRange: {},
      };
    } catch { return null; }
  },
};

console.log("🎭 Live2D Agent v2 initialized");
