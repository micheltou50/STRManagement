/*
  Data adapter layer (Supabase-first).
  Only methods used by main.js are implemented with working async behavior.
*/

class DataAdapter {
  async fetchBookings() { throw new Error('fetchBookings() not implemented'); }
  async addBooking() { throw new Error('addBooking() not implemented'); }
  async updateBooking() { throw new Error('updateBooking() not implemented'); }
  async deleteBooking() { throw new Error('deleteBooking() not implemented'); }
  async fetchAppData() { throw new Error('fetchAppData() not implemented'); }
  async saveAppDataKey() { throw new Error('saveAppDataKey() not implemented'); }
  async saveAllAppData() { throw new Error('saveAllAppData() not implemented'); }
  async fetchExpenses() { throw new Error('fetchExpenses() not implemented'); }
  async addExpense() { throw new Error('addExpense() not implemented'); }
  async updateExpense() { throw new Error('updateExpense() not implemented'); }
  async deleteExpense() { throw new Error('deleteExpense() not implemented'); }
  async migrateExpenseCategories() { throw new Error('migrateExpenseCategories() not implemented'); }
  async saveBackup() { throw new Error('saveBackup() not implemented'); }
  async listBackups() { throw new Error('listBackups() not implemented'); }
  async restoreBackup() { throw new Error('restoreBackup() not implemented'); }
  async sendEmail() { throw new Error('sendEmail() not implemented'); }
  async testConnection() { throw new Error('testConnection() not implemented'); }
}

class SupabaseAdapter extends DataAdapter {
  async fetchBookings() {
    const url = (typeof getPropertySheetCsvUrl === 'function')
      ? String(getPropertySheetCsvUrl() || '').trim()
      : '';
    if (!url) throw new Error('No booking CSV URL configured');

    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

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

  async testConnection() {
    const syncUrl = (typeof getCurrentScriptURL === 'function')
      ? String(getCurrentScriptURL() || '').trim()
      : '';

    if (!syncUrl) {
      return { success: false, status: 'missing_url', error: 'No Legacy Sync URL configured' };
    }

    const res = await fetch(syncUrl + '?action=test');
    const data = await res.json();
    return data;
  }
}
