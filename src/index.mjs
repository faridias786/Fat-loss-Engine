/**
 * Engine entry point.
 *
 * The ordering here is the safety mechanism. Nutrition targets and training
 * plans are produced inside branches that are unreachable when screening
 * blocks them, so there is no code path that returns a deficit to a pregnant
 * user or a plan to someone who needs clearance first. A front end cannot
 * bypass this by calling the API directly.
 */

import { normalise, validate } from './schema.mjs';
import { summarise } from './anthropometry.mjs';
import { screen } from './screening.mjs';
import { assess } from './timeline.mjs';
import { generateWeek } from './planner.mjs';
import { bmr, tdee, deficit, macros } from './energy.mjs';
import { simulate, reconcile } from './forecast.mjs';
import { requireLibrary } from './library.mjs';

export const DISCLAIMER =
  'Educational estimates only. This is not medical, dietetic or physiotherapy '
  + 'advice, and it cannot account for anything it was not told. Speak to a '
  + 'qualified clinician before changing your intake or training, especially if '
  + 'you have a health condition or take medication.';

export const MEASUREMENT_PROTOCOL = {
  when: 'First thing in the morning, after the toilet, before eating or drinking.',
  frequency: 'Every 2 weeks. Weekly measurements are mostly noise.',
  tape: 'Snug against skin without compressing it, parallel to the floor.',
  sites: {
    waist: 'Narrowest point, or at the navel if there is no obvious narrowing. Use the same one every time.',
    hip: 'Widest point around the buttocks.',
    neck: 'Just below the larynx, tape sloping slightly down at the front.',
    thigh: 'Widest point of the upper thigh, same leg each time.',
    arm: 'Midway between shoulder and elbow, arm relaxed at your side.',
  },
  note: 'Fat loss is systemic, not local. These numbers track progress; they do '
    + 'not tell you where the next kilo will come from, and no exercise can '
    + 'direct it to a chosen body part.',
};

export const PROGRESS_RULES = {
  weighIn: 'Weigh daily if it does not bother you and compare 7-day averages. '
    + 'Day-to-day swings are water, food volume and cycle phase.',
  expectedNoise: 'Bodyweight can move 1-2 kg within a day. Judge nothing on a single reading.',
  plateau: {
    trigger: 'Seven-day average flat for three consecutive weeks with good adherence.',
    steps: [
      'Check adherence honestly for a week before changing anything — untracked intake is the usual cause.',
      'Add roughly 1,000-2,000 steps per day before cutting calories further.',
      'If still flat, reduce intake by about 5%, never below the intake floor.',
      'Take a week at maintenance if fatigue, sleep or mood are deteriorating.',
    ],
  },
  progressiveOverload:
    'Add load when you hit the top of the rep range on all sets with good form. '
    + 'If load cannot increase, add a rep, slow the lowering phase, or improve range of motion.',
  reassess: 'Re-run this after 4-6 weeks with fresh numbers. Calorie needs fall as you lose weight.',
};

/**
 * @param {object} raw user input, metric or imperial
 * @param {object} [opts]
 * @param {object} [opts.library] library data, if not registered globally
 * @param {number} [opts.week] 1-based week to generate
 */
export function buildPlan(raw, opts = {}) {
  const input = normalise(raw);
  const { ok, errors } = validate(input);

  if (!ok) {
    return { status: 'invalid_input', errors, disclaimer: DISCLAIMER };
  }

  const body = summarise(input);
  const gates = screen(input);

  /* ---- blocked: no nutrition target, no programme ---- */
  if (!gates.allowDeficit) {
    return {
      status: 'refer_clinician',
      body,
      gates: gates.gates,
      nutrition: null,
      programme: null,
      referral: gates.gates
        .filter((g) => g.severity === 'block')
        .map((g) => ({ reason: g.message, nextStep: g.action })),
      disclaimer: DISCLAIMER,
    };
  }

  /* ---- clearance needed: education only ---- */
  if (!gates.allowPlan) {
    return {
      status: 'clearance_required',
      body,
      gates: gates.gates,
      nutrition: null,
      programme: null,
      referral: gates.gates
        .filter((g) => g.severity === 'clearance')
        .map((g) => ({ reason: g.message, nextStep: g.action })),
      measurementProtocol: MEASUREMENT_PROTOCOL,
      disclaimer: DISCLAIMER,
    };
  }

  /* ---- cleared: full output ---- */
  const library = requireLibrary(opts.library);
  const timeline = assess(input);

  const programme = generateWeek({
    input,
    restrictions: gates.restrictions,
    week: opts.week ?? 1,
    exercises: library.exercises,
  });

  const bmrValue = bmr(input);
  const expenditure = tdee({
    bmrValue,
    occupationActivity: input.occupationActivity,
    weeklyExerciseKcal: programme.weeklyExerciseKcal,
  });

  const energy = deficit({
    tdeeTotal: expenditure.total,
    bmrValue,
    weightKg: input.weightKg,
    requestedWeeklyLossKg: timeline.weeklyLossKg,
    sex: input.sex,
  });

  const macroTargets = macros({
    intakeKcal: energy.intakeKcal,
    weightKg: input.weightKg,
    heightCm: input.heightCm,
    dietPattern: input.dietary?.pattern,
  });

  // The naive timeline reasons in bodyweight percentages and does not know
  // about intake floors or the fall in BMR as weight drops. Simulate week by
  // week and let the simulation be the number shown to the user.
  const simulation = simulate({
    startWeightKg: input.weightKg,
    goalWeightKg: input.goalWeightKg,
    heightCm: input.heightCm,
    age: input.age,
    sex: input.sex,
    occupationActivity: input.occupationActivity,
    weeklyExerciseKcalAtStart: programme.weeklyExerciseKcal,
    targetRateFraction: (timeline.ratePctPerWeek ?? 0.75) / 100,
  });

  const forecast = reconcile({
    timeline, simulation, goalWeightKg: input.goalWeightKg,
  });

  return {
    status: gates.status,
    body,
    gates: gates.gates,
    timeline,
    forecast,
    nutrition: {
      bmrKcal: bmrValue,
      maintenanceKcal: expenditure.total,
      expenditureBreakdown: expenditure,
      ...energy,
      macros: macroTargets,
      recommendations: nutritionAdvice(energy, macroTargets, input, forecast),
    },
    programme,
    measurementProtocol: MEASUREMENT_PROTOCOL,
    progressRules: PROGRESS_RULES,
    disclaimer: DISCLAIMER,
  };
}

/**
 * Turns clamp flags into things the user can act on. The important message
 * here: when the intake floor binds, the answer is more movement, never fewer
 * calories. Without this the user sees "0.5%/week" and concludes they should
 * eat less, which is the opposite of what the floor is protecting them from.
 */
function nutritionAdvice(energy, macroTargets, input, forecast) {
  const out = [];

  if (energy.clamps.includes('capped_at_intake_floor')) {
    out.push({
      code: 'floor_reached',
      message: 'Your calorie target is already at the safe floor, so it will not '
        + 'be reduced further. To lose faster, add movement rather than cutting food.',
      actions: [
        'Add 2,000-3,000 steps per day — this typically moves more calories than another food cut.',
        input.daysPerWeek < 4
          ? `Add a fourth training day (currently ${input.daysPerWeek}).`
          : 'Add 10 minutes of low-impact conditioning to two sessions.',
        'Stand or walk during calls if your work allows it.',
      ],
    });
  }

  if (energy.clamps.includes('capped_at_25pct_of_tdee')) {
    out.push({
      code: 'deficit_capped',
      message: 'The deficit you asked for exceeded 25% below maintenance, which '
        + 'reliably costs muscle and adherence. It has been reduced to the cap.',
      actions: ['Expect a slower but far more durable rate of loss.'],
    });
  }

  if (macroTargets.proteinCapped) {
    out.push({
      code: 'protein_capped',
      message: 'Your ideal protein target would take up too much of a calorie '
        + 'budget this size, so it has been capped to leave room for fat and carbohydrate.',
      actions: ['Prioritise protein at each meal rather than chasing the higher figure.'],
    });
  }

  if (input.dietary?.pattern === 'vegan' || input.dietary?.pattern === 'vegetarian') {
    out.push({
      code: 'plant_protein',
      message: 'Plant proteins are less digestible on average, so your target '
        + 'has been raised slightly.',
      actions: [
        'Combine sources across the day (legumes plus grains) rather than relying on one.',
        'Soy, seitan, and dairy or eggs if you eat them are the most efficient options.',
      ],
    });
  }

  if (forecast?.remedy === 'increase_activity') {
    out.push({
      code: 'goal_needs_more_activity',
      message: forecast.message,
      actions: [
        'Raise daily steps before considering any further calorie reduction.',
        'Re-run this with updated numbers once your activity level changes.',
      ],
    });
  }

  return out;
}

export { normalise, validate, screen, assess, generateWeek, simulate };
export { setLibrary, getLibrary } from './library.mjs';
