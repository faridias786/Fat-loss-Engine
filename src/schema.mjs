/**
 * Single source of truth for the input shape.
 * The UI imports ENUMS from here so the two can't drift.
 */

export const ENUMS = {
  units: ['metric', 'imperial'],
  sex: ['female', 'male', 'unspecified'],
  occupationActivity: ['sedentary', 'light', 'active', 'very_active'],
  experience: ['none', 'beginner', 'intermediate', 'advanced'],
  location: ['home', 'gym', 'outdoors'],
  equipment: [
    'bands', 'dumbbells', 'kettlebell', 'pull_up_bar', 'bench', 'box',
    'barbell_rack', 'trap_bar', 'cables', 'machines', 'cardio_machines',
    'sliders', 'ab_wheel', 'jump_rope', 'sled', 'battle_ropes', 'pool',
    'bicycle',
  ],
  impact: ['low', 'moderate', 'high'],
  cycleStatus: ['regular', 'irregular', 'absent_3m', 'postmenopausal', 'na'],
  dietPattern: ['omnivore', 'pescatarian', 'vegetarian', 'vegan'],
  condition: [
    'pcos', 'hypothyroid', 'hyperthyroid', 'insulin_resistance', 'prediabetes',
    'type2_diabetes', 'type1_diabetes', 'hypertension', 'cardiac',
    'chronic_kidney_disease', 'eating_disorder_history', 'pregnancy_recent',
    'hypermobility', 'asthma', 'none',
  ],
  injury: ['knee', 'shoulder', 'low_back', 'neck', 'wrist', 'ankle', 'hip', 'none'],
  emphasis: ['none', 'belly', 'arms', 'legs', 'back', 'chest', 'shoulders', 'glutes'],
};

/** PAR-Q+ core screen. Any true => medical clearance before exercise. */
export const PARQ_KEYS = [
  'heartCondition',        // heart condition or told to only do medically supervised activity
  'chestPainActivity',     // chest pain during physical activity
  'chestPainRest',         // chest pain in the last month at rest
  'losesBalance',          // loses balance from dizziness / loses consciousness
  'boneJointProblem',      // bone or joint problem worsened by activity
  'bloodPressureMeds',     // prescribed drugs for blood pressure or heart condition
  'otherReason',           // any other reason activity might be unsafe
];

/** SCOFF eating-disorder screen. >=2 true is a positive screen. */
export const SCOFF_KEYS = [
  'sickWhenFull',    // makes self sick because uncomfortably full
  'lostControl',     // worries about having lost control over eating
  'lostWeight',      // lost more than ~6kg in 3 months
  'believesFat',     // believes self to be fat when others say too thin
  'foodDominates',   // food dominates life
];

const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;

export const DEFAULTS = {
  units: 'metric',
  sex: 'female',
  occupationActivity: 'sedentary',
  experience: 'none',
  daysPerWeek: 3,
  minutesPerSession: 45,
  locations: ['home'],
  equipment: [],
  impactAllowed: 'moderate',
  noiseConstrained: false,
  measurements: {},
  measurementTargets: {},
  health: {
    pregnant: false,
    breastfeeding: false,
    conditions: [],
    medications: [],
    injuries: [],
    pelvicFloorSymptoms: false,
    cycleStatus: 'na',
    parq: {},
    scoff: {},
  },
  dietary: { pattern: 'omnivore', allergies: [] },
  sleepHours: 7,
  stress: 3,
  dislikedExerciseIds: [],
  emphasis: 'none',
  seed: 'default',
};

function deepDefault(input, defaults) {
  const out = { ...defaults, ...input };
  for (const k of Object.keys(defaults)) {
    const d = defaults[k];
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      out[k] = deepDefault(input?.[k] ?? {}, d);
    }
  }
  return out;
}

/**
 * Convert imperial input to metric and fill defaults.
 * Never mutates the caller's object.
 */
export function normalise(raw) {
  const input = deepDefault(raw ?? {}, DEFAULTS);
  const imperial = input.units === 'imperial';
  const w = (v) => (v == null ? v : imperial ? v * LB_TO_KG : v);
  const l = (v) => (v == null ? v : imperial ? v * IN_TO_CM : v);

  const m = input.measurements ?? {};
  const t = input.measurementTargets ?? {};
  return {
    ...input,
    units: 'metric',
    weightKg: w(input.weightKg),
    goalWeightKg: w(input.goalWeightKg),
    heightCm: l(input.heightCm),
    measurements: {
      waistCm: l(m.waistCm), hipCm: l(m.hipCm), neckCm: l(m.neckCm),
      bellyCm: l(m.bellyCm), armCm: l(m.armCm), thighCm: l(m.thighCm),
      chestCm: l(m.chestCm), calfCm: l(m.calfCm),
    },
    // Optional aims for individual circumferences. Used only to auto-pick a
    // training focus area (planner.mjs) when the user has not chosen one —
    // never to claim an exercise can shrink that one measurement directly.
    measurementTargets: {
      waistCm: l(t.waistCm), hipCm: l(t.hipCm),
      bellyCm: l(t.bellyCm), armCm: l(t.armCm), thighCm: l(t.thighCm),
    },
  };
}

const RANGES = {
  age: [10, 100],
  weightKg: [25, 400],
  heightCm: [100, 250],
  daysPerWeek: [1, 7],
  minutesPerSession: [10, 180],
  sleepHours: [2, 14],
  stress: [1, 5],
};

/**
 * Structural validation only — this does NOT decide whether it is safe to
 * produce a plan. Safety lives in screening.mjs.
 * @returns {{ok: boolean, errors: {field: string, message: string}[]}}
 */
export function validate(n) {
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });

  for (const f of ['age', 'weightKg', 'heightCm']) {
    if (n[f] == null || Number.isNaN(Number(n[f]))) bad(f, 'required');
  }
  for (const [f, [lo, hi]] of Object.entries(RANGES)) {
    const v = n[f];
    if (v != null && !Number.isNaN(Number(v)) && (v < lo || v > hi)) {
      bad(f, `must be between ${lo} and ${hi}`);
    }
  }
  if (!ENUMS.sex.includes(n.sex)) bad('sex', 'unknown value');
  if (!ENUMS.occupationActivity.includes(n.occupationActivity)) {
    bad('occupationActivity', 'unknown value');
  }
  if (!ENUMS.experience.includes(n.experience)) bad('experience', 'unknown value');
  if (!ENUMS.impact.includes(n.impactAllowed)) bad('impactAllowed', 'unknown value');
  if (!ENUMS.emphasis.includes(n.emphasis)) bad('emphasis', 'unknown value');

  for (const e of n.equipment ?? []) {
    if (!ENUMS.equipment.includes(e)) bad('equipment', `unknown item: ${e}`);
  }
  for (const loc of n.locations ?? []) {
    if (!ENUMS.location.includes(loc)) bad('locations', `unknown item: ${loc}`);
  }
  for (const c of n.health?.conditions ?? []) {
    if (!ENUMS.condition.includes(c)) bad('health.conditions', `unknown item: ${c}`);
  }

  if (n.goalWeightKg != null && n.weightKg != null && n.goalWeightKg > n.weightKg) {
    bad('goalWeightKg', 'this engine only plans fat loss, not gain');
  }
  if (n.timeframeWeeks != null && (n.timeframeWeeks < 1 || n.timeframeWeeks > 156)) {
    bad('timeframeWeeks', 'must be between 1 and 156');
  }
  if (n.health?.cycleStatus && !ENUMS.cycleStatus.includes(n.health.cycleStatus)) {
    bad('health.cycleStatus', 'unknown value');
  }

  return { ok: errors.length === 0, errors };
}
