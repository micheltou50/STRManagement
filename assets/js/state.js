/**
 * Shared in-memory app state (cloud-hydrated).
 * Business data is held in these arrays and mutated in-place.
 */

/** Mutate a shared array export in place (importers cannot reassign `export let` bindings). */
export function replaceArrayInPlace(target, items) {
  if (!Array.isArray(target) || !Array.isArray(items)) return;
  target.length = 0;
  items.forEach((x) => target.push(x));
}

export let bookings = [];
export let cleans = [];
export let notes = [];
export let expenses = [];
export let maintenance = [];
export let inventory = [];
