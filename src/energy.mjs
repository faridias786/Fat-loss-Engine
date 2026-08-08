/**
 * Energy and macronutrient targets.
 *
 * TDEE design note: the usual "BMR x activity multiplier" approach bakes
 * exercise into the multiplier, so adding workout calories on top double
 * counts them. Here the multiplier covers non-exercise activity only
 * (occupation and daily movement) and training energy is added explicitly
 * from the generated programme. That keeps the calorie target and the
 * training plan consistent with each other, and makes the number auditable.
 */

import { bmi, weightAtBmi } from './anthropometry.mjs';

export const KCAL_PER_KG_FAT = 7700;

/** Non-exercise activity multipliers applied to BMR. */
const NEAT_FACTOR = {
  sedentary: 1.20,   // desk job, little walking
  light: 1.30,       // some walking, standing part of the day
  active: 1.45,      // on feet most of the day
  very_active: 1.60, // manual labour
};

/** Absolute intake floors below which self-guided dieting is unsafe. */
const INTAKE_FLOOR = { female: 1200, male: 1500, unspecified: 1200 };

const MAX_DEFICIT_FRACTION = 0.25;
const DEFAULT_RATE_PCT = 0.0075; // 0.75% of bodyweight per week

const r0 = (x) => Math.round(x);
const r1 = (x) => Math.round(x * 10) / 10;

/** Mifflin-St Jeor. */
export function bmr({ weightKg, heightCm, age, sex }) {
  const constant = sex === 'male' ? 5 : sex === 'female' ? -161 : -78;
  return r0(10 * weightKg + 6.25 * heightCm - 5 * age + constant);
}

export function tdee({ bmrValue, occupationActivity, weeklyExerciseKcal = 0 }) {
  const factor = NEAT_FACTOR[occupationActivity] ?? NEAT_FACTOR.sedentary;
  const neat = bmrValue * factor;
  return {
    neatKcal: r0(neat),
    exerciseKcalPerDay: r0(weeklyExerciseKcal / 7),
    total: r0(neat + weeklyExerciseKcal / 7),
    neatFactor: factor,
  };
}

/**
 * Reference weight for protein. Dosing protein on the scale weight of
 * someone with a lot of fat mass produces absurd targets, so above BMI 30
 * we use adjusted body weight.
 */
export function proteinReferenceWeight(weightKg, heightCm) {
  const b = bmi(weightKg, heightCm);
  if (b <= 30) return { refWeightKg: r1(weightKg), method: 'actual' };
  const ideal = weightAtBmi(25, heightCm);
  return {
    refWeightKg: r1(ideal + 0.25 * (weightKg - ideal)),
    method: 'adjusted_body_weight',
  };
}

/**
 * @param {object} a
 * @param {number} a.tdeeTotal
 * @param {number} a.bmrValue
 * @param {number} a.weightKg
 * @param {number} [a.requestedWeeklyLossKg] from timeline module
 * @param {string} a.sex
 */
export function deficit({ tdeeTotal, bmrValue, weightKg, requestedWeeklyLossKg, sex }) {
  const requested = requestedWeeklyLossKg ?? weightKg * DEFAULT_RATE_PCT;
  const rawDaily = (requested * KCAL_PER_KG_FAT) / 7;

  const clamps = [];

  // Cap 1: never more than 25% below maintenance.
  const maxByFraction = tdeeTotal * MAX_DEFICIT_FRACTION;
  let dailyDeficit = rawDaily;
  if (dailyDeficit > maxByFraction) {
    dailyDeficit = maxByFraction;
    clamps.push('capped_at_25pct_of_tdee');
  }

  // Cap 2: intake must clear both the absolute floor and BMR.
  const floor = Math.max(INTAKE_FLOOR[sex] ?? 1200, bmrValue);
  if (tdeeTotal - dailyDeficit < floor) {
    dailyDeficit = Math.max(0, tdeeTotal - floor);
    clamps.push('capped_at_intake_floor');
  }

  const intake = r0(tdeeTotal - dailyDeficit);
  const achievableWeeklyLossKg = r1((dailyDeficit * 7) / KCAL_PER_KG_FAT);

  return {
    intakeKcal: intake,
    dailyDeficitKcal: r0(dailyDeficit),
    deficitPctOfTdee: r1((dailyDeficit / tdeeTotal) * 100),
    requestedWeeklyLossKg: r1(requested),
    achievableWeeklyLossKg,
    achievableRatePctPerWeek: r1((achievableWeeklyLossKg / weightKg) * 100),
    intakeFloorKcal: r0(floor),
    clamps,
    /** true when we could not deliver the requested rate safely */
    reducedFromRequest: achievableWeeklyLossKg < r1(requested) - 0.01,
  };
}

export function macros({ intakeKcal, weightKg, heightCm, dietPattern }) {
  const { refWeightKg, method } = proteinReferenceWeight(weightKg, heightCm);

  // Plant-forward diets have lower average protein quality and digestibility,
  // so the target is nudged up rather than left identical.
  const bump = dietPattern === 'vegan' ? 1.1
    : dietPattern === 'vegetarian' ? 1.05 : 1;

  const proteinLow = Math.round(refWeightKg * 1.6 * bump);
  const proteinHigh = Math.round(refWeightKg * 2.2 * bump);

  // At low intakes an aggressive g/kg target would crowd out essential fat and
  // leave too few carbohydrates to train on, so cap protein at 40% of energy.
  const proteinCap = Math.floor((intakeKcal * 0.4) / 4);
  const proteinIdeal = Math.round(refWeightKg * 1.9 * bump);
  const proteinTarget = Math.min(proteinIdeal, proteinCap);
  const proteinCapped = proteinTarget < proteinIdeal;

  const fatMin = Math.round(refWeightKg * 0.6);
  const fatTarget = Math.max(fatMin, Math.round((intakeKcal * 0.28) / 9));

  const remaining = intakeKcal - proteinTarget * 4 - fatTarget * 9;
  const carbTarget = Math.max(50, Math.round(remaining / 4));

  return {
    proteinReferenceWeightKg: refWeightKg,
    proteinReferenceMethod: method,
    proteinG: { min: proteinLow, target: proteinTarget, max: proteinHigh },
    proteinCapped,
    fatG: { min: fatMin, target: fatTarget },
    carbG: { target: carbTarget },
    fibreG: Math.round((intakeKcal / 1000) * 14),
    proteinPerKgUsed: r1((proteinTarget / refWeightKg)),
  };
}
