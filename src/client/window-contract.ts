import type * as RoleMapping from "./engine/role-mapping";
import type * as Framing from "./engine/framing";
import type * as MotionDSL from "./animation/motion-dsl";
import type { MotionRegistry } from "./animation/motion-registry";
import type { MotionRuntime } from "./animation/motion-runtime";
import type * as MotionTaxonomy from "./engine/motion-taxonomy";
import type * as LipSync from "./speech/lip-sync";
import type { collectNativeExpressions } from "./engine/native-expressions";
import type * as I18n from "./i18n/index";

export type Destroy = () => void;

export type Live2DLegacyBridge = {
  getCapabilityProfile?: () => Promise<{ userNote?: string }>;
  speak?: (text: string) => void;
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
    __framing?: typeof Framing;
    __nativeExpressions?: { collect: typeof collectNativeExpressions };
    __i18n?: typeof I18n;
    __live2dAgent?: Live2DLegacyBridge;
    __addChat?: (role: string, text: string) => void;
  }
}

export {};
