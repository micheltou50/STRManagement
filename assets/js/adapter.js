// ES module.
// window.DataAdapter and window.SupabaseAdapter are preserved so main.js
// (classic script) can reference SupabaseAdapter at the top level unchanged.

export class DataAdapter {
  async sendEmail() { throw new Error('sendEmail() not implemented'); }
}

export class SupabaseAdapter extends DataAdapter {
  async sendEmail(to, subject, html, text) {
    const _af = typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch;
    const res = await _af('/.netlify/functions/send-email', {
      method: 'POST',
      body: JSON.stringify({ to, subject, html, text })
    });

    let data;
    try { data = await res.json(); } catch (_) { data = null; }

    if (!res.ok) {
      return {
        success: false,
        status: 'error',
        error: (data && data.error) || ('HTTP ' + res.status),
        detail: data || null
      };
    }

    return Object.assign({ success: true, status: 'ok' }, data || {});
  }
}
