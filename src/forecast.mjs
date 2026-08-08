/**
 * Weekly simulation of the deficit.
 *
 * Why this exists: a linear projection ("14 kg at 1 kg/week = 14 weeks") is
 * always optimistic, for two compounding reasons.
 *
 *   1. BMR falls as bodyweight falls, so maintenance drops and the same
 *      intake produces a smaller deficit every week.
 *   2. Training energy also scales with bodyweight — the same session burns
 *      less as you get lighter.
 *
 * On top of that, the intake floor eventually caps the deficit entirely, so
 * some goals are unreachable at a given activity level no matter how long you
 * wait. Reporting that honestly is the whole point of this module.
 */

import { bmr, tdee, deficit } from './energy.mjs';

const MAX_WEEKS = 156;
const STALL_THRESHOLD_KG = 0.05; // weekly loss below this counts as stalled
const r1 = (x) => Math.round(x * 10) / 10;

/**
 * @param {object} a
 * @param {number} a.startWeightKg
 * @param {number} [a.goalWeightKg]
 * @param {number} a.heightCm
 * @param {number} a.age
 * @param {string} a.sex
 * @param {string} a.occupationActivity
 * @param {number} a.weeklyExerciseKcalAtStart
 * @param {number} a.targetRateFraction fraction of bodyweight per week
 * @param {number} [a.horizonWeeks] cap the simulation for display purposes
 */
export function simulate({
  startWeightKg, goalWeightKg, heightCm, age, sex,
  occupationActivity, weeklyExerciseKcalAtStart,
  targetRateFraction, horizonWeeks,
}) {
  let weight = startWeightKg;
  const trajectory = [{ week: 0, weightKg: r1(weight) }];

  let reachedGoal = false;
  let stalledAtWeek = null;
  let weeksTaken = null;
  const limit = Math.min(MAX_WEEKS, horizonWeeks ?? MAX_WEEKS);

  for (let week = 1; week <= limit; week++) {
    const bmrW = bmr({ weightKg: weight, heightCm, age, sex });

    // Training energy scales with the mass being moved.
    const exerciseKcal = weeklyExerciseKcalAtStart * (weight / startWeightKg);

    const expenditure = tdee({
      bmrValue: bmrW,
      occupationActivity,
      weeklyExerciseKcal: exerciseKcal,
    });

    const d = deficit({
      tdeeTotal: expenditure.total,
      bmrValue: bmrW,
      weightKg: weight,
      requestedWeeklyLossKg: weight * targetRateFraction,
      sex,
    });

    const loss = d.achievableWeeklyLossKg;

    if (loss < STALL_THRESHOLD_KG) {
      stalledAtWeek = week;
      break;
    }

    weight -= loss;

    if (week % 2 === 0 || week === limit) {
      trajectory.push({
        week,
        weightKg: r1(weight),
        intakeKcal: d.intakeKcal,
        maintenanceKcal: expenditure.total,
      });
    }

    if (goalWeightKg != null && weight <= goalWeightKg) {
      reachedGoal = true;
      weeksTaken = week;
      trajectory.push({
        week, weightKg: r1(weight),
        intakeKcal: d.intakeKcal, maintenanceKcal: expenditure.total,
      });
      break;
    }
  }

  return {
    reachedGoal,
    weeksToGoal: weeksTaken,
    finalWeightKg: r1(weight),
    totalLossKg: r1(startWeightKg - weight),
    stalledAtWeek,
    unreachableAtThisActivityLevel:
      goalWeightKg != null && !reachedGoal && stalledAtWeek != null,
    trajectory,
  };
}

/**
 * Compares the naive timeline estimate against the simulation and produces
 * the message the UI should actually show.
 */
export function reconcile({ timeline, simulation, goalWeightKg }) {
  if (goalWeightKg == null) {
    return {
      basis: 'no_goal',
      message: 'No target weight set, so no completion date is projected.',
      simulation,
    };
  }

  if (simulation.unreachableAtThisActivityLevel) {
    return {
      basis: 'unreachable',
      simulation,
      message: `At your current activity level the deficit closes at about `
        + `${simulation.finalWeightKg} kg (around week ${simulation.stalledAtWeek}), `
        + `because intake cannot safely go lower. Reaching your goal needs more `
        + `daily movement or more training, not fewer calories.`,
      remedy: 'increase_activity',
    };
  }

  if (!simulation.reachedGoal) {
    return {
      basis: 'beyond_horizon',
      simulation,
      message: `Projected to reach about ${simulation.finalWeightKg} kg within `
        + `the simulated period rather than your goal. Re-run this after a few `
        + `weeks with fresh numbers.`,
    };
  }

  const naive = timeline.estimatedWeeks ?? timeline.counterProposals
    ?.find((c) => c.type === 'extend_timeframe')?.weeks;

  const optimismWeeks = naive == null ? null : simulation.weeksToGoal - naive;

  return {
    basis: 'simulated',
    simulation,
    weeksToGoal: simulation.weeksToGoal,
    naiveEstimateWeeks: naive ?? null,
    optimismWeeks,
    message: optimismWeeks != null && optimismWeeks > 1
      ? `About ${simulation.weeksToGoal} weeks. A flat-rate estimate would have `
        + `said ${naive}, but maintenance calories fall as you lose weight, so `
        + `progress slows even with perfect adherence.`
      : `About ${simulation.weeksToGoal} weeks at a sustainable rate.`,
  };
}
