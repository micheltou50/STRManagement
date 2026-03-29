/**
 * Splits assets/js/main.js into contiguous line ranges (preserves execution order).
 * Covers lines 62–10139. Nine module files + app.js entry.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MAIN = path.join(ROOT, 'assets/js/main.js');
const OUT = path.join(ROOT, 'assets/js');

const SLICES = [
  { file: 'utils.js', start: 62, end: 106 },
  { file: 'notifications.js', start: 107, end: 327 },
  { file: 'state.js', start: 328, end: 1161 },
  { file: 'render.js', start: 1162, end: 2905 },
  { file: 'finance.js', start: 2906, end: 4904 },
  { file: 'bookings.js', start: 4905, end: 5891 },
  { file: 'cleaning.js', start: 5892, end: 7230 },
  { file: 'property.js', start: 7231, end: 9415 },
  { file: 'ai.js', start: 9416, end: 10139 },
];

const lines = fs.readFileSync(MAIN, 'utf8').split(/\r?\n/);

let total = 0;
for (const { file, start, end } of SLICES) {
  const n = end - start + 1;
  total += n;
  const chunk = lines.slice(start - 1, end).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT, file), chunk, 'utf8');
  console.log(file, start + '-' + end, '(' + n + ')');
}
console.log('Total lines:', total, 'expected 10078');
