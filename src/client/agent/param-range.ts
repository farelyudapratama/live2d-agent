import type { CapabilityProfile } from "../../shared/types";
import { refHalfFor } from "../engine/role-mapping";

/**
 * Ubah pecahan semantik menjadi role-space referensi. Render loop menjadi
 * satu-satunya tempat yang memetakan role-space ke paramRange aktual model.
 */
export function scaleRoleFraction(
  profile: CapabilityProfile | null | undefined,
  role: string,
  fraction: number,
): number {
  if (profile && !profile.roleIds?.[role]) return 0;
  if (!Number.isFinite(fraction)) return 0;
  return fraction * refHalfFor(role);
}
