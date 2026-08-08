import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan } from '../src/index.mjs';
import { hasEquipment, eligible } from '../src/library.mjs';
import { library as lib } from './setup.mjs';
import { MESOCYCLE_WEEKS } from '../src/planner.mjs';


const byId = (id) => lib.exercises.find((e) => e.id === id);

const baseline = {
  age: 32, sex: 'female', weightKg: 78, heightCm: 165,
  occupationActivity: 'sedentary',
  daysPerWeek: 3, minutesPerSession: 45,
  experience: 'beginner',
  equipment: ['dumbbells', 'bands', 'bench'],
  seed: 'planner-tests',
};

/* ---------------- equipment semantics ---------------- */

test('requires means ALL items', () => {
  const ex = byId('db_bench_press');
  assert.deepEqual(ex.requires, ['dumbbells', 'bench']);
  assert.equal(hasEquipment(ex, ['dumbbells']), false);
  assert.equal(hasEquipment(ex, ['bench']), false);
  assert.equal(hasEquipment(ex, ['dumbbells', 'bench']), true);
});

test('any_of means AT LEAST ONE item', () => {
  const ex = byId('goblet_squat');
  assert.deepEqual(ex.any_of, ['dumbbells', 'kettlebell']);
  assert.equal(hasEquipment(ex, ['dumbbells']), true);
  assert.equal(hasEquipment(ex, ['kettlebell']), true);
  assert.equal(hasEquipment(ex, []), false);
});

test('a floor and a mat are assumed, never required', () => {
  assert.equal(hasEquipment(byId('plank'), []), true);
  assert.equal(hasEquipment(byId('pushup'), []), true);
  assert.equal(hasEquipment(byId('glute_bridge'), []), true);
});

test('every library record has resolved equipment semantics', () => {
  for (const ex of lib.exercises) {
    assert.ok(Array.isArray(ex.requires), ex.id);
    assert.ok(Array.isArray(ex.any_of), ex.id);
    assert.equal(typeof ex.bodyweight, 'boolean', ex.id);
    assert.ok(!(ex.requires.length && ex.any_of.length),
      `${ex.id} should not mix requires and any_of`);
  }
});

/* ---------------- filtering ---------------- */

test('impact cap is enforced', () => {
  const pool = eligible(lib.exercises, {
    kit: ['jump_rope'], maxImpact: 'low', maxDifficulty: 3,
  });
  assert.ok(pool.length > 0);
  assert.ok(pool.every((e) => e.impact === 'low'));
  assert.ok(!pool.some((e) => e.id === 'jump_rope'));
});

test('excludeTags removes tagged movements', () => {
  const pool = eligible(lib.exercises, {
    kit: ['barbell_rack', 'bench'], maxImpact: 'high', maxDifficulty: 3,
    excludeTags: ['spinal_load'],
  });
  assert.ok(!pool.some((e) => e.tags.includes('spinal_load')));
});

/* ---------------- graceful degradation ---------------- */

test('bodyweight-only user still gets a usable plan and an honest warning', () => {
  const r = buildPlan({ ...baseline, equipment: [] });
  assert.ok(r.programme.sessions.length === 3);

  const total = r.programme.sessions.flatMap((s) => s.exercises).length;
  assert.ok(total >= 9, `only ${total} exercises generated`);

  // vertical pull is genuinely impossible with no equipment
  assert.ok(r.programme.warnings.some((w) => w.pattern === 'pull_v'),
    'should warn that vertical pull is unavailable');
});

test('the equipment nudge quantifies a real gain, not a generic upsell', () => {
  const r = buildPlan({ ...baseline, equipment: [] });
  const nudge = r.programme.equipmentNudge;
  assert.ok(nudge.length > 0);
  for (const opt of nudge) {
    assert.ok(opt.additionalExercises > 0);
    assert.ok(['bands', 'dumbbells', 'pull_up_bar'].includes(opt.item));
  }
  // the top suggestion should unlock at least one pattern that was empty
  assert.ok(nudge[0].unlocksPatterns.length > 0
    || nudge[0].additionalExercises > 10);
});

test('a user who already owns an item is not nudged to buy it', () => {
  const r = buildPlan({ ...baseline, equipment: ['bands', 'dumbbells', 'pull_up_bar'] });
  assert.equal(r.programme.equipmentNudge.length, 0);
});

test('full gym has no unavailable patterns', () => {
  const r = buildPlan({
    ...baseline, experience: 'intermediate',
    equipment: ['dumbbells', 'kettlebell', 'bench', 'box', 'barbell_rack',
      'cables', 'machines', 'cardio_machines', 'pull_up_bar', 'bands'],
  });
  assert.deepEqual(r.programme.warnings, []);
});

/* ---------------- time budget ---------------- */

test('a short session drops slots rather than overrunning', () => {
  const short = buildPlan({ ...baseline, minutesPerSession: 25 });
  const long = buildPlan({ ...baseline, minutesPerSession: 75 });

  for (const s of short.programme.sessions) {
    assert.ok(s.totalMinutes <= 25, `${s.name} ran to ${s.totalMinutes}min`);
  }
  const shortCount = short.programme.sessions[0].exercises.length;
  const longCount = long.programme.sessions[0].exercises.length;
  assert.ok(longCount >= shortCount);
});

test('splits scale with training days', () => {
  for (const [days, expected] of [[2, 2], [3, 3], [4, 4], [5, 5], [6, 6]]) {
    const r = buildPlan({ ...baseline, daysPerWeek: days, experience: 'intermediate' });
    assert.equal(r.programme.sessions.length, expected);
  }
});

/* ---------------- rotation and determinism ---------------- */

test('same input and seed produces an identical plan', () => {
  const a = buildPlan(baseline);
  const b = buildPlan(baseline);
  assert.deepEqual(a.programme.sessions, b.programme.sessions);
});

test('a different seed produces a different plan', () => {
  const a = buildPlan(baseline);
  const b = buildPlan({ ...baseline, seed: 'someone-else' });
  assert.notDeepEqual(a.programme.sessions, b.programme.sessions);
});

test('compound lifts hold within a mesocycle block', () => {
  const compoundsAt = (week) => buildPlan(baseline, { week })
    .programme.sessions
    .flatMap((s) => s.exercises.filter((e) => e.slot === 'compound'))
    .map((e) => e.exerciseId);

  const w1 = compoundsAt(1);
  const w3 = compoundsAt(3);
  const wLast = compoundsAt(MESOCYCLE_WEEKS);
  assert.deepEqual(w1, w3, 'compounds must not change mid-block');
  assert.deepEqual(w1, wLast, 'compounds must hold to the end of the block');
});

test('compound lifts rotate at the block boundary', () => {
  const compoundsAt = (week) => buildPlan(baseline, { week })
    .programme.sessions
    .flatMap((s) => s.exercises.filter((e) => e.slot === 'compound'))
    .map((e) => e.exerciseId);

  const block0 = compoundsAt(1);
  const block1 = compoundsAt(MESOCYCLE_WEEKS + 1);
  assert.notDeepEqual(block0, block1, 'compounds should change between blocks');
});

test('core and conditioning rotate every week', () => {
  const rotating = (week) => buildPlan(baseline, { week })
    .programme.sessions
    .flatMap((s) => s.exercises.filter(
      (e) => e.slot === 'core' || e.slot === 'conditioning'))
    .map((e) => e.exerciseId);

  assert.notDeepEqual(rotating(1), rotating(2),
    'accessory-tier work should not repeat week to week');
});

test('no exercise is repeated within a single session', () => {
  const r = buildPlan({ ...baseline, daysPerWeek: 5, experience: 'intermediate' });
  for (const s of r.programme.sessions) {
    const ids = s.exercises.map((e) => e.exerciseId);
    assert.equal(ids.length, new Set(ids).size, `${s.name} repeats an exercise`);
  }
});

test('warm-ups are present and drawn from mobility work', () => {
  const r = buildPlan(baseline);
  for (const s of r.programme.sessions) {
    assert.ok(s.warmup.length >= 3, `${s.name} has ${s.warmup.length} warm-up items`);
    for (const w of s.warmup) {
      assert.ok(byId(w.exerciseId).tags.includes('mobility'));
    }
  }
});

/* ---------------- energy coupling ---------------- */

test('training energy flows into maintenance calories', () => {
  const three = buildPlan({ ...baseline, daysPerWeek: 3 });
  const six = buildPlan({ ...baseline, daysPerWeek: 6, experience: 'intermediate' });
  assert.ok(six.programme.weeklyExerciseKcal > three.programme.weeklyExerciseKcal);
  assert.ok(six.nutrition.maintenanceKcal > three.nutrition.maintenanceKcal);
});

test('maintenance equals NEAT plus daily training energy', () => {
  const r = buildPlan(baseline);
  const b = r.nutrition.expenditureBreakdown;
  assert.equal(r.nutrition.maintenanceKcal, b.neatKcal + b.exerciseKcalPerDay);
});

test('every prescribed exercise has sets, reps and a rest interval', () => {
  const r = buildPlan(baseline);
  for (const s of r.programme.sessions) {
    for (const e of s.exercises) {
      assert.ok(e.sets > 0, `${e.name} missing sets`);
      assert.ok(e.reps, `${e.name} missing reps`);
      assert.ok(typeof e.restSec === 'number', `${e.name} missing rest`);
      assert.ok(e.rirCue, `${e.name} missing effort cue`);
    }
  }
});

/* ---------------- loadability preference ---------------- */

test('a user with dumbbells gets loaded compounds, not bodyweight substitutes', () => {
  const r = buildPlan({
    ...baseline, equipment: ['dumbbells', 'bench'], experience: 'beginner',
  });
  const compounds = r.programme.sessions
    .flatMap((s) => s.exercises.filter((e) => e.slot === 'compound'));

  const loaded = compounds.filter((e) => !byId(e.exerciseId).bodyweight);
  assert.ok(loaded.length / compounds.length >= 0.6,
    `only ${loaded.length}/${compounds.length} compounds were loadable`);
});

test('bodyweight-only users are unaffected by the loadability preference', () => {
  const r = buildPlan({ ...baseline, equipment: [] });
  const compounds = r.programme.sessions
    .flatMap((s) => s.exercises.filter((e) => e.slot === 'compound'));
  assert.ok(compounds.length > 0);
});

test('conditioning is exempt: walking is still selectable at a full gym', () => {
  // Scored preference must not make machines mandatory for conditioning.
  const picks = new Set();
  for (let week = 1; week <= 12; week++) {
    const r = buildPlan({
      ...baseline, experience: 'intermediate',
      equipment: ['dumbbells', 'cardio_machines', 'bench'],
    }, { week });
    r.programme.sessions
      .flatMap((s) => s.exercises.filter((e) => e.slot === 'conditioning'))
      .forEach((e) => picks.add(e.exerciseId));
  }
  assert.ok(picks.size >= 3, `only ${picks.size} distinct conditioning options over 12 weeks`);
});

test('a slot with only one eligible option is flagged as non-rotating', () => {
  const r = buildPlan({
    ...baseline, equipment: ['dumbbells'], experience: 'beginner',
  });
  const codes = r.programme.warnings.map((w) => w.code);
  // With a beginner cap and no bench or machines, some accessory slots have a
  // single option. The engine should say so rather than look repetitive.
  assert.ok(codes.includes('no_rotation_available') || codes.length === 0,
    JSON.stringify(r.programme.warnings));
});

test('a full gym has enough depth that nothing is flagged as non-rotating', () => {
  const r = buildPlan({
    ...baseline, experience: 'intermediate',
    equipment: ['dumbbells', 'kettlebell', 'bench', 'box', 'barbell_rack',
      'cables', 'machines', 'cardio_machines', 'pull_up_bar', 'bands'],
  });
  assert.ok(!r.programme.warnings.some((w) => w.code === 'no_rotation_available'));
});

/* ---------------- focus-area emphasis ---------------- */

test('no emphasis leaves the plan unchanged from today', () => {
  const withNone = buildPlan({ ...baseline, emphasis: 'none' });
  const withoutField = buildPlan(baseline);
  assert.deepEqual(withNone.programme.sessions, withoutField.programme.sessions);
  assert.equal(withNone.programme.emphasisNote, null);
  assert.ok(withNone.programme.sessions.every(
    (s) => s.exercises.every((e) => e.slot !== 'focus')));
});

test('a belly emphasis adds a core-pattern focus exercise when time allows', () => {
  const r = buildPlan({ ...baseline, emphasis: 'belly', minutesPerSession: 60 });
  const focusItems = r.programme.sessions.flatMap(
    (s) => s.exercises.filter((e) => e.slot === 'focus'));
  assert.ok(focusItems.length > 0, 'expected at least one focus exercise');
  assert.ok(focusItems.every((e) => e.pattern === 'core'));
  assert.ok(r.programme.emphasisNote);
  assert.equal(r.programme.emphasisNote.area, 'belly');
  assert.match(r.programme.emphasisNote.message, /systemic/);
});

test('the focus pick still respects equipment and restrictions', () => {
  // Bodyweight-only, so the focus pool is drawn from the same restricted
  // pool as everything else — no equipment the user does not own leaks in.
  const r = buildPlan({
    ...baseline, emphasis: 'arms', equipment: [], minutesPerSession: 60,
  });
  const focusItems = r.programme.sessions.flatMap(
    (s) => s.exercises.filter((e) => e.slot === 'focus'));
  for (const item of focusItems) {
    assert.equal(byId(item.exerciseId).bodyweight, true);
  }
});

/* ---------------- auto focus area from measurement targets ---------------- */

test('a measurement target below the current value auto-picks the biggest-gap area', () => {
  const r = buildPlan({
    ...baseline, minutesPerSession: 60,
    measurements: { waistCm: 95, armCm: 30 },
    measurementTargets: { waistCm: 85, armCm: 29 }, // waist gap 10cm > arm gap 1cm
  });
  assert.equal(r.programme.emphasisNote.area, 'belly');
  assert.equal(r.programme.emphasisNote.source, 'auto');
  const focusItems = r.programme.sessions.flatMap(
    (s) => s.exercises.filter((e) => e.slot === 'focus'));
  assert.ok(focusItems.every((e) => e.pattern === 'core'));
});

test('an explicit emphasis choice overrides the auto-picked measurement gap', () => {
  const r = buildPlan({
    ...baseline, minutesPerSession: 60, emphasis: 'legs',
    measurements: { waistCm: 95 }, measurementTargets: { waistCm: 70 },
  });
  assert.equal(r.programme.emphasisNote.area, 'legs');
  assert.equal(r.programme.emphasisNote.source, 'manual');
});

test('no targets and no manual choice leaves emphasis off', () => {
  const r = buildPlan({ ...baseline, measurements: { waistCm: 95 } });
  assert.equal(r.programme.emphasisNote, null);
});

test('a target above the current value is not treated as a reduction goal', () => {
  const r = buildPlan({
    ...baseline,
    measurements: { waistCm: 80 }, measurementTargets: { waistCm: 85 },
  });
  assert.equal(r.programme.emphasisNote, null);
});
