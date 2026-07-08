#!/bin/sh
# Invariant checker for the finance.js split (see the architecture plan).
# The split must preserve, across finance.js + all finance-*.js slices:
#   1. the exact set of window./globalThis. bridge names (vs the committed baseline)
#   2. zero duplicate function declarations across the finance modules
#   3. every file parses (node --check)
# Usage: sh scripts/check-finance-split.sh   (from repo root; exits non-zero on drift)
set -e
cd "$(dirname "$0")/.."

BASE=scripts/finance-bridges-baseline.txt
NOW=$(mktemp)

grep -hoE "(window|globalThis)\.[A-Za-z_\$][A-Za-z0-9_\$]*[[:space:]]*=" assets/js/finance.js assets/js/finance-*.js 2>/dev/null \
  | sed -E 's/(window|globalThis)\.//; s/[[:space:]]*=$//' | sort -u > "$NOW"

if [ ! -f "$BASE" ]; then
  cp "$NOW" "$BASE"
  echo "baseline created: $(wc -l < "$BASE") bridge names -> $BASE"
fi

if ! diff -u "$BASE" "$NOW" > /dev/null; then
  echo "FAIL: bridge-name set drifted from baseline:"
  diff -u "$BASE" "$NOW" | grep -E "^[+-][^+-]" || true
  exit 1
fi
echo "OK: bridge set identical ($(wc -l < "$NOW") names)"

DUPES=$(grep -hoE "^(async )?function [A-Za-z_\$][A-Za-z0-9_\$]*" assets/js/finance.js assets/js/finance-*.js 2>/dev/null \
  | sed -E 's/^(async )?function //' | sort | uniq -d)
if [ -n "$DUPES" ]; then
  echo "FAIL: duplicate function declarations across finance modules:"
  echo "$DUPES"
  exit 1
fi
echo "OK: no duplicate function declarations"

for f in assets/js/finance.js assets/js/finance-*.js; do
  [ -f "$f" ] || continue
  node --check "$f"
done
echo "OK: all finance modules parse"
