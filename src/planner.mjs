/**
 * Programme generator.
 *
 * Design: sessions are built from movement-pattern slots, and each slot is
 * resolved to a concrete exercise at generation time by filtering the library
 * against the user's kit and contraindications. Adding a new equipment type
 * later is a data change, not a rewrite of this file.
 *
 * Rotation policy:
 *   compound slots hold for a MESOCYCLE_WEEKS block so load can progress and
 *   the progress signal stays readable;
 *   accessory, core and conditioning slots rotate every session.
 */

import { eligible, coverage } from './library.mjs';

export const MESOCYCLE_WEEKS = 5;

/* ---------------- deterministic RNG ---------------- */

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- session templates ---------------- */

const S = (pattern, slot) => ({ pattern, slot });

const TEMPLATES = {
  fullA: { name: 'Full Body A', slots: [S('squat', 'compound'), S('push_h', 'compound'), S('pull_h', 'compound'), S('hinge', 'accessory'), S('core', 'core'), S('conditioning', 'conditioning')] },
  fullB: { name: 'Full Body B', slots: [S('hinge', 'compound'), S('push_v', 'compound'), S('pull_v', 'compound'), S('lunge', 'accessory'), S('core', 'core'), S('conditioning', 'conditioning')] },
  fullC: { name: 'Full Body C', slots: [S('lunge', 'compound'), S('push_h', 'compound'), S('pull_h', 'compound'), S('hinge', 'accessory'), S('core', 'core'), S('conditioning', 'conditioning')] },
  upperA: { name: 'Upper A', slots: [S('push_h', 'compound'), S('pull_h', 'compound'), S('push_v', 'compound'), S('pull_v', 'accessory'), S('arms', 'accessory'), S('core', 'core')] },
  upperB: { name: 'Upper B', slots: [S('push_v', 'compound'), S('pull_v', 'compound'), S('push_h', 'compound'), S('pull_h', 'accessory'), S('arms', 'accessory'), S('core', 'core')] },
  lowerA: { name: 'Lower A', slots: [S('squat', 'compound'), S('hinge', 'compound'), S('lunge', 'accessory'), S('calf', 'accessory'), S('core', 'core')] },
  lowerB: { name: 'Lower B', slots: [S('hinge', 'compound'), S('squat', 'compound'), S('lunge', 'accessory'), S('calf', 'accessory'), S('core', 'core')] },
  push: { name: 'Push', slots: [S('push_h', 'compound'), S('push_v', 'compound'), S('push_h', 'accessory'), S('arms', 'accessory'), S('core', 'core')] },
  pull: { name: 'Pull', slots: [S('pull_v', 'compound'), S('pull_h', 'compound'), S('pull_h', 'accessory'), S('arms', 'accessory'), S('core', 'core')] },
  legs: { name: 'Legs', slots: [S('squat', 'compound'), S('hinge', 'compound'), S('lunge', 'accessory'), S('calf', 'accessory'), S('core', 'core')] },
};

const SPLITS = {
  1: ['fullA'],
  2: ['fullA', 'fullB'],
  3: ['fullA', 'fullB', 'fullC'],
  4: ['upperA', 'lowerA', 'upperB', 'lowerB'],
  5: ['upperA', 'lowerA', 'fullC', 'upperB', 'lowerB'],
  6: ['push', 'pull', 'legs', 'push', 'pull', 'legs'],
  7: ['push', 'pull', 'legs', 'push', 'pull', 'legs', 'fullC'],
};

/* ---------------- prescription ---------------- */

const SLOT_MINUTES = { compound: 9, accessory: 6, core: 5, conditioning: 0 };
const WARMUP_MINUTES = 7;

/**
 * Pattern-level mapping for the optional focus-area bonus slot. This does not
 * claim spot reduction — it adds extra strengthening volume for the chosen
 * area, gated by remaining session time, from the same restriction-filtered
 * pool everything else comes from.
 */
const EMPHASIS_PATTERNS = {
  belly: ['core'],
  arms: ['arms'],
  legs: ['squat', 'lunge', 'calf'],
  glutes: ['hinge', 'lunge'],
  back: ['pull_h', 'pull_v'],
  chest: ['push_h'],
  shoulders: ['push_v'],
};

const EMPHASIS_LABEL = {
  belly: 'core',
  arms: 'arm',
  legs: 'leg',
  glutes: 'glute',
  back: 'back',
  chest: 'chest',
  shoulders: 'shoulder',
};

/** Which focus area a given circumference target maps to, for auto-selection. */
const MEASUREMENT_EMPHASIS = {
  waistCm: 'belly',
  bellyCm: 'belly',
  hipCm: 'glutes',
  thighCm: 'legs',
  armCm: 'arms',
};

const MEASUREMENT_NOUN = {
  waistCm: 'waist', bellyCm: 'belly', hipCm: 'hip', thighCm: 'thigh', armCm: 'arm',
};

/**
 * Picks the training focus area. An explicit `input.emphasis` always wins.
 * Otherwise, if the user has set a target below their current measurement
 * for waist/belly/hip/thigh/arm, the area with the largest gap is used —
 * still just extra strengthening volume, never a claim that it shrinks that
 * one circumference directly.
 */
export function resolveEmphasis(input) {
  if (input.emphasis && input.emphasis !== 'none') {
    return { area: input.emphasis, source: 'manual' };
  }

  const cur = input.measurements ?? {};
  const tgt = input.measurementTargets ?? {};
  let best = null;

  for (const [key, area] of Object.entries(MEASUREMENT_EMPHASIS)) {
    const c = cur[key];
    const t = tgt[key];
    if (c == null || t == null) continue;
    const gapCm = c - t;
    if (gapCm <= 0) continue;
    if (!best || gapCm > best.gapCm) best = { area, gapCm, measurement: key };
  }

  return best
    ? { area: best.area, source: 'auto', measurement: best.measurement, gapCm: best.gapCm }
    : { area: 'none', source: 'none' };
}

function prescribe(slot, experience) {
  const novice = experience === 'none' || experience === 'beginner';
  if (slot === 'compound') {
    return novice
      ? { sets: 3, reps: '8-12', rirCue: 'stop 3 reps short of failure', restSec: 90 }
      : { sets: 4, reps: '6-10', rirCue: 'stop 1-2 reps short of failure', restSec: 120 };
  }
  if (slot === 'accessory') {
    return { sets: novice ? 2 : 3, reps: '10-15', rirCue: 'stop 2 reps short of failure', restSec: 60 };
  }
  if (slot === 'core') {
    return { sets: 3, reps: '30-45s or 10-15 reps', rirCue: 'keep form strict', restSec: 45 };
  }
  return { sets: 1, reps: 'continuous', rirCue: 'conversational pace unless intervals', restSec: 0 };
}

/* ---------------- energy cost ---------------- */

function metFor(ex, slot) {
  if (slot === 'conditioning') {
    if (ex.impact === 'high') return 9.0;
    if (ex.impact === 'moderate') return 7.0;
    return ex.difficulty >= 2 ? 6.0 : 4.0;
  }
  if (slot === 'core') return 3.5;
  return 5.0; // resistance work
}

const kcalFor = (met, weightKg, minutes) => (met * 3.5 * weightKg) / 200 * minutes;

/* ---------------- selection ---------------- */

/**
 * Quality score for a candidate.
 *
 * Loadable movements are preferred for strength slots because progressive
 * overload is the mechanism that retains muscle in a deficit, and you cannot
 * add load to a doorway row. Without this, a user who owns dumbbells can be
 * handed a bodyweight substitute purely by chance.
 *
 * Conditioning is exempt: brisk walking is not worse than a machine.
 */
function scoreFor(ex, slot) {
  if (slot === 'conditioning' || slot === 'core') return 0;
  let score = 0;
  if (!ex.bodyweight) score += 3;   // can be loaded, therefore progressed
  score += ex.difficulty;            // prefer the harder end of what is allowed
  return score;
}

function pick(pool, { rng, usedIds, usedFamilies, slot = 'accessory' }) {
  const fresh = pool.filter(
    (ex) => !usedIds.has(ex.id) && !usedFamilies.has(ex.progression_family));
  const candidates = fresh.length ? fresh
    : pool.filter((ex) => !usedIds.has(ex.id));
  if (!candidates.length) return null;

  // Keep a band rather than only the single best option, so rotation still
  // produces variety across blocks.
  const scored = candidates.map((ex) => ({ ex, score: scoreFor(ex, slot) }));
  const best = Math.max(...scored.map((s) => s.score));
  const band = scored.filter((s) => s.score >= best - 1).map((s) => s.ex);

  return band[Math.floor(rng() * band.length)];
}

/**
 * @param {object} args
 * @param {object} args.input normalised input
 * @param {object} args.restrictions from screening
 * @param {number} [args.week] 1-based week number
 * @param {object[]} args.exercises library records
 */
export function generateWeek({ input, restrictions, week = 1, exercises }) {
  const kit = input.equipment ?? [];
  const pool = eligible(exercises, { kit, ...restrictions });
  const cov = coverage(pool);

  const warnings = [];
  const block = Math.floor((week - 1) / MESOCYCLE_WEEKS);
  const splitKeys = SPLITS[Math.min(7, Math.max(1, input.daysPerWeek))];

  // Time budget: warm-up first, resistance slots next, conditioning gets what
  // is left. Slots are dropped from the end rather than compressed.
  const budget = input.minutesPerSession;

  const resolved = resolveEmphasis(input);
  const emphasisPatterns = EMPHASIS_PATTERNS[resolved.area];
  const emphasisSlotType = resolved.area === 'belly' ? 'core' : 'accessory';
  const emphasisCost = emphasisPatterns ? SLOT_MINUTES[emphasisSlotType] : 0;

  const sessions = splitKeys.map((key, dayIdx) => {
    const tpl = TEMPLATES[key];
    const usedIds = new Set();
    const usedFamilies = new Set();

    // Reserve the focus-slot budget up front so a greedy conditioning slot
    // (which otherwise claims all remaining time) cannot crowd it out.
    let remaining = budget - WARMUP_MINUTES - emphasisCost;
    const chosen = [];

    for (const s of tpl.slots) {
      const cost = SLOT_MINUTES[s.slot];
      if (s.slot !== 'conditioning' && remaining < cost) continue;

      const patternPool = pool.filter(
        (ex) => ex.pattern === s.pattern
          && (s.slot === 'conditioning'
            ? ex.tags.includes('conditioning')
            : s.slot === 'core'
              ? ex.tags.includes('core')
              : ex.tags.includes(s.slot === 'compound' ? 'compound' : 'accessory')));

      if (!patternPool.length) {
        warnings.push({
          code: 'pattern_unavailable',
          pattern: s.pattern,
          slot: s.slot,
          message: `No ${s.pattern} option matches your equipment and restrictions.`,
        });
        continue;
      }

      // Honesty about variety: if a slot has only one eligible option it will
      // look repetitive week after week, and the user deserves to know why
      // rather than assuming the app is lazy.
      if (patternPool.length === 1) {
        warnings.push({
          code: 'no_rotation_available',
          pattern: s.pattern,
          slot: s.slot,
          message: `Only one ${s.pattern} option fits your equipment and level, `
            + `so this slot will not rotate yet.`,
        });
      }

      // Compounds hold across a block; everything else rotates per session.
      const seedStr = s.slot === 'compound'
        ? `${input.seed}|${key}|${s.pattern}|block${block}`
        : `${input.seed}|${key}|${s.pattern}|${s.slot}|week${week}|${dayIdx}`;
      const rng = mulberry32(hashString(seedStr));

      const ex = pick(patternPool, { rng, usedIds, usedFamilies, slot: s.slot });
      if (!ex) continue;

      usedIds.add(ex.id);
      usedFamilies.add(ex.progression_family);

      const minutes = s.slot === 'conditioning'
        ? Math.max(0, remaining)
        : cost;
      remaining -= minutes;

      chosen.push({
        exerciseId: ex.id,
        name: ex.name,
        pattern: ex.pattern,
        slot: s.slot,
        minutes,
        impact: ex.impact,
        difficulty: ex.difficulty,
        unilateral: ex.unilateral,
        rotatesWith: s.slot === 'compound' ? `block_${block}` : 'each_session',
        ...prescribe(s.slot, input.experience),
      });
    }

    // Optional focus-area bonus: extra strengthening volume for the chosen
    // area when the session has time left. Drawn from the same pool as
    // everything else, so equipment and restrictions still apply. The
    // budget for this was reserved above, before conditioning could claim it.
    if (emphasisPatterns) {
      remaining += emphasisCost;
      if (remaining >= emphasisCost) {
        const focusPool = pool.filter((ex) =>
          emphasisPatterns.includes(ex.pattern)
          && !usedIds.has(ex.id)
          && ex.tags.includes(emphasisSlotType === 'core' ? 'core' : 'accessory'));

        if (focusPool.length) {
          const seedStr = `${input.seed}|${key}|focus_${resolved.area}|week${week}|${dayIdx}`;
          const rng = mulberry32(hashString(seedStr));
          const ex = pick(focusPool, { rng, usedIds, usedFamilies, slot: emphasisSlotType });

          if (ex) {
            usedIds.add(ex.id);
            usedFamilies.add(ex.progression_family);
            remaining -= emphasisCost;

            chosen.push({
              exerciseId: ex.id,
              name: ex.name,
              pattern: ex.pattern,
              slot: 'focus',
              energySlot: emphasisSlotType,
              minutes: emphasisCost,
              impact: ex.impact,
              difficulty: ex.difficulty,
              unilateral: ex.unilateral,
              rotatesWith: 'each_session',
              ...prescribe(emphasisSlotType, input.experience),
            });
          }
        }
      }
    }

    // Warm-up: mobility items, rotating freely.
    const mobPool = pool.filter((ex) => ex.tags.includes('mobility'));
    const warmRng = mulberry32(hashString(`${input.seed}|warm|${key}|${week}`));
    const warmUsedIds = new Set();
    const warmUsedFam = new Set();
    const warmup = [];
    for (let i = 0; i < 4 && mobPool.length; i++) {
      const ex = pick(mobPool, {
        rng: warmRng, usedIds: warmUsedIds, usedFamilies: warmUsedFam,
      });
      if (!ex) break;
      warmUsedIds.add(ex.id);
      warmUsedFam.add(ex.progression_family);
      warmup.push({ exerciseId: ex.id, name: ex.name, minutes: WARMUP_MINUTES / 4 });
    }

    const kcal = chosen.reduce(
      (sum, item) => sum + kcalFor(
        metFor({ impact: item.impact, difficulty: item.difficulty }, item.energySlot ?? item.slot),
        input.weightKg, item.minutes),
      kcalFor(2.5, input.weightKg, WARMUP_MINUTES));

    return {
      day: dayIdx + 1,
      name: tpl.name,
      warmup,
      exercises: chosen,
      totalMinutes: budget - Math.max(0, remaining),
      estimatedKcal: Math.round(kcal),
    };
  });

  const weeklyExerciseKcal = sessions.reduce((s, x) => s + x.estimatedKcal, 0);

  // Deduplicate warnings and attach the equipment nudge where it applies.
  const seen = new Set();
  const uniqueWarnings = warnings.filter((w) => {
    const k = `${w.code}:${w.pattern}:${w.slot}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    week,
    blockIndex: block,
    weeksUntilRotation: MESOCYCLE_WEEKS - ((week - 1) % MESOCYCLE_WEEKS),
    sessions,
    weeklyExerciseKcal: Math.round(weeklyExerciseKcal),
    poolSize: pool.length,
    patternCoverage: cov,
    warnings: uniqueWarnings,
    equipmentNudge: buildNudge(exercises, restrictions, kit, cov),
    emphasisNote: emphasisPatterns
      ? {
        area: resolved.area,
        source: resolved.source,
        message: `Extra ${EMPHASIS_LABEL[resolved.area]} work has been added where the `
          + 'session had time. This strengthens the muscles in that area — fat loss itself '
          + 'is systemic and cannot be targeted to one body part, no matter which exercises you do.'
          + (resolved.source === 'auto'
            ? ` Picked automatically because your ${MEASUREMENT_NOUN[resolved.measurement]} target `
              + `is ${Math.round(resolved.gapCm * 10) / 10} cm below your current measurement — the `
              + 'largest gap of the targets you set.'
            : ''),
      }
      : null,
  };
}

/**
 * Quantifies what one cheap purchase would unlock. Honest version of an
 * upsell: it reports the actual delta in available exercises.
 */
function buildNudge(exercises, restrictions, kit, cov) {
  const CANDIDATES = ['bands', 'dumbbells', 'pull_up_bar'];
  const base = eligible(exercises, { kit, ...restrictions }).length;
  const options = [];

  for (const item of CANDIDATES) {
    if (kit.includes(item)) continue;
    const withItem = eligible(exercises, {
      kit: [...kit, item], ...restrictions,
    });
    const covWith = coverage(withItem);
    const unlockedPatterns = Object.keys(covWith)
      .filter((p) => (cov[p] ?? 0) === 0 && covWith[p] > 0);
    options.push({
      item,
      additionalExercises: withItem.length - base,
      unlocksPatterns: unlockedPatterns,
    });
  }

  options.sort((a, b) =>
    b.unlocksPatterns.length - a.unlocksPatterns.length
    || b.additionalExercises - a.additionalExercises);

  return options.filter((o) => o.additionalExercises > 0).slice(0, 2);
}
