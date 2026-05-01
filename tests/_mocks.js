/**
 * StayOps — test mocks for Tier B integration tests.
 *
 * Provides:
 *   - makeFakeSupabase({ tables, authUsers }) — minimal in-memory client
 *     supporting the query patterns used by Netlify functions
 *     (from/select/eq/neq/gte/lte/lt/in/not/or/limit/maybeSingle/single,
 *     update, insert, delete, auth.admin.getUserById).
 *   - installModuleMocks(mocks) — replaces require.cache entries for
 *     @supabase/supabase-js, web-push, and nodemailer with fakes.
 *   - installFetchMock(handler) — overrides globalThis.fetch.
 *   - resetAll() — restores everything.
 *
 * The fakes intentionally cover only the call shapes used by the handlers
 * under test. Adding new tests may require extending the supported
 * operators in the query builder.
 */

const Module = require('node:module');

// ── Supabase-like in-memory client ──────────────────────────────────────────

function makeFakeSupabase({ tables = {}, authUsers = [] } = {}) {
  // Deep-copy seeded tables so tests don't share mutable state by reference.
  const store = {};
  for (const k of Object.keys(tables)) {
    store[k] = (tables[k] || []).map(row => ({ ...row }));
  }

  function builder(table) {
    const filters = [];
    let mode = 'select';
    let updatePatch = null;
    let insertRow = null;
    let limitN = null;

    const apply = (rows) => rows.filter(r => filters.every(f => f(r)));

    const b = {
      select() { return b; },
      eq(c, v) { filters.push(r => r[c] === v); return b; },
      neq(c, v) { filters.push(r => r[c] !== v); return b; },
      gte(c, v) { filters.push(r => r[c] >= v); return b; },
      lte(c, v) { filters.push(r => r[c] <= v); return b; },
      gt(c, v) { filters.push(r => r[c] > v); return b; },
      lt(c, v) { filters.push(r => r[c] < v); return b; },
      in(c, arr) { filters.push(r => arr.includes(r[c])); return b; },
      not(c, op, val) {
        if (op === 'is' && val === null) {
          filters.push(r => r[c] !== null && r[c] !== undefined);
        }
        return b;
      },
      or(expr) {
        const clauses = String(expr).split(',').map(part => {
          const m = /^([^.]+)\.([^.]+)\.(.+)$/.exec(part.trim());
          if (!m) return () => true;
          const [, col, op, val] = m;
          if (op === 'eq') return r => String(r[col]) === val;
          if (op === 'neq') return r => String(r[col]) !== val;
          return () => true;
        });
        filters.push(r => clauses.some(c => c(r)));
        return b;
      },
      order() { return b; },
      limit(n) { limitN = n; return b; },

      update(patch) { mode = 'update'; updatePatch = patch; return b; },
      insert(row) { mode = 'insert'; insertRow = row; return b; },
      delete() { mode = 'delete'; return b; },

      async maybeSingle() {
        const rows = apply(store[table] || []);
        return { data: rows[0] || null, error: null };
      },
      async single() {
        const rows = apply(store[table] || []);
        if (!rows.length) return { data: null, error: { message: 'no rows' } };
        return { data: rows[0], error: null };
      },

      then(onF, onR) {
        const arr = store[table] || (store[table] = []);

        if (mode === 'select') {
          let data = apply(arr);
          if (limitN != null) data = data.slice(0, limitN);
          return Promise.resolve({ data, error: null }).then(onF, onR);
        }
        if (mode === 'update') {
          for (const r of apply(arr)) Object.assign(r, updatePatch);
          return Promise.resolve({ data: null, error: null }).then(onF, onR);
        }
        if (mode === 'insert') {
          const rows = Array.isArray(insertRow) ? insertRow : [insertRow];
          for (const r of rows) arr.push({ ...r });
          return Promise.resolve({ data: null, error: null }).then(onF, onR);
        }
        if (mode === 'delete') {
          const keep = arr.filter(r => !filters.every(f => f(r)));
          store[table] = keep;
          return Promise.resolve({ data: null, error: null }).then(onF, onR);
        }
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return {
    from(table) { return builder(table); },
    auth: {
      admin: {
        async getUserById(uid) {
          const u = authUsers.find(x => x.id === uid);
          return { data: { user: u || null }, error: u ? null : { message: 'not found' } };
        },
      },
    },
    _store: store, // exposed so tests can inspect post-state
  };
}

// ── Module cache injection ──────────────────────────────────────────────────

const _saved = new Map();

function _setCachedModule(specifier, exports) {
  let resolved;
  try {
    resolved = require.resolve(specifier);
  } catch (_e) {
    // Module not installed — skip silently. Tests that need it will fail
    // with a clearer error when the handler tries to require it.
    return;
  }
  if (!_saved.has(resolved)) {
    _saved.set(resolved, require.cache[resolved]);
  }
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: Module._nodeModulePaths(require('node:path').dirname(resolved)),
  };
}

function installModuleMocks({ supabase, webpush, nodemailer } = {}) {
  if (supabase) {
    _setCachedModule('@supabase/supabase-js', {
      createClient: () => supabase,
    });
  }
  if (webpush) {
    _setCachedModule('web-push', webpush);
  }
  if (nodemailer) {
    _setCachedModule('nodemailer', nodemailer);
  }
}

// ── Fetch mock ──────────────────────────────────────────────────────────────

let _origFetch;

function installFetchMock(handler) {
  if (_origFetch === undefined) _origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const r = await handler(String(url), init);
    return _toResponse(r);
  };
}

function _toResponse(r) {
  if (!r) return mkResponse(200, '');
  if (typeof r === 'object' && typeof r.text === 'function' && typeof r.json === 'function') {
    return r; // already a Response-like
  }
  return mkResponse(r.status || 200, r.body == null ? '' : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)));
}

function mkResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { try { return JSON.parse(text); } catch { return {}; } },
  };
}

// ── Reset ───────────────────────────────────────────────────────────────────

function resetAll() {
  for (const [resolved, prev] of _saved.entries()) {
    if (prev) require.cache[resolved] = prev;
    else delete require.cache[resolved];
  }
  _saved.clear();
  if (_origFetch !== undefined) {
    globalThis.fetch = _origFetch;
    _origFetch = undefined;
  }
  // Drop cached Netlify function modules so fresh requires pick up new mocks.
  const fnDir = require('node:path').join(__dirname, '..', 'Netlify', 'functions');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(fnDir)) delete require.cache[key];
  }
}

// Convenience: a webpush stub that lets tests inspect/queue behavior.
function makeFakeWebPush({ failures = [] } = {}) {
  const sent = [];
  let i = 0;
  return {
    setVapidDetails() {},
    async sendNotification(sub, payload) {
      const next = failures[i++];
      sent.push({ sub, payload });
      if (next) {
        const err = new Error(next.message || 'push failed');
        err.statusCode = next.statusCode;
        throw err;
      }
      return { statusCode: 201 };
    },
    _sent: sent,
  };
}

// Convenience: nodemailer stub that always succeeds and records calls.
function makeFakeNodemailer() {
  const sent = [];
  return {
    createTransport() {
      return {
        async sendMail(opts) { sent.push(opts); return { messageId: 'fake' }; },
      };
    },
    _sent: sent,
  };
}

module.exports = {
  makeFakeSupabase,
  makeFakeWebPush,
  makeFakeNodemailer,
  installModuleMocks,
  installFetchMock,
  resetAll,
};
