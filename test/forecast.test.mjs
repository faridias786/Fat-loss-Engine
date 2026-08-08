import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { simulate, reconcile } from '../src/forecast.mjs';
import { buildPlan } from '../src/index.mjs';

const sim = (over = {}) => simulate({
  startWeightKg: 82, goalWeightKg: 68, heightCm: 164, age: 31, sex: 'female',
  occupationActivity: 'sedentary', weeklyExerciseKcalAtStart: 900,
  targetRateFraction: 0.0075, ...over,
});

test('weight decreases monotonically', () => {
  const s = sim();
  for (let i = 1; i < s.trajectory.length; i++) {
    assert.ok(s.trajectory[i].weightKg <= s.trajectory[i - 1].weightKg);
  }
});

test('loss slows over time as maintenance falls', () => {
  const s = sim({ goalWeightKg: null });
  const t = s.trajectory.filter((p) => p.week > 0);
  const early = t[0].weightKg - t[1].weightKg;
  const late = t[t.length - 2].weightKg - t[t.length - 1].weightKg;
  assert.ok(late <= early + 1e-9,
    `late loss ${late} should not exceed early loss ${early}`);
});

test('maintenance calories fall across the simulation', () => {
  const s = sim({ goalWeightKg: null });
  const withKcal = s.trajectory.filter((p) => p.maintenanceKcal);
  assert.ok(withKcal.at(-1).maintenanceKcal < withKcal[0].maintenanceKcal);
});

test('the simulation is slower than a flat-rate projection', () => {
  const s = sim();
  const naiveWeeks = Math.ceil(14 / (82 * 0.0075));
  assert.ok(s.reachedGoal);
  assert.ok(s.weeksToGoal > naiveWeeks,
    `simulated ${s.weeksToGoal} should exceed naive ${naiveWeeks}`);
});

test('a very low goal is slow but not impossible for a typical adult', () => {
  // Because the floor is max(1200, BMR) while NEAT is BMR x 1.2, roughly 20%
  // of headroom always remains, so loss decays asymptotically rather than
  // stopping. This documents that behaviour deliberately.
  const s = sim({ goalWeightKg: 47, weeklyExerciseKcalAtStart: 200 });
  assert.equal(s.reachedGoal, true);
  assert.ok(s.weeksToGoal > 100, `took ${s.weeksToGoal} weeks`);
  assert.equal(s.stalledAtWeek, null);
});

test('the stall guard fires when maintenance drops below the intake floor', () => {
  // Small, older adult: BMR is low enough that BMR x 1.2 sits under the
  // 1200 kcal floor, so no safe deficit exists at this activity level.
  const s = simulate({
    startWeightKg: 50, goalWeightKg: 44, heightCm: 150, age: 65,
    sex: 'female', occupationActivity: 'sedentary',
    weeklyExerciseKcalAtStart: 100, targetRateFraction: 0.0075,
  });
  assert.equal(s.reachedGoal, false);
  assert.equal(s.stalledAtWeek, 1);
  assert.equal(s.unreachableAtThisActivityLevel, true);
  assert.equal(s.totalLossKg, 0);
});

test('raising activity rescues an otherwise stalled scenario', () => {
  const args = {
    startWeightKg: 50, goalWeightKg: 44, heightCm: 150, age: 65,
    sex: 'female', targetRateFraction: 0.0075,
  };
  const stalled = simulate({
    ...args, occupationActivity: 'sedentary', weeklyExerciseKcalAtStart: 100,
  });
  const rescued = simulate({
    ...args, occupationActivity: 'active', weeklyExerciseKcalAtStart: 1200,
  });
  assert.equal(stalled.unreachableAtThisActivityLevel, true);
  assert.equal(rescued.reachedGoal, true);
});

test('more training energy reaches the goal sooner', () => {
  const low = sim({ weeklyExerciseKcalAtStart: 600 });
  const high = sim({ weeklyExerciseKcalAtStart: 2500 });
  assert.ok(high.weeksToGoal < low.weeksToGoal);
});

test('a higher activity occupation reaches the goal sooner', () => {
  const sed = sim({ occupationActivity: 'sedentary' });
  const act = sim({ occupationActivity: 'active' });
  assert.ok(act.weeksToGoal < sed.weeksToGoal);
});

/* ---------------- integration ---------------- */

test('the plan forecast supersedes the naive timeline', () => {
  const r = buildPlan({
    age: 31, sex: 'female', weightKg: 82, heightCm: 164,
    goalWeightKg: 68, timeframeWeeks: 14,
    daysPerWeek: 3, minutesPerSession: 45, experience: 'beginner',
    equipment: ['dumbbells', 'bands'], seed: 'forecast-1',
  });
  assert.ok(r.forecast);
  assert.ok(['simulated', 'unreachable', 'beyond_horizon'].includes(r.forecast.basis));
});

test('when the floor binds, the advice is to move more, not eat less', () => {
  const r = buildPlan({
    age: 55, sex: 'female', weightKg: 62, heightCm: 170,
    goalWeightKg: 56, timeframeWeeks: 8,
    occupationActivity: 'sedentary', daysPerWeek: 2, minutesPerSession: 30,
    experience: 'none', equipment: [], seed: 'floor-1',
  });
  const codes = r.nutrition.recommendations.map((x) => x.code);
  assert.ok(codes.includes('floor_reached'), JSON.stringify(codes));

  const advice = r.nutrition.recommendations.find((x) => x.code === 'floor_reached');
  assert.match(advice.message, /add movement/i);
  assert.ok(advice.actions.some((a) => /steps/i.test(a)));
});

test('a goal below healthy BMI is blocked before the forecast ever runs', () => {
  // 50kg at 172cm is a BMI of about 16.9, so screening must catch it first.
  const r = buildPlan({
    age: 60, sex: 'female', weightKg: 60, heightCm: 172,
    goalWeightKg: 50, timeframeWeeks: 12,
    occupationActivity: 'sedentary', daysPerWeek: 2, minutesPerSession: 25,
    experience: 'none', equipment: [], seed: 'unreachable-1',
  });
  assert.equal(r.status, 'refer_clinician');
  assert.equal(r.forecast, undefined, 'no forecast should be computed');
  assert.equal(r.nutrition, null);
  assert.ok(r.gates.some((g) => g.code === 'goal_below_healthy_range'));
});

test('reconcile reports the activity remedy when the simulation stalls', () => {
  const stalled = simulate({
    startWeightKg: 50, goalWeightKg: 44, heightCm: 150, age: 65,
    sex: 'female', occupationActivity: 'sedentary',
    weeklyExerciseKcalAtStart: 100, targetRateFraction: 0.0075,
  });
  const f = reconcile({
    timeline: { estimatedWeeks: 16 }, simulation: stalled, goalWeightKg: 44,
  });
  assert.equal(f.basis, 'unreachable');
  assert.equal(f.remedy, 'increase_activity');
  assert.match(f.message, /more daily movement/i);
});

test('protein cap engages at very low intakes', () => {
  const r = buildPlan({
    age: 30, sex: 'female', weightKg: 95, heightCm: 158,
    daysPerWeek: 2, minutesPerSession: 30, experience: 'none',
    equipment: [], seed: 'cap-1',
  });
  if (r.nutrition) {
    const p = r.nutrition.macros;
    const pctFromProtein = (p.proteinG.target * 4) / r.nutrition.intakeKcal;
    assert.ok(pctFromProtein <= 0.401, `protein was ${(pctFromProtein * 100).toFixed(1)}%`);
  }
});

test('macros always sum to roughly the intake target', () => {
  const r = buildPlan({
    age: 31, sex: 'female', weightKg: 82, heightCm: 164,
    goalWeightKg: 70, daysPerWeek: 3, minutesPerSession: 45,
    experience: 'beginner', equipment: ['dumbbells'], seed: 'macro-sum',
  });
  const m = r.nutrition.macros;
  const kcal = m.proteinG.target * 4 + m.fatG.target * 9 + m.carbG.target * 4;
  assert.ok(Math.abs(kcal - r.nutrition.intakeKcal) < 60,
    `macros sum to ${kcal} vs intake ${r.nutrition.intakeKcal}`);
});
