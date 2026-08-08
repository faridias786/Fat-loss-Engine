/**
 * Safety gates.
 *
 * This module decides two booleans that the rest of the engine obeys:
 *   allowDeficit -> may we compute a calorie deficit at all?
 *   allowPlan    -> may we produce a training programme at all?
 *
 * index.mjs must not call the nutrition or planner modules when these are
 * false. That is the whole point: an unsafe plan should be unrepresentable
 * rather than suppressed at render time.
 */

import { bmi, weightAtBmi } from './anthropometry.mjs';
import { PARQ_KEYS, SCOFF_KEYS } from './schema.mjs';

const SEVERITY_RANK = { advisory: 1, clearance: 2, block: 3 };

export function screen(n) {
  const gates = [];
  const add = (code, severity, message, action) =>
    gates.push({ code, severity, message, action });

  const h = n.health ?? {};
  const conditions = new Set(h.conditions ?? []);
  const b = bmi(n.weightKg, n.heightCm);
  const floorWeight = weightAtBmi(18.5, n.heightCm);

  /* ---------------- hard blocks ---------------- */

  if (h.pregnant) {
    add('pregnant', 'block',
      'A calorie deficit is not appropriate during pregnancy.',
      'Nutrition and activity during pregnancy should be guided by your maternity care team.');
  }

  if (h.breastfeeding) {
    add('breastfeeding', 'block',
      'Energy needs while breastfeeding are elevated and an unsupervised deficit can reduce milk supply.',
      'Ask your midwife, GP or a registered dietitian for a plan suited to feeding.');
  }

  if (n.age < 18) {
    add('minor', 'block',
      'This tool is designed for adults.',
      'Growth-stage nutrition and training should be overseen by a paediatrician or a paediatric dietitian.');
  }

  if (b < 18.5) {
    add('bmi_below_range', 'block',
      `A BMI of ${b} is below the healthy range, so fat loss is not an appropriate goal.`,
      'Please speak to a doctor before changing your intake or training.');
  }

  if (n.goalWeightKg != null && n.goalWeightKg < floorWeight) {
    add('goal_below_healthy_range', 'block',
      `A goal of ${Math.round(n.goalWeightKg)} kg falls below the healthy weight range for your height (from about ${floorWeight} kg).`,
      'Choose a goal inside the healthy range, or discuss it with a clinician first.');
  }

  const scoffScore = SCOFF_KEYS.filter((k) => h.scoff?.[k] === true).length;
  if (scoffScore >= 2) {
    add('ed_screen_positive', 'block',
      'Your answers to the eating screen suggest it would be unsafe for this tool to prescribe a deficit.',
      'A GP or an eating-disorder service is the right next step. In the UK, Beat runs a free helpline; the National Alliance for Eating Disorders helpline covers the US.');
  }

  if (conditions.has('eating_disorder_history')) {
    add('ed_history', 'block',
      'With a history of disordered eating, calorie targets and body measurements can be a trigger.',
      'Work with a clinician who knows your history rather than an automated plan.');
  }

  if (h.cycleStatus === 'absent_3m' && !h.pregnant) {
    add('amenorrhea', 'block',
      'Periods absent for three months or more needs investigating before starting a deficit.',
      'See a GP or gynaecologist — this can indicate low energy availability or an untreated hormonal issue.');
  }

  /* ---------------- medical clearance required ---------------- */

  const parqFlags = PARQ_KEYS.filter((k) => h.parq?.[k] === true);
  if (parqFlags.length > 0) {
    add('parq_positive', 'clearance',
      'One or more pre-exercise screening answers need a clinician to sign off first.',
      'Take your PAR-Q+ answers to your GP and ask about safe exercise limits.');
  }

  const CLEARANCE_CONDITIONS = {
    type1_diabetes: 'Exercise and reduced intake both change insulin requirements.',
    cardiac: 'Cardiac conditions need individualised exercise limits.',
    chronic_kidney_disease: 'Protein targets must be set by your renal team, not a calculator.',
    hypertension: 'Blood pressure should be reviewed before starting resistance training.',
  };
  for (const [c, why] of Object.entries(CLEARANCE_CONDITIONS)) {
    if (conditions.has(c)) {
      add(`condition_${c}`, 'clearance', why,
        'Get clearance from the clinician managing this condition before starting.');
    }
  }

  if (n.age >= 70) {
    add('older_adult', 'clearance',
      'Over 70, a quick check with your doctor before a new training programme is sensible.',
      'Ask about any limits on load or intensity.');
  }

  if (b >= 40) {
    add('bmi_class_3', 'clearance',
      'At this BMI, supervised support gets better and safer results than a self-guided plan.',
      'Your GP can refer you to a weight-management service.');
  }

  /* ---------------- advisories (plan proceeds, with notes) ---------------- */

  if (b >= 18.5 && b < 20) {
    add('bmi_low_normal', 'advisory',
      'You are near the bottom of the healthy range, so there is little fat to lose.',
      'Consider training for strength at maintenance calories instead of a deficit.');
  }

  if (conditions.has('pcos')) {
    add('pcos', 'advisory',
      'With PCOS, resistance training and interval work have better evidence for insulin sensitivity than long steady cardio.',
      'The plan is weighted towards strength work for that reason.');
  }

  for (const c of ['insulin_resistance', 'prediabetes', 'type2_diabetes']) {
    if (conditions.has(c)) {
      add(`condition_${c}`, 'advisory',
        'Reduced intake can alter how glucose-lowering medication behaves.',
        'If you take metformin or any glucose-lowering drug, tell your prescriber you are starting a deficit.');
    }
  }

  if (conditions.has('hypothyroid') || conditions.has('hyperthyroid')) {
    add('thyroid', 'advisory',
      'Thyroid function affects energy expenditure, so measured progress may differ from the estimate.',
      'Worth a recheck of levels if progress stalls despite good adherence.');
  }

  if (h.pelvicFloorSymptoms) {
    add('pelvic_floor', 'advisory',
      'High-impact and high-pressure movements have been removed from your plan.',
      'A pelvic health physiotherapist can help you return to impact safely.');
  }

  const injuries = (h.injuries ?? []).filter((i) => i && i !== 'none');
  if (injuries.length) {
    add('injuries', 'advisory',
      `Movements likely to aggravate your ${injuries.join(', ')} have been limited.`,
      'Stop any movement that causes pain and get it assessed.');
  }

  if (n.sleepHours < 6) {
    add('short_sleep', 'advisory',
      'Sleeping under six hours reliably increases appetite and reduces training quality.',
      'Sleep is the highest-leverage change available to you right now.');
  }

  if (n.stress >= 5) {
    add('high_stress', 'advisory',
      'High stress makes aggressive deficits much harder to sustain.',
      'A smaller deficit you can hold beats a large one you abandon.');
  }

  if (scoffScore === 1) {
    add('ed_screen_borderline', 'advisory',
      'One answer on the eating screen is worth keeping an eye on.',
      'If your relationship with food or your body feels distressing, speak to a GP.');
  }

  /* ---------------- resolve ---------------- */

  const worst = gates.reduce(
    (acc, g) => Math.max(acc, SEVERITY_RANK[g.severity] ?? 0), 0);

  const allowDeficit = worst < SEVERITY_RANK.block;
  const allowPlan = worst < SEVERITY_RANK.clearance;

  const status = worst === SEVERITY_RANK.block ? 'refer_clinician'
    : worst === SEVERITY_RANK.clearance ? 'clearance_required'
      : worst === SEVERITY_RANK.advisory ? 'ok_with_advisories'
        : 'ok';

  return {
    status,
    allowDeficit,
    allowPlan,
    gates,
    restrictions: buildRestrictions(n, conditions),
  };
}

/** Translates health input into filters the planner can apply mechanically. */
function buildRestrictions(n, conditions) {
  const h = n.health ?? {};
  const excludeTags = new Set();
  const injuries = new Set((h.injuries ?? []).filter((i) => i && i !== 'none'));

  let maxImpact = n.impactAllowed ?? 'moderate';
  if (h.pelvicFloorSymptoms) {
    maxImpact = 'low';
    excludeTags.add('pelvic_floor_caution');
  }
  if (n.noiseConstrained && maxImpact === 'high') maxImpact = 'moderate';

  if (injuries.has('low_back')) {
    excludeTags.add('spinal_flexion');
    excludeTags.add('spinal_load');
  }
  if (injuries.has('neck')) excludeTags.add('spinal_flexion');
  if (injuries.has('shoulder')) excludeTags.add('overhead');
  if (injuries.has('knee')) excludeTags.add('deep_knee_flexion');
  if (conditions.has('hypertension')) excludeTags.add('overhead');

  // Beginners get coached-lift exclusions until they have some training age.
  if (n.experience === 'none') excludeTags.add('needs_coaching');

  let maxDifficulty = 3;
  if (n.experience === 'none') maxDifficulty = 1;
  else if (n.experience === 'beginner') maxDifficulty = 2;

  return {
    maxImpact,
    maxDifficulty,
    excludeTags: [...excludeTags],
    excludeIds: [...(n.dislikedExerciseIds ?? [])],
  };
}
