/**
 * engine/role-mapper.ts — Model-agnostic role → parameter resolution.
 * Single source of truth for mapping semantic roles (angleX, eyeBallY, etc.)
 * to actual Cubism parameter IDs. Supports ID patterns + cdi3 display names.
 */

export interface ParamRange {
  id: string;
  min: number;
  max: number;
  def: number;
  estimated?: boolean;
}

export interface RoleMap {
  /** role → actual parameter ID */
  ids: Record<string, string>;
  /** parameter ID → range from Cubism Core */
  ranges: Record<string, ParamRange>;
  /** Whether ranges are measured or estimated */
  estimated: boolean;
  /** model's owned param IDs */
  ownedParams: Set<string>;
}

// ── Role patterns (ID-based) ───────────────────────────────────
const ROLE_PATTERNS: Record<string, RegExp[]> = {
  angleX:     [/^param(?:_)?anglex$/i, /anglex/i, /(?:^|_)yaw/i],
  angleY:     [/^param(?:_)?angley$/i, /angley/i, /(?:^|_)pitch/i],
  angleZ:     [/^param(?:_)?anglez$/i, /anglez/i, /(?:^|_)roll/i],
  eyeBallX:   [/eyeballx/i, /瞳.*x/i],
  eyeBallY:   [/eyebally/i, /瞳.*y/i],
  eyeLOpen:   [/eyelopen/i, /eye_l_open/i, /左目.*開/],
  eyeROpen:   [/eyeropen/i, /eye_r_open/i, /右目.*開/],
  eyeSmile:   [/eye[lr]?smile/i, /目.*笑/],
  mouthForm:  [/mouthform(?!\\d)/i, /口角/],
  mouthOpenY: [/mouthopeny/i, /mouthopen(?!x)/i, /口.*開/],
  mouthOpenX: [/mouthopenx/i],
  browLForm:  [/browlform/i],
  browRForm:  [/browrform/i],
  browLY:     [/browly/i],
  browRY:     [/browry/i],
  browLAngle: [/browlangle/i],
  browRAngle: [/browrangle/i],
  bodyAngleX: [/bodyanglex/i, /体.*x/i],
  bodyAngleY: [/bodyangley/i, /体.*y/i],
  bodyAngleZ: [/bodyanglez/i, /体.*z/i],
  breath:     [/breath/i],
  blush:      [/blush/i, /cheek(?!puff)/i, /頬/],
};

// ── Display name patterns (cdi3) ───────────────────────────────
const DISPLAY_PATTERNS: Record<string, RegExp[]> = {
  angleX:     [/\bangle\s*x\b/i, /\byaw\b/i, /head.*(?:left|right)/i, /頭.*横/],
  angleY:     [/\bangle\s*y\b/i, /\bpitch\b/i, /head.*(?:up|down)/i, /頭.*縦/],
  angleZ:     [/\bangle\s*z\b/i, /\broll\b/i, /\btilt\b/i],
  eyeBallX:   [/eye\s*ball\s*x/i, /\bgaze\s*x/i],
  eyeBallY:   [/eye\s*ball\s*y/i, /\bgaze\s*y/i],
  eyeSmile:   [/eye.*smile/i, /目.*笑/],
  eyeLOpen:   [/eye.*open/i, /\bblink\b/i],
  mouthForm:  [/mouth\s*form/i, /mouth.*(?:corner|shape)/i],
  mouthOpenY: [/mouth\s*open/i, /张[口嘴]/],
  browY:      [/brow.*(?:up|down|y\b)/i],
  browAngle:  [/brow.*angle/i],
  browForm:   [/brow.*form/i],
  bodyAngleX: [/body.*angle\s*x/i],
  bodyAngleY: [/body.*angle\s*y/i],
  bodyAngleZ: [/body.*angle\s*z/i],
  blush:      [/\bblush\b/i, /cheek(?!puff)/i, /頬/],
  tear:       [/\btear\b/i, /\bcry\b/i, /涙/],
  arm:        [/\barm\b/i, /\bhand\b/i, /腕/],
};

function matchRole(id: string, patterns: Record<string, RegExp[]>): string | null {
  for (const [role, res] of Object.entries(patterns)) {
    for (const re of res) {
      if (re.test(id)) return role;
    }
  }
  return null;
}

/**
 * Build a role map for a model.
 * @param params - Parameters from Cubism Core inspection
 * @param cdi3 - Optional cdi3.json for display name resolution
 */
export function buildRoleMap(
  params: Array<{ id: string; min: number; max: number; def: number }>,
  cdi3?: any
): RoleMap {
  const ids: Record<string, string> = {};
  const ranges: Record<string, ParamRange> = {};
  const ownedParams = new Set<string>();

  // Build cdi3 display name lookup
  const displayNames: Record<string, string> = {};
  if (cdi3?.Parameters) {
    for (const p of cdi3.Parameters) {
      if (p?.Id && p?.Name) displayNames[p.Id] = p.Name;
    }
  }

  let estimated = false;

  for (const p of params) {
    ownedParams.add(p.id);
    ranges[p.id] = { id: p.id, min: p.min, max: p.max, def: p.def };

    // Try ID-based match first
    const byId = matchRole(p.id, ROLE_PATTERNS);
    if (byId) {
      ids[byId] = p.id;
      continue;
    }

    // Try display name match
    const displayName = displayNames[p.id];
    if (displayName) {
      const byName = matchRole(displayName, DISPLAY_PATTERNS);
      if (byName) {
        ids[byName] = p.id;
        continue;
      }
    }

    // Name-based heuristic fallback (estimated)
    const byGuess = guessRole(p.id);
    if (byGuess) {
      ids[byGuess] = p.id;
      estimated = true;
    }
  }

  return { ids, ranges, estimated, ownedParams };
}

function guessRole(id: string): string | null {
  const lower = id.toLowerCase();
  if (/angle.?x/i.test(lower)) return "angleX";
  if (/angle.?y/i.test(lower)) return "angleY";
  if (/angle.?z/i.test(lower)) return "angleZ";
  if (/eye.?ball.?x/i.test(lower)) return "eyeBallX";
  if (/eye.?ball.?y/i.test(lower)) return "eyeBallY";
  if (/eye.?l?open/i.test(lower)) return "eyeLOpen";
  if (/eye.?r?open/i.test(lower)) return "eyeROpen";
  if (/eye.*smile/i.test(lower)) return "eyeSmile";
  if (/mouth.*form/i.test(lower)) return "mouthForm";
  if (/mouth.*open.*y/i.test(lower)) return "mouthOpenY";
  if (/body.*angle.?x/i.test(lower)) return "bodyAngleX";
  if (/body.*angle.?y/i.test(lower)) return "bodyAngleY";
  if (/body.*angle.?z/i.test(lower)) return "bodyAngleZ";
  if (/breath/i.test(lower)) return "breath";
  return null;
}

// ── Role emotion templates ─────────────────────────────────────
// Maps emotion names to parameter values using ROLE references.
// Values are on a -1..1 normalized scale, engine scales to actual ranges.
export const ROLE_EMOTIONS: Record<string, Record<string, number>> = {
  senang:    { angleX: 0.17, angleY: -0.1, bodyAngleX: 0.15 },
  sedih:     { angleX: -0.1, angleY: 0.27, bodyAngleX: -0.1, bodyAngleZ: -0.1 },
  malu:      { angleX: -0.27, angleY: 0.17, bodyAngleX: -0.15, bodyAngleZ: -0.05 },
  kaget:     { angleY: -0.33 },
  normal:    {},
};

/**
 * Scale a role-based fraction to the model's actual parameter range.
 */
export function scaleRoleValue(
  roleMap: RoleMap,
  role: string,
  fraction: number
): number {
  const paramId = roleMap.ids[role];
  if (!paramId) return 0;
  const range = roleMap.ranges[paramId];
  if (!range) return fraction * 30; // fallback
  return fraction > 0 ? fraction * range.max : fraction * Math.abs(range.min);
}
