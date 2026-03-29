/**
 * Pass 1 — shared app state only: storage keys, load/save, in-memory arrays.
 * Everything else stays in main.js until later passes.
 */
import { lsKey } from './config.js';
import { saveBookingsToCloud, saveCleansToCloud, saveNotesToCloud } from './supabase.js';

export { lsKey };

export function loadJSON(key, fallback) {
  fallback = fallback !== undefined ? fallback : [];
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch (e) {
    console.warn('loadJSON failed for', key, e);
    return fallback;
  }
}

/** Mutate a shared array export in place (importers cannot reassign `export let` bindings). */
export function replaceArrayInPlace(target, items) {
  if (!Array.isArray(target) || !Array.isArray(items)) return;
  target.length = 0;
  items.forEach((x) => target.push(x));
}

export let bookings = loadJSON(lsKey('bookings'));
export let cleans = loadJSON(lsKey('cleans'));
export let notes = loadJSON(lsKey('notes'));
export let expenses = JSON.parse(localStorage.getItem(lsKey('expenses')) || '[]');
export let maintenance = JSON.parse(localStorage.getItem(lsKey('maintenance')) || '[]');
export let inventory = JSON.parse(localStorage.getItem(lsKey('inventory')) || '[]');

export function reloadArraysFromLocalStorage() {
  replaceArrayInPlace(bookings, loadJSON(lsKey('bookings')));
  replaceArrayInPlace(cleans, loadJSON(lsKey('cleans')));
  replaceArrayInPlace(notes, loadJSON(lsKey('notes')));
  replaceArrayInPlace(expenses, JSON.parse(localStorage.getItem(lsKey('expenses')) || '[]'));
  replaceArrayInPlace(maintenance, JSON.parse(localStorage.getItem(lsKey('maintenance')) || '[]'));
  replaceArrayInPlace(inventory, JSON.parse(localStorage.getItem(lsKey('inventory')) || '[]'));
}

export function save() {
  localStorage.setItem(lsKey('bookings'), JSON.stringify(bookings));
  localStorage.setItem(lsKey('cleans'), JSON.stringify(cleans));
  localStorage.setItem(lsKey('notes'), JSON.stringify(notes));
  if (typeof saveBookingsToCloud === 'function') saveBookingsToCloud(bookings).catch(() => {});
  if (typeof saveCleansToCloud === 'function') saveCleansToCloud(cleans).catch(() => {});
  if (typeof saveNotesToCloud === 'function') saveNotesToCloud(notes).catch(() => {});
}
