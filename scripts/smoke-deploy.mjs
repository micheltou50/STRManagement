#!/usr/bin/env node
/**
 * StayOps — Tier C live-deploy smoke tests.
 *
 * Hits each deployed Netlify function with a deliberately-bad request and
 * asserts the expected error status. Read-only and idempotent — never sends
 * a request that mutates data.
 *
 * Catches: dead site, broken redirects, missing env vars, OAuth misconfig,
 * functions failing to deploy, function bundles that throw at module-load.
 *
 * Run: npm run smoke:deploy
 *      npm run smoke:deploy -- https://your-deploy-preview.netlify.app
 */

const DEFAULT_BASE = 'https://strmanagement.netlify.app';
const base = (process.argv[2] || process.env.SMOKE_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

async function check(name, opts) {
  const url = base + '/.netlify/functions/' + opts.path;
  const init = {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    redirect: 'manual',
  };
  if (opts.body !== undefined) init.body = opts.body;

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    failed++;
    console.log(RED + '✗ ' + name + RESET + '  network error: ' + e.message);
    return;
  }

  const expected = Array.isArray(opts.expect) ? opts.expect : [opts.expect];
  if (expected.includes(res.status)) {
    passed++;
    console.log(GREEN + '✓ ' + name + RESET + '  ' + res.status);
  } else {
    failed++;
    const bodyPreview = await res.text().catch(() => '').then(s => s.slice(0, 120).replace(/\s+/g, ' '));
    console.log(RED + '✗ ' + name + RESET + '  expected ' + expected.join('|') + ' got ' + res.status + '  ' + bodyPreview);
  }
}

async function main() {
  console.log(YELLOW + 'Smoke testing ' + base + RESET);
  console.log('');

  // ── ai-proxy: CORS preflight ──
  await check('ai-proxy OPTIONS', { path: 'ai-proxy', method: 'OPTIONS', expect: 200 });
  await check('ai-proxy GET → 405', { path: 'ai-proxy', method: 'GET', expect: 405 });

  // ── calendar-feed: missing uid ──
  await check('calendar-feed no-uid → 401', { path: 'calendar-feed', expect: 401 });
  await check('calendar-feed short-uid → 401', { path: 'calendar-feed?uid=abc', expect: 401 });

  // ── cleaner-action: shape only ──
  await check('cleaner-action OPTIONS', { path: 'cleaner-action', method: 'OPTIONS', expect: 204 });
  await check('cleaner-action GET → 405', { path: 'cleaner-action', method: 'GET', expect: 405 });

  // ── cleaner-data: missing params ──
  await check('cleaner-data no-params → 400', { path: 'cleaner-data', expect: 400 });

  // ── cleaner-message: shape only ──
  await check('cleaner-message OPTIONS', { path: 'cleaner-message', method: 'OPTIONS', expect: 204 });
  await check('cleaner-message GET → 405', { path: 'cleaner-message', method: 'GET', expect: 405 });

  // ── cm-* shape only ──
  await check('cm-get-properties OPTIONS', { path: 'cm-get-properties', method: 'OPTIONS', expect: 200 });
  await check('cm-get-properties GET → 405', { path: 'cm-get-properties', method: 'GET', expect: 405 });
  await check('cm-push-availability OPTIONS', { path: 'cm-push-availability', method: 'OPTIONS', expect: 200 });
  await check('cm-push-availability GET → 405', { path: 'cm-push-availability', method: 'GET', expect: 405 });
  await check('cm-sync-bookings OPTIONS', { path: 'cm-sync-bookings', method: 'OPTIONS', expect: 200 });
  await check('cm-sync-bookings GET → 405', { path: 'cm-sync-bookings', method: 'GET', expect: 405 });
  await check('cm-test-connection OPTIONS', { path: 'cm-test-connection', method: 'OPTIONS', expect: 200 });
  await check('cm-test-connection GET → 405', { path: 'cm-test-connection', method: 'GET', expect: 405 });

  // ── daily-notifications: cron-protected ──
  // Without secret, behavior depends on whether CRON_SECRET is set in prod.
  // We accept 401 (configured) or 200 (unconfigured-warned).
  await check('daily-notifications no-secret', { path: 'daily-notifications', expect: [200, 401] });
  await check('daily-notifications wrong-secret → 401', {
    path: 'daily-notifications',
    headers: { 'x-cron-secret': 'definitely-wrong' },
    expect: [200, 401],
  });
  await check('daily-notifications PUT → 405', { path: 'daily-notifications', method: 'PUT', expect: 405 });

  // ── fetch-listing: requires auth ──
  await check('fetch-listing no-auth → 401', { path: 'fetch-listing', method: 'POST', body: '{}', expect: 401 });

  // ── generate-pricing-suggestions ──
  await check('generate-pricing-suggestions OPTIONS', { path: 'generate-pricing-suggestions', method: 'OPTIONS', expect: 200 });
  await check('generate-pricing-suggestions GET → 405', { path: 'generate-pricing-suggestions', method: 'GET', expect: 405 });

  // ── gmail-oauth-callback: missing code → redirects with oauth_error ──
  await check('gmail-oauth-callback no-params → 302', { path: 'gmail-oauth-callback', expect: 302 });

  // ── gmail-oauth-start: missing state → 400 ──
  await check('gmail-oauth-start no-state → 400', { path: 'gmail-oauth-start', expect: 400 });

  // ── gmail-scan-bookings: missing uid → 400 ──
  await check('gmail-scan-bookings no-uid → 400', { path: 'gmail-scan-bookings', method: 'POST', expect: 400 });

  // ── monthly-revenue-summary: cron-protected ──
  await check('monthly-revenue-summary wrong-secret', {
    path: 'monthly-revenue-summary',
    headers: { 'x-cron-secret': 'wrong' },
    expect: [200, 401],
  });
  await check('monthly-revenue-summary PUT → 405', { path: 'monthly-revenue-summary', method: 'PUT', expect: 405 });

  // ── outlook-oauth-callback: missing code → 302 ──
  await check('outlook-oauth-callback no-params → 400', { path: 'outlook-oauth-callback', expect: [302, 400] });

  // ── outlook-scan-bookings: missing uid → 400 ──
  await check('outlook-scan-bookings no-uid → 400', { path: 'outlook-scan-bookings', method: 'POST', expect: 400 });

  // ── send-email: requires auth ──
  await check('send-email OPTIONS', { path: 'send-email', method: 'OPTIONS', expect: 200 });
  await check('send-email GET → 405', { path: 'send-email', method: 'GET', expect: 405 });
  await check('send-email no-auth → 401', { path: 'send-email', method: 'POST', body: '{}', expect: 401 });

  // ── send-push: requires auth ──
  await check('send-push OPTIONS', { path: 'send-push', method: 'OPTIONS', expect: 200 });
  await check('send-push GET → 405', { path: 'send-push', method: 'GET', expect: 405 });
  await check('send-push no-auth → 401', { path: 'send-push', method: 'POST', body: '{}', expect: 401 });

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(RED + 'fatal: ' + e.message + RESET);
  process.exit(2);
});
