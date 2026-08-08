/**
 * Exercise library filtering. Deliberately free of any Node built-ins so this
 * runs unchanged in a browser.
 *
 * The data itself is injected rather than read from disk:
 *   Node    -> import { loadLibraryFromDisk } from './library-node.mjs'
 *   Browser -> fetch the JSON and call setLibrary()
 */

let injected = null;

/** Register the library once at startup. */
export function setLibrary(data) {
  if (!data || !Array.isArray(data.exercises)) {
    throw new TypeError('setLibrary expects { exercises: [...] }');
  }
  injected = data;
  return injected;
}

export function getLibrary() {
  return injected;
}

/** Resolves the library for a call, with a message that says what to do next. */
export function requireLibrary(explicit) {
  const lib = explicit ?? injected;
  if (!lib) {
    throw new Error(
      'No exercise library available. In Node call loadLibraryFromDisk() from '
      + 'library-node.mjs; in a browser fetch exercises.json and call '
      + 'setLibrary(). You can also pass { library } to buildPlan().');
  }
  return lib;
}

/** A floor and a mat need no purchase, so they are always in the kit. */
const IMPLICIT = new Set(['none', 'mat']);

const IMPACT_RANK = { low: 0, moderate: 1, high: 2 };

export function hasEquipment(ex, kit) {
  const owned = new Set([...kit, ...IMPLICIT]);
  if (ex.requires.some((e) => !owned.has(e))) return false;
  if (ex.any_of.length && !ex.any_of.some((e) => owned.has(e))) return false;
  return true;
}

export function eligible(exercises, opts) {
  const { kit, maxImpact, maxDifficulty, excludeTags = [], excludeIds = [] } = opts;
  const badTags = new Set(excludeTags);
  const badIds = new Set(excludeIds);
  const impactCap = IMPACT_RANK[maxImpact] ?? 1;

  return exercises.filter((ex) => {
    if (badIds.has(ex.id)) return false;
    if (IMPACT_RANK[ex.impact] > impactCap) return false;
    if (ex.tags.some((t) => badTags.has(t))) return false;
    if (!hasEquipment(ex, kit)) return false;
    const exempt = ex.tags.includes('mobility') || ex.tags.includes('beginner_friendly');
    if (!exempt && ex.difficulty > maxDifficulty) return false;
    return true;
  });
}

/** Coverage report — drives the "a band would unlock this" nudge. */
export function coverage(pool) {
  const byPattern = {};
  for (const ex of pool) {
    byPattern[ex.pattern] = (byPattern[ex.pattern] ?? 0) + 1;
  }
  return byPattern;
}
