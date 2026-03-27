// ES module.
// window.DataAdapter and window.SupabaseAdapter are preserved so main.js
// (classic script) can reference SupabaseAdapter at the top level unchanged.

export class DataAdapter {
  async sendEmail() { throw new Error('sendEmail() not implemented'); }
}

export class SupabaseAdapter extends DataAdapter {
  async sendEmail(to, subject, html, text) {
    const res = await fetch('/.netlify/functions/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, html, text })
    });

    let data = null;
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

// Backward compat: main.js is a classic script and reads these from window.
// Safe to remove only after main.js is also converted to a module.
window.DataAdapter = DataAdapter;
window.SupabaseAdapter = SupabaseAdapter;
