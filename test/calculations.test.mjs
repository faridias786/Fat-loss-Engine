import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bmi, navyBodyFat, weightAtBmi, waistToHeight, whtrBand } from '../src/anthropometry.mjs';
import { bmr, tdee, deficit, macros, proteinReferenceWeight } from '../src/energy.mjs';
import { assess } from '../src/timeline.mjs';
import { normalise } from '../src/schema.mjs';

test('Mifflin-St Jeor matches hand calculation (female)', () => {
  // 10(70) + 6.25(165) - 5(30) - 161 = 700 + 1031.25 - 150 - 161 = 1420.25
  assert.equal(bmr({ weightKg: 70, heightCm: 165, age: 30, sex: 'female' }), 1420);
});

test('Mifflin-St Jeor matches hand calculation (male)', () => {
  // 10(80) + 6.25(180) - 5(30) + 5 = 800 + 1125 - 150 + 5 = 1780
  assert.equal(bmr({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' }), 1780);
});

test('unspecified sex uses a value between the two constants', () => {
  const f = bmr({ weightKg: 70, heightCm: 165, age: 30, sex: 'female' });
  const m = bmr({ weightKg: 70, heightCm: 165, age: 30, sex: 'male' });
  const u = bmr({ weightKg: 70, heightCm: 165, age: 30, sex: 'unspecified' });
  assert.ok(u > f && u < m, `${u} should sit between ${f} and ${m}`);
});

test('BMI and healthy weight range', () => {
  assert.equal(bmi(70, 165), 25.7);
  assert.equal(weightAtBmi(25, 165), 68.1);
  assert.equal(weightAtBmi(18.5, 165), 50.4);
});

test('waist-to-height banding', () => {
  assert.equal(waistToHeight(82.5, 165), 0.5);
  assert.equal(whtrBand(0.45), 'healthy');
  assert.equal(whtrBand(0.55), 'increased_risk');
  assert.equal(whtrBand(0.62), 'high_risk');
});

test('Navy body fat returns null rather than guessing when inputs are missing', () => {
  assert.equal(navyBodyFat({ sex: 'female', heightCm: 165, waistCm: 80 }), null);
  assert.equal(navyBodyFat({ sex: 'female', heightCm: 165, waistCm: 80, neckCm: 32 }), null);
  assert.ok(navyBodyFat({
    sex: 'female', heightCm: 165, waistCm: 80, neckCm: 32, hipCm: 100,
  }) > 0);
});

test('Navy body fat is in a plausible range for a known input', () => {
  const pct = navyBodyFat({
    sex: 'female', heightCm: 165, waistCm: 80, neckCm: 32, hipCm: 100,
  });
  assert.ok(pct > 28 && pct < 36, `got ${pct}`);
});

test('TDEE separates non-exercise activity from training energy', () => {
  const e = tdee({ bmrValue: 1400, occupationActivity: 'sedentary', weeklyExerciseKcal: 1400 });
  assert.equal(e.neatKcal, 1680);        // 1400 * 1.20
  assert.equal(e.exerciseKcalPerDay, 200); // 1400 / 7
  assert.equal(e.total, 1880);
});

test('deficit is capped at 25% of maintenance', () => {
  const d = deficit({
    tdeeTotal: 2000, bmrValue: 1200, weightKg: 80,
    requestedWeeklyLossKg: 2.0, sex: 'female',
  });
  assert.ok(d.clamps.includes('capped_at_25pct_of_tdee'));
  assert.ok(d.deficitPctOfTdee <= 25.01, `got ${d.deficitPctOfTdee}`);
  assert.equal(d.reducedFromRequest, true);
});

test('intake never falls below the floor or BMR', () => {
  const d = deficit({
    tdeeTotal: 1700, bmrValue: 1450, weightKg: 60,
    requestedWeeklyLossKg: 1.5, sex: 'female',
  });
  assert.ok(d.intakeKcal >= 1450, `intake ${d.intakeKcal} below BMR`);
  assert.ok(d.clamps.length > 0);
});

test('a modest request passes through unclamped', () => {
  const d = deficit({
    tdeeTotal: 2200, bmrValue: 1400, weightKg: 70,
    requestedWeeklyLossKg: 0.5, sex: 'female',
  });
  assert.equal(d.clamps.length, 0);
  assert.equal(d.reducedFromRequest, false);
  assert.equal(d.dailyDeficitKcal, 550); // 0.5 * 7700 / 7
});

test('protein uses adjusted body weight above BMI 30', () => {
  const lean = proteinReferenceWeight(65, 165);
  assert.equal(lean.method, 'actual');

  const heavy = proteinReferenceWeight(110, 165);
  assert.equal(heavy.method, 'adjusted_body_weight');
  assert.ok(heavy.refWeightKg < 110 && heavy.refWeightKg > 68,
    `got ${heavy.refWeightKg}`);
});

test('protein target scales up for plant-based diets', () => {
  const omni = macros({ intakeKcal: 1800, weightKg: 70, heightCm: 165, dietPattern: 'omnivore' });
  const vegan = macros({ intakeKcal: 1800, weightKg: 70, heightCm: 165, dietPattern: 'vegan' });
  assert.ok(vegan.proteinG.target > omni.proteinG.target);
});

test('macros respect an essential fat minimum', () => {
  const m = macros({ intakeKcal: 1300, weightKg: 70, heightCm: 165, dietPattern: 'omnivore' });
  assert.ok(m.fatG.target >= m.fatG.min);
  assert.ok(m.carbG.target >= 50);
});

test('timeline flags an impossible request and counter-proposes', () => {
  const n = normalise({
    age: 30, sex: 'female', weightKg: 80, heightCm: 165,
    goalWeightKg: 60, timeframeWeeks: 8,
  });
  const t = assess(n);
  assert.equal(t.feasible, false);
  assert.equal(t.reason, 'rate_too_fast');
  assert.equal(t.counterProposals.length, 2);

  const extend = t.counterProposals.find((c) => c.type === 'extend_timeframe');
  assert.ok(extend.weeks > 8);
  assert.equal(extend.goalWeightKg, 60);

  const adjust = t.counterProposals.find((c) => c.type === 'adjust_goal');
  assert.equal(adjust.weeks, 8);
  assert.ok(adjust.goalWeightKg > 60);
});

test('counter-proposed goal never drops below a healthy BMI', () => {
  const n = normalise({
    age: 30, sex: 'female', weightKg: 95, heightCm: 165,
    goalWeightKg: 52, timeframeWeeks: 4,
  });
  const t = assess(n);
  const adjust = t.counterProposals.find((c) => c.type === 'adjust_goal');
  assert.ok(adjust.goalWeightKg >= weightAtBmi(18.5, 165));
});

test('a realistic timeframe is accepted', () => {
  const n = normalise({
    age: 30, sex: 'female', weightKg: 80, heightCm: 165,
    goalWeightKg: 74, timeframeWeeks: 12,
  });
  const t = assess(n);
  assert.equal(t.feasible, true);
  assert.ok(t.ratePctPerWeek <= 1.01);
});

test('imperial input is converted before any maths runs', () => {
  const n = normalise({
    units: 'imperial', age: 30, sex: 'female',
    weightKg: 154, heightCm: 65, // lb and inches
    measurements: { waistCm: 32 },
  });
  assert.ok(Math.abs(n.weightKg - 69.85) < 0.1, `got ${n.weightKg}`);
  assert.ok(Math.abs(n.heightCm - 165.1) < 0.1, `got ${n.heightCm}`);
  assert.ok(Math.abs(n.measurements.waistCm - 81.28) < 0.1);
  assert.equal(n.units, 'metric');
});
