import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan } from '../src/index.mjs';
import { screen } from '../src/screening.mjs';
import { normalise } from '../src/schema.mjs';

/** A user who should sail through every gate. */
const baseline = {
  age: 32, sex: 'female', weightKg: 78, heightCm: 165,
  goalWeightKg: 70, timeframeWeeks: 20,
  occupationActivity: 'sedentary',
  daysPerWeek: 3, minutesPerSession: 45,
  experience: 'beginner',
  locations: ['home'], equipment: ['dumbbells', 'bands', 'bench'],
  measurements: { waistCm: 88, hipCm: 104, neckCm: 33 },
  seed: 'test-baseline',
};

const withHealth = (patch) => ({
  ...baseline, health: { ...(baseline.health ?? {}), ...patch },
});

test('baseline user gets a full plan', () => {
  const r = buildPlan(baseline);
  assert.ok(['ok', 'ok_with_advisories'].includes(r.status), r.status);
  assert.ok(r.nutrition);
  assert.ok(r.programme);
  assert.equal(r.programme.sessions.length, 3);
});

/* ---------------- hard blocks: nutrition MUST be null ---------------- */

const BLOCKING = [
  ['pregnancy', withHealth({ pregnant: true })],
  ['breastfeeding', withHealth({ breastfeeding: true })],
  ['minor', { ...baseline, age: 16 }],
  ['BMI below range', { ...baseline, weightKg: 45, goalWeightKg: 42 }],
  ['goal below healthy range', { ...baseline, goalWeightKg: 45 }],
  ['positive eating screen', withHealth({ scoff: { sickWhenFull: true, foodDominates: true } })],
  ['eating disorder history', withHealth({ conditions: ['eating_disorder_history'] })],
  ['amenorrhea', withHealth({ cycleStatus: 'absent_3m' })],
];

for (const [label, input] of BLOCKING) {
  test(`blocked: ${label} yields no calorie target and no programme`, () => {
    const r = buildPlan(input);
    assert.equal(r.status, 'refer_clinician', `status was ${r.status}`);
    assert.equal(r.nutrition, null, 'nutrition must be null');
    assert.equal(r.programme, null, 'programme must be null');
    assert.ok(r.referral.length > 0, 'must provide a next step');
    assert.ok(r.referral.every((x) => x.nextStep && x.nextStep.length > 0));
  });
}

test('a blocked result still contains no calorie number anywhere in the payload', () => {
  const r = buildPlan(withHealth({ pregnant: true }));
  const serialised = JSON.stringify(r);
  assert.ok(!/intakeKcal/.test(serialised));
  assert.ok(!/dailyDeficitKcal/.test(serialised));
  assert.ok(!/proteinG/.test(serialised));
});

/* ---------------- clearance required ---------------- */

const CLEARANCE = [
  ['PAR-Q chest pain', withHealth({ parq: { chestPainActivity: true } })],
  ['PAR-Q heart condition', withHealth({ parq: { heartCondition: true } })],
  ['type 1 diabetes', withHealth({ conditions: ['type1_diabetes'] })],
  ['cardiac condition', withHealth({ conditions: ['cardiac'] })],
  ['chronic kidney disease', withHealth({ conditions: ['chronic_kidney_disease'] })],
  ['hypertension', withHealth({ conditions: ['hypertension'] })],
  ['age 72', { ...baseline, age: 72 }],
  ['BMI 41', { ...baseline, weightKg: 112, goalWeightKg: 95 }],
];

for (const [label, input] of CLEARANCE) {
  test(`clearance: ${label} withholds the programme until signed off`, () => {
    const r = buildPlan(input);
    assert.equal(r.status, 'clearance_required', `status was ${r.status}`);
    assert.equal(r.programme, null);
    assert.equal(r.nutrition, null);
    assert.ok(r.referral.length > 0);
  });
}

/* ---------------- advisories proceed ---------------- */

test('PCOS is an advisory, not a block', () => {
  const r = buildPlan(withHealth({ conditions: ['pcos'] }));
  assert.equal(r.status, 'ok_with_advisories');
  assert.ok(r.nutrition);
  assert.ok(r.programme);
  assert.ok(r.gates.some((g) => g.code === 'pcos' && g.severity === 'advisory'));
});

test('type 2 diabetes proceeds but warns about medication interaction', () => {
  const r = buildPlan(withHealth({ conditions: ['type2_diabetes'] }));
  assert.ok(r.nutrition);
  const gate = r.gates.find((g) => g.code === 'condition_type2_diabetes');
  assert.match(gate.action, /prescriber/i);
});

test('a single positive eating-screen answer is advisory, two is blocking', () => {
  const one = buildPlan(withHealth({ scoff: { lostControl: true } }));
  assert.notEqual(one.nutrition, null);
  assert.ok(one.gates.some((g) => g.code === 'ed_screen_borderline'));

  const two = buildPlan(withHealth({ scoff: { lostControl: true, believesFat: true } }));
  assert.equal(two.nutrition, null);
});

test('short sleep and high stress surface as advisories', () => {
  const r = buildPlan({ ...baseline, sleepHours: 5, stress: 5 });
  const codes = r.gates.map((g) => g.code);
  assert.ok(codes.includes('short_sleep'));
  assert.ok(codes.includes('high_stress'));
  assert.ok(r.nutrition);
});

/* ---------------- restrictions feed the planner ---------------- */

test('pelvic floor symptoms remove every non-low-impact movement', () => {
  const r = buildPlan(withHealth({ pelvicFloorSymptoms: true }));
  const all = r.programme.sessions.flatMap((s) => s.exercises);
  assert.ok(all.length > 0);
  for (const ex of all) {
    assert.equal(ex.impact, 'low', `${ex.name} is ${ex.impact} impact`);
  }
});

test('a low back injury removes loaded spinal flexion and axial loading', () => {
  const s = screen(normalise(withHealth({ injuries: ['low_back'] })));
  assert.ok(s.restrictions.excludeTags.includes('spinal_flexion'));
  assert.ok(s.restrictions.excludeTags.includes('spinal_load'));

  const r = buildPlan({
    ...withHealth({ injuries: ['low_back'] }),
    equipment: ['barbell_rack', 'bench', 'dumbbells'],
    experience: 'intermediate',
  });
  const names = r.programme.sessions.flatMap((s2) => s2.exercises).map((e) => e.exerciseId);
  assert.ok(!names.includes('bb_back_squat'));
  assert.ok(!names.includes('conventional_dl'));
  assert.ok(!names.includes('russian_twist'));
});

test('a shoulder injury removes overhead work', () => {
  const r = buildPlan({
    ...withHealth({ injuries: ['shoulder'] }),
    equipment: ['dumbbells', 'bench'], experience: 'intermediate',
  });
  const all = r.programme.sessions.flatMap((s) => s.exercises);
  for (const ex of all) {
    assert.ok(!/overhead|shoulder press|arnold/i.test(ex.name),
      `${ex.name} should have been excluded`);
  }
});

test('complete beginners are not given technical barbell lifts', () => {
  const r = buildPlan({
    ...baseline, experience: 'none',
    equipment: ['barbell_rack', 'bench', 'dumbbells'],
  });
  const ids = r.programme.sessions.flatMap((s) => s.exercises).map((e) => e.exerciseId);
  for (const id of ['bb_back_squat', 'conventional_dl', 'bb_bench_press', 'bb_ohp']) {
    assert.ok(!ids.includes(id), `${id} should not appear for a novice`);
  }
});

test('disliked exercises never appear', () => {
  const r = buildPlan({ ...baseline, dislikedExerciseIds: ['pushup', 'plank', 'goblet_squat'] });
  const ids = r.programme.sessions.flatMap((s) => s.exercises).map((e) => e.exerciseId);
  for (const id of ['pushup', 'plank', 'goblet_squat']) {
    assert.ok(!ids.includes(id));
  }
});

/* ---------------- input validation ---------------- */

test('missing required fields are rejected before any calculation', () => {
  const r = buildPlan({ sex: 'female' });
  assert.equal(r.status, 'invalid_input');
  const fields = r.errors.map((e) => e.field);
  assert.ok(fields.includes('age'));
  assert.ok(fields.includes('weightKg'));
  assert.ok(fields.includes('heightCm'));
});

test('a weight-gain goal is rejected', () => {
  const r = buildPlan({ ...baseline, goalWeightKg: 90 });
  assert.equal(r.status, 'invalid_input');
  assert.ok(r.errors.some((e) => e.field === 'goalWeightKg'));
});

test('unknown enum values are rejected rather than silently ignored', () => {
  const r = buildPlan({ ...baseline, equipment: ['dumbbells', 'jetpack'] });
  assert.equal(r.status, 'invalid_input');
  assert.ok(r.errors.some((e) => /jetpack/.test(e.message)));
});

test('every result carries a disclaimer', () => {
  for (const input of [baseline, withHealth({ pregnant: true }), { sex: 'female' }]) {
    assert.match(buildPlan(input).disclaimer, /not medical/i);
  }
});
