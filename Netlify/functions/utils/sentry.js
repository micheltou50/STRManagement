/**
 * StayOps — Sentry error tracking for Netlify functions.
 *
 * Usage:
 *   const { captureError, captureMessage } = require('./utils/sentry');
 *   captureError(error, { tags: { function: 'gmail-scan' } });
 *   captureMessage('Gmail token expired', 'warning', { user_id: '...' });
 */

const Sentry = require('@sentry/node');

const DSN = process.env.SENTRY_DSN || 'https://e031cec3998447f5b9bd2098146630ab@o4511154504794112.ingest.us.sentry.io/4511154514296832';

let _initialized = false;

function init() {
  if (_initialized) return;
  try {
    Sentry.init({
      dsn: DSN,
      environment: process.env.CONTEXT || 'production', // Netlify sets CONTEXT
      tracesSampleRate: 0,
      beforeSend(event) {
        // Strip any sensitive data
        if (event.request && event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        return event;
      },
    });
    _initialized = true;
  } catch (e) {
    console.warn('[StayOps] Sentry init failed:', e.message);
  }
}

function captureError(error, extra) {
  init();
  try {
    if (extra) {
      Sentry.withScope(scope => {
        if (extra.tags) Object.entries(extra.tags).forEach(([k, v]) => scope.setTag(k, v));
        if (extra.user_id) scope.setUser({ id: extra.user_id });
        if (extra.context) scope.setContext('details', extra.context);
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
      });
    } else {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    }
  } catch (_) { /* never let Sentry break the function */ }
}

function captureMessage(message, level, extra) {
  init();
  try {
    Sentry.withScope(scope => {
      if (extra && extra.user_id) scope.setUser({ id: extra.user_id });
      if (extra && extra.tags) Object.entries(extra.tags).forEach(([k, v]) => scope.setTag(k, v));
      Sentry.captureMessage(message, level || 'warning');
    });
  } catch (_) { /* never let Sentry break the function */ }
}

async function flush() {
  if (!_initialized) return;
  try { await Sentry.flush(2000); } catch (_) { /* ignore */ }
}

module.exports = { captureError, captureMessage, flush };
