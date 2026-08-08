/** Derived body metrics. All inputs metric. */

const log10 = (x) => Math.log10(x);
const r1 = (x) => Math.round(x * 10) / 10;

export function bmi(weightKg, heightCm) {
  const h = heightCm / 100;
  return r1(weightKg / (h * h));
}

export function bmiCategory(b) {
  if (b < 18.5) return 'underweight';
  if (b < 25) return 'healthy';
  if (b < 30) return 'overweight';
  if (b < 35) return 'obese_1';
  if (b < 40) return 'obese_2';
  return 'obese_3';
}

/** Weight at a given BMI — used for goal sanity checks and protein reference. */
export function weightAtBmi(targetBmi, heightCm) {
  const h = heightCm / 100;
  return r1(targetBmi * h * h);
}

/**
 * Waist-to-height ratio. Better cardiometabolic signal than BMI and needs
 * only two numbers, so it is the metric to lead with in the UI.
 */
export function waistToHeight(waistCm, heightCm) {
  if (!waistCm || !heightCm) return null;
  return Math.round((waistCm / heightCm) * 1000) / 1000;
}

export function whtrBand(ratio) {
  if (ratio == null) return null;
  if (ratio < 0.4) return 'below_range';
  if (ratio < 0.5) return 'healthy';
  if (ratio < 0.6) return 'increased_risk';
  return 'high_risk';
}

export function waistToHip(waistCm, hipCm) {
  if (!waistCm || !hipCm) return null;
  return Math.round((waistCm / hipCm) * 100) / 100;
}

/** WHO thresholds differ by sex. */
export function whrBand(ratio, sex) {
  if (ratio == null) return null;
  const threshold = sex === 'male' ? 0.9 : 0.85;
  return ratio >= threshold ? 'increased_risk' : 'healthy';
}

/**
 * US Navy circumference body-fat estimate. Returns null when the required
 * measurements are missing rather than guessing.
 *
 * Accuracy is roughly +/- 3-4 percentage points, so it is a trend metric,
 * not a diagnosis. Callers should present it as a range.
 */
export function navyBodyFat({ sex, heightCm, waistCm, neckCm, hipCm }) {
  if (!heightCm || !waistCm || !neckCm) return null;
  let pct;
  if (sex === 'male') {
    if (waistCm - neckCm <= 0) return null;
    pct = 495 / (1.0324 - 0.19077 * log10(waistCm - neckCm)
      + 0.15456 * log10(heightCm)) - 450;
  } else {
    if (!hipCm) return null;
    const sum = waistCm + hipCm - neckCm;
    if (sum <= 0) return null;
    pct = 495 / (1.29579 - 0.35004 * log10(sum)
      + 0.221 * log10(heightCm)) - 450;
  }
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 70) return null;
  return r1(pct);
}

export function leanBodyMass(weightKg, bodyFatPct) {
  if (bodyFatPct == null) return null;
  return r1(weightKg * (1 - bodyFatPct / 100));
}

export function summarise(n) {
  const b = bmi(n.weightKg, n.heightCm);
  const m = n.measurements ?? {};
  const whtr = waistToHeight(m.waistCm, n.heightCm);
  const whr = waistToHip(m.waistCm, m.hipCm);
  const bf = navyBodyFat({
    sex: n.sex, heightCm: n.heightCm,
    waistCm: m.waistCm, neckCm: m.neckCm, hipCm: m.hipCm,
  });

  return {
    bmi: b,
    bmiCategory: bmiCategory(b),
    waistToHeight: whtr,
    waistToHeightBand: whtrBand(whtr),
    waistToHip: whr,
    waistToHipBand: whrBand(whr, n.sex),
    bodyFatPct: bf,
    bodyFatRange: bf == null ? null : [r1(bf - 3.5), r1(bf + 3.5)],
    leanBodyMassKg: leanBodyMass(n.weightKg, bf),
    healthyWeightRangeKg: [
      weightAtBmi(18.5, n.heightCm),
      weightAtBmi(25, n.heightCm),
    ],
  };
}
