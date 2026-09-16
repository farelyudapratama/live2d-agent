import type * as RoleMapping from "./engine/role-mapping";
import type * as Framing from "./engine/framing";
import type * as MotionDSL from "./animation/motion-dsl";
import type { MotionRegistry } from "./animation/motion-registry";
import type { MotionRuntime } from "./animation/motion-runtime";
import type * as MotionTaxonomy from "./engine/motion-taxonomy";
import type * as LipSync from "./speech/lip-sync";
import type { collectNativeExpressions } from "./engine/native-expressions";
import type * as I18n from "./i18n/index";
import type { Live2DApi } from "../live2d/types";
import type { SpeechChannel, SpeechOutcome } from "./speech/channel";

export type Destroy = () => void;

export type Live2DLegacyBridge = {
  getCapabilityProfile?: () => Promise<{ userNote?: string }>;
  // S1: speak membawa opsi token/producer; callback menerima outcome
  // "completed" | "lost" (kanal milik bersama — completion BUKAN onend browser).
  speak?: (
    text: string,
    onDone?: (outcome?: SpeechOutcome) => void,
    opts?: { token?: unknown; producer?: string },
  ) => void;
};

declare global {
  interface Window {
    MotionDSL?: typeof MotionDSL;
    MotionRegistry?: typeof MotionRegistry;
    MotionRuntime?: typeof MotionRuntime;
    MotionTaxonomy?: typeof MotionTaxonomy;
    LipSync?: typeof LipSync;
    __agentPanel?: { start(): Destroy };
    __shellProjek?: { start(): Destroy };
    __browserPanel?: { start(): Destroy };
    __roleMapping?: typeof RoleMapping;
    __engineRoleLink?: {
      links: unknown[];
      attach(
        coreModel: unknown,
        getRoleIds: () => Record<string, string> | null | undefined,
      ): unknown;
      /** R7-2 — roleLink Phase 10 di atas production Live2DModelHandle. */
      attachHandle(
        handle: import("../live2d/types").Live2DModelHandle,
        getRoleIds: () => Record<string, string> | null | undefined,
      ): unknown;
    };
    __l2dArbiter?: {
      createArbiter(backing: {
        writeRole(role: string, valueRef: number): boolean;
        writeRoleNorm?(role: string, t: number): boolean;
        writeParam(id: string, value: number): boolean;
      }): {
        submit(s: {
          channel: string;
          priority: number;
          domain: "role" | "param";
          values: Record<string, number>;
          mode?: "ref" | "norm";
        }): { accepted: number; rejected: string[] };
        clearSource(channel: string): boolean;
        clearTarget(channel: string, domain: "role" | "param", key: string): boolean;
        clearAll(): void;
        hasSource(channel: string): boolean;
        resolve(): { role: Record<string, number>; param: Record<string, number> };
        commit(): number;
      };
    };
    __framing?: typeof Framing;
    __nativeExpressions?: { collect: typeof collectNativeExpressions };
    __i18n?: typeof I18n;
    __live2dAgent?: Live2DLegacyBridge;
    __live2dApi?: Live2DApi;
    __speechChannel?: SpeechChannel;
    __addChat?: (role: string, text: string) => void;
  }
}

export {};
