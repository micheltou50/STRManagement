#!/usr/bin/env node
/**
 * StayOps — assemble the static web app into ./www for Capacitor.
 *
 * StayOps has no bundler: on Netlify it's served straight from the repo root.
 * Capacitor copies its entire `webDir` into the native app, so we can't point it
 * at the repo root (that would bundle .git, node_modules, Netlify/, etc. into the
 * .ipa). This script copies just the front-end the app shell needs into ./www,
 * which is what capacitor.config.json's `webDir` points at.
 *
 * Run by codemagic.yaml before `npx cap sync ios`, and locally before cap add/sync.
 */
import { existsSync, rmSync, mkdirSync, cpSync, copyFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'www');

// Directories and files that make up the static front-end (everything that
// index.html and manifest.json reference). assets/ holds all JS + CSS.
const DIRS = ['assets'];
const FILES = ['index.html', 'manifest.json', 'sw.js'];
// Plus every root-level icon (icon-host-192.png, icon-host-512.png, ...).
const ICONS = readdirSync(ROOT).filter((f) => /\.(png|ico)$/i.test(f));

// Clean rebuild so deletions in source propagate to www/.
rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });

let copied = 0;
for (const d of DIRS) {
  const src = join(ROOT, d);
  if (existsSync(src)) { cpSync(src, join(WWW, d), { recursive: true }); copied++; }
}
for (const f of [...FILES, ...ICONS]) {
  const src = join(ROOT, f);
  if (existsSync(src)) { copyFileSync(src, join(WWW, f)); copied++; }
}

console.log(`build-www: assembled www/ from ${copied} items (dirs: ${DIRS.join(', ')}; icons: ${ICONS.length})`);
