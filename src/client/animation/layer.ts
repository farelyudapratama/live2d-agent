/**
 * animation/layer.ts — Single animation controller.
 *
 * All animation output goes through this layer. It manages:
 * - AI pose target (from agent directives)
 * - Gesture playback (procedural + native clips)
 * - Idle micro-fidget (always running when nothing else is playing)
 * - Breathing (always running)
 * - Mouse follow (head + eyes + body)
 *
 * The key insight: this layer writes to a SINGLE target pose,
 * then the ease engine smooths toward it every frame.
 */

import { clamp, lerp, smoothDamp } from "./easing";
import type { ParsedActions } from "../../shared/types";

export interface PoseTarget {
  angleX: number;   // head turn left/right
  angleY: number;   // head tilt up/down
  angleZ: number;   // head roll
  eyeBallX: number; // eye gaze left/right
  eyeBallY: number; // eye gaze up/down
  mouthForm: number;
  mouthOpen: number;
  bodyAngleX: number;
  bodyAngleY: number;
  bodyAngleZ: number;
  breath: number;
}

const ZERO_POSE: PoseTarget = {
  angleX: 0, angleY: 0, angleZ: 0,
  eyeBallX: 0, eyeBallY: 0,
  mouthForm: 0, mouthOpen: 0,
  bodyAngleX: 0, bodyAngleY: 0, bodyAngleZ: 0,
  breath: 0.45,
};

function clonePose(p: PoseTarget): PoseTarget {
  return { ...p };
}

export class AnimationLayer {
  // Current eased pose (what's actually written to the model)
  current: PoseTarget = clonePose(ZERO_POSE);

  // Target pose (what we're easing toward)
  target: PoseTarget = clonePose(ZERO_POSE);

  // Mouse follow targets
  private mouseX = 0;
  private mouseY = 0;

  // AI lock state
  private aiLocked = false;

  // Gesture state
  private gesturePlaying = false;
  private gestureTimer: ReturnType<typeof setTimeout> | null = null;

  // Idle fidget
  private fidgetSeed = Math.random() * 1000;
  private fidgetT = 0;

  // Impulse (bounce on new pose)
  private impulse = 0;

  // Frozen (for editor)
  private frozen = false;

  // Easing speeds
  private static readonly EASE_HEAD = 0.16;
  private static readonly EASE_EYES = 0.25;
  private static readonly EASE_BODY = 0.12;
  private static readonly EASE_MOUTH = 0.3;

  /**
   * Main update — call every frame.
   * Returns the final pose to write to the model.
   */
  update(dt: number): PoseTarget {
    if (this.frozen) return this.current;

    // Apply idle fidget when no AI pose
    if (!this.aiLocked) {
      this.applyIdleFidget(dt);
    }

    // Apply impulse
    if (this.impulse > 0) {
      this.target.angleY += this.impulse * 0.5;
      this.target.bodyAngleX += this.impulse * 0.3;
      this.impulse *= 0.9;
      if (this.impulse < 0.01) this.impulse = 0;
    }

    // Ease toward target
    const ease = (cur: number, tar: number, speed: number) => {
      return cur + (tar - cur) * speed;
    };

    this.current.angleX = ease(this.current.angleX, this.target.angleX, AnimationLayer.EASE_HEAD);
    this.current.angleY = ease(this.current.angleY, this.target.angleY, AnimationLayer.EASE_HEAD);
    this.current.angleZ = ease(this.current.angleZ, this.target.angleZ, AnimationLayer.EASE_HEAD);
    this.current.eyeBallX = ease(this.current.eyeBallX, this.target.eyeBallX, AnimationLayer.EASE_EYES);
    this.current.eyeBallY = ease(this.current.eyeBallY, this.target.eyeBallY, AnimationLayer.EASE_EYES);
    this.current.mouthForm = ease(this.current.mouthForm, this.target.mouthForm, AnimationLayer.EASE_MOUTH);
    this.current.mouthOpen = ease(this.current.mouthOpen, this.target.mouthOpen, AnimationLayer.EASE_MOUTH);
    this.current.bodyAngleX = ease(this.current.bodyAngleX, this.target.bodyAngleX, AnimationLayer.EASE_BODY);
    this.current.bodyAngleY = ease(this.current.bodyAngleY, this.target.bodyAngleY, AnimationLayer.EASE_BODY);
    this.current.bodyAngleZ = ease(this.current.bodyAngleZ, this.target.bodyAngleZ, AnimationLayer.EASE_BODY);

    // Breathing (always running)
    this.fidgetT += dt;
    this.current.breath = 0.45 + Math.sin(this.fidgetT * 1.2) * 0.08;

    return this.current;
  }

  /**
   * Set AI pose from directive actions.
   */
  setAIPose(pose: Partial<PoseTarget>): void {
    this.aiLocked = true;
    Object.assign(this.target, pose);
    this.impulse = 1.5; // bounce on new pose
  }

  /**
   * Release AI lock (back to idle).
   */
  releaseAILock(): void {
    this.aiLocked = false;
    // Ease back to neutral
    this.target = { ...ZERO_POSE };
  }

  /**
   * Set mouse follow target (0..1 range, center = 0).
   */
  setMouseFollow(x: number, y: number): void {
    this.mouseX = clamp(x, -1, 1);
    this.mouseY = clamp(y, -1, 1);

    if (!this.aiLocked) {
      // Scale mouse influence to parameter ranges
      this.target.angleX = this.mouseX * 12;
      this.target.angleY = this.mouseY * 8;
      this.target.eyeBallX = this.mouseX * 0.4;
      this.target.eyeBallY = this.mouseY * 0.3;
    }
  }

  /**
   * Set specific gesture action from LLM directive.
   */
  applyGesture(gesture: string): void {
    const poses: Record<string, Partial<PoseTarget>> = {
      nod: { angleY: -8 },
      shake: { angleX: 10 },
      tilt_curious: { angleZ: 6, angleX: 5 },
      lean_excited: { angleY: -4, bodyAngleX: 6 },
      recoil_surprised: { angleY: -12, bodyAngleZ: -3 },
      look_away_shy: { angleX: -10, eyeBallX: -0.6, angleY: 4 },
      laugh_bounce: { angleY: -6, bodyAngleY: 3 },
      think: { angleX: 5, angleZ: 3, eyeBallX: 0.3 },
      wave_hi: { angleX: 8, bodyAngleX: 5 },
    };
    const pose = poses[gesture] ?? {};
    this.setAIPose(pose);
    // Auto-release after duration
    this.gesturePlaying = true;
    if (this.gestureTimer) clearTimeout(this.gestureTimer);
    this.gestureTimer = setTimeout(() => {
      this.gesturePlaying = false;
      if (!this.aiLocked) this.target = { ...ZERO_POSE };
    }, 1500);
  }

  /**
   * Freeze all animation (for editor use).
   */
  freeze(): void {
    this.frozen = true;
  }

  unfreeze(): void {
    this.frozen = false;
  }

  /**
   * Add organic micro-fidget for "alive" feel.
   */
  private applyIdleFidget(dt: number): void {
    const t = this.fidgetT;
    const seed = this.fidgetSeed;
    // Slow, organic drift
    this.target.angleX += Math.sin(t * 0.3 + seed) * 0.5;
    this.target.angleY += Math.sin(t * 0.2 + seed * 1.3) * 0.3;
    this.target.bodyAngleX += Math.sin(t * 0.15 + seed * 0.7) * 0.3;
    this.target.bodyAngleZ += Math.sin(t * 0.1 + seed * 1.1) * 0.2;
    // Occasional blink-like mouth movement
    if (Math.sin(t * 0.4 + seed * 2) > 0.98) {
      this.target.mouthOpen = 0.15;
    } else {
      this.target.mouthOpen *= 0.95;
    }
  }

  /**
   * Fire impulse for dynamic motion.
   */
  addImpulse(strength: number): void {
    this.impulse = clamp(this.impulse + strength, 0, 5);
  }
}
