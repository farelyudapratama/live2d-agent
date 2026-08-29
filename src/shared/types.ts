/**
 * shared/types.ts — Single source of truth for all data shapes.
 * Server and client both import from here.
 */

// ── Config ─────────────────────────────────────────────────────
export interface Connection {
  id: string;
  name: string;
  provider: LLMProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  testStatus: "idle" | "success" | "error";
  lastError?: string;
  rateLimitedUntil?: string;
}

export type LLMProvider =
  | "openai-compatible"
  | "openai"
  | "gemini"
  | "groq"
  | "anthropic"
  | "mock";

export interface Config {
  activeId: string | null;
  connections: Connection[];
  tts: { endpoint: string };
  events: EventConfig;
  camera: CameraConfig;
  motion: MotionConfig;
}

export interface EventConfig {
  idleSpeak: boolean;
  idleMs: number;
  idleRepeatMs: number;
  awaySpeak: boolean;
  returnSpeak: boolean;
  awayHiddenMs: number;
  quietMs: number;
}

export interface CameraConfig {
  enabled: boolean;
  fps: number;
  presenceThreshold: number;
  device: string;
  model: string;
  moodGraceMs: number;
  moodDebounceMs: number;
  moodStableTicks: number;
}

export interface MotionConfig {
  enabled: boolean;
  gain: number;
}

// ── Model / Sheet ──────────────────────────────────────────────
export interface ParamInfo {
  id: string;
  min: number;
  max: number;
  def: number;
  group: string;
  label: string;
  userNote?: string;
  estimated?: boolean;
}

export interface PartInfo {
  id: string;
  opacity: number;
}

export interface RoleMapping {
  role: string;
  paramId: string;
}

export interface SheetPreset {
  name: string;
  category: PresetCategory;
  values: Record<string, number>;
  parts?: Record<string, number>;
  source?: "user" | "ai";
  suggestion?: boolean;
}

export type PresetCategory = "emosi" | "properti" | "aksesoris" | "gerak";

export interface CharacterSheet {
  schemaVersion: number;
  params: ParamInfo[];
  parts: PartInfo[];
  paramGroups: { user: Record<string, string>; ai: Record<string, string> };
  presets: { user: Record<PresetCategory, SheetPreset[]>; ai: Record<PresetCategory, SheetPreset[]> };
  userNote: string;
  config: Record<string, unknown>;
}

// ── Motion ─────────────────────────────────────────────────────
export interface MotionTrack {
  kind: "role" | "param";
  param?: string;         // for kind=param
  target?: string;        // for kind=role (ax, ay, bodyX, etc.)
  interp: EasingMode;
  keys: Keyframe[];
  label?: string;
  min?: number;
  max?: number;
}

export interface Keyframe {
  t: number;
  v: number;
  easing?: EasingMode;
}

export type EasingMode = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "stepped";

export interface MotionAsset {
  version: number;
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: "builtin" | "native" | "user";
  type: string;
  duration: number;
  loop: boolean;
  intensity: { min: number; max: number; default: number };
  emotionCompatibility: Record<string, number>;
  cooldown: number;
  priority: number;
  aiEnabled: boolean;
  requires: string[];
  tracks: MotionTrack[];
  sourceModelId?: string;
}

// ── LLM ────────────────────────────────────────────────────────
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMResponse {
  reply: string;
  used: string;
}

// ── Agent Directives ───────────────────────────────────────────
export type DirectiveType =
  | "EMOTION" | "EXPR" | "HEAD" | "EYES" | "MOUTH"
  | "BODY" | "ACC" | "PROP" | "PROPERTY" | "GESTURE"
  | "MOTION" | "INTENSITY";

export interface ParsedActions {
  emotion?: string;
  head?: { x: number; y: number };
  eyes?: { x: number; y: number };
  mouth?: { form: number; open: number };
  body?: { x: number; y: number; z: number };
  accessories?: Record<string, number>;
  property?: string;
  gesture?: string;
  motion?: string;
  intensity?: number;
}

export interface ParsedSegment {
  text: string;
  actions: ParsedActions;
}

// ── API ────────────────────────────────────────────────────────
export interface APIResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface CapabilityProfile {
  emotions: string[];
  nativeExpressions: string[];
  accessories: string[];
  properties: string[];
  gestures: string[];
  motionCatalog: MotionAsset[];
  sheet: CharacterSheet | null;
  userNote: string;
  roleIds: Record<string, string>;
  paramRange: Record<string, { min: number; max: number; def: number }>;
}
