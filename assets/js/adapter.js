/*
  Data adapter layer — Supabase-native.
  Provides sendEmail via Netlify function.
*/

class DataAdapter {
  async sendEmail() { throw new Error('sendEmail() not implemented'); }
}

class SupabaseAdapter extends DataAdapter {
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
