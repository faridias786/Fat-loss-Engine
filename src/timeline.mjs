/**
 * Timeline feasibility.
 *
 * If the requested rate is unsafe this returns a counter-proposal. It never
 * returns "impossible" without an alternative, because a user who is told
 * only "no" will pick a worse plan somewhere else.
 */

import { bmi, weightAtBmi } from './anthropometry.mjs';

const r1 = (x) => Math.round(x * 10) / 10;

/** Sustainable loss as a fraction of bodyweight per week. */
const SAFE_RATE = { min: 0.005, mid: 0.0075, max: 0.010 };

/** Higher starting BMI tolerates a slightly faster rate early on. */
function maxRateFor(bmiValue) {
  if (bmiValue >= 35) return 0.0125;
  if (bmiValue >= 30) return 0.0110;
  return SAFE_RATE.max;
}

export function assess(n) {
  const b = bmi(n.weightKg, n.heightCm);
  const maxRate = maxRateFor(b);
  const floorWeight = weightAtBmi(18.5, n.heightCm);

  // No explicit goal: run at the default sustainable rate, open-ended.
  if (n.goalWeightKg == null) {
    return {
      hasGoal: false,
      feasible: true,
      weeklyLossKg: r1(n.weightKg * SAFE_RATE.mid),
      ratePctPerWeek: r1(SAFE_RATE.mid * 100),
      note: 'No target weight given, so a sustainable default rate is used.',
    };
  }

  const totalLossKg = r1(n.weightKg - n.goalWeightKg);

  if (totalLossKg <= 0) {
    return {
      hasGoal: true, feasible: false, totalLossKg,
      reason: 'goal_not_below_current',
      note: 'Your goal weight is not below your current weight.',
    };
  }

  const weeksAtMid = Math.ceil(totalLossKg / (n.weightKg * SAFE_RATE.mid));
  const weeksAtMax = Math.ceil(totalLossKg / (n.weightKg * maxRate));

  // No timeframe given: propose one.
  if (n.timeframeWeeks == null) {
    return {
      hasGoal: true, feasible: true, totalLossKg,
      weeklyLossKg: r1(n.weightKg * SAFE_RATE.mid),
      ratePctPerWeek: r1(SAFE_RATE.mid * 100),
      estimatedWeeks: weeksAtMid,
      note: `About ${weeksAtMid} weeks at a sustainable rate.`,
    };
  }

  const requestedWeekly = totalLossKg / n.timeframeWeeks;
  const requestedRate = requestedWeekly / n.weightKg;

  if (requestedRate <= maxRate) {
    return {
      hasGoal: true, feasible: true, totalLossKg,
      weeklyLossKg: r1(requestedWeekly),
      ratePctPerWeek: r1(requestedRate * 100),
      estimatedWeeks: n.timeframeWeeks,
      note: 'Requested timeframe is within a sustainable rate.',
    };
  }

  // Infeasible — counter-propose. Two options: more time, or a smaller goal
  // inside the original timeframe.
  const achievableLossInTimeframe = r1(
    n.weightKg * maxRate * n.timeframeWeeks);
  const achievableWeight = r1(n.weightKg - achievableLossInTimeframe);

  return {
    hasGoal: true,
    feasible: false,
    reason: 'rate_too_fast',
    totalLossKg,
    requestedRatePctPerWeek: r1(requestedRate * 100),
    maxRatePctPerWeek: r1(maxRate * 100),
    // fall back to the fastest safe rate so downstream maths still works
    weeklyLossKg: r1(n.weightKg * maxRate),
    ratePctPerWeek: r1(maxRate * 100),
    counterProposals: [
      {
        type: 'extend_timeframe',
        weeks: weeksAtMax,
        goalWeightKg: n.goalWeightKg,
        label: `Same goal, about ${weeksAtMax} weeks instead of ${n.timeframeWeeks}.`,
      },
      {
        type: 'adjust_goal',
        weeks: n.timeframeWeeks,
        goalWeightKg: Math.max(achievableWeight, floorWeight),
        label: `Keep ${n.timeframeWeeks} weeks and aim for about ${Math.max(achievableWeight, floorWeight)} kg.`,
      },
    ],
    note: `Losing ${totalLossKg} kg in ${n.timeframeWeeks} weeks needs ${r1(requestedRate * 100)}% of bodyweight per week. Above about ${r1(maxRate * 100)}% you mostly lose muscle and water, and it rarely holds.`,
  };
}
