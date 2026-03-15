/* ═══════════════════════════════════════════════════════════════════════════
   DATA ADAPTER LAYER — Glenhaven Property Manager (Product Version)
   ═══════════════════════════════════════════════════════════════════════════

   Change from v1:
     GoogleSheetsAdapter now accepts either a static string OR a thunk
     () => string for csvUrl. This lets main.js pass getPropertySheetCsvUrl
     as a live reference so the CSV URL is always read from config, not
     captured at boot time.

   Everything else is identical to the original adapter.js.
═══════════════════════════════════════════════════════════════════════════ */


// ── BASE INTERFACE ─────────────────────────────────────────────────────────────
class DataAdapter {
  async fetchBookings()                   { throw new Error('fetchBookings() not implemented'); }
  async addBooking(booking)               { throw new Error('addBooking() not implemented'); }
  async updateBooking(booking)            { throw new Error('updateBooking() not implemented'); }
  async deleteBooking(booking)            { throw new Error('deleteBooking() not implemented'); }
  async fetchAppData()                    { throw new Error('fetchAppData() not implemented'); }
  async saveAppDataKey(key, value)        { throw new Error('saveAppDataKey() not implemented'); }
  async saveAllAppData(keyValueMap)       { throw new Error('saveAllAppData() not implemented'); }
  async fetchExpenses()                   { throw new Error('fetchExpenses() not implemented'); }
  async addExpense(expense)               { throw new Error('addExpense() not implemented'); }
  async updateExpense(expense)            { throw new Error('updateExpense() not implemented'); }
  async deleteExpense(expense)            { throw new Error('deleteExpense() not implemented'); }
  async migrateExpenseCategories()        { throw new Error('migrateExpenseCategories() not implemented'); }
  async saveBackup(payload)               { throw new Error('saveBackup() not implemented'); }
  async listBackups()                     { throw new Error('listBackups() not implemented'); }
  async restoreBackup(fileId)             { throw new Error('restoreBackup() not implemented'); }
  async sendEmail(to, subject, html, txt) { throw new Error('sendEmail() not implemented'); }
  async testConnection()                  { throw new Error('testConnection() not implemented'); }
}


// ── GOOGLE SHEETS ADAPTER ──────────────────────────────────────────────────────
/**
 * @param {() => string} getScriptUrl  Thunk returning the current Apps Script URL.
 * @param {string | () => string} csvUrl  Static string OR thunk returning the CSV URL.
 *        Accept a thunk so the URL is read from config at call time, not captured at boot.
 */
class GoogleSheetsAdapter extends DataAdapter {
  constructor(getScriptUrl, csvUrl) {
    super();
    this._getScriptUrl = getScriptUrl;
    // Normalise: always store as a thunk internally.
    this._getCsvUrl = typeof csvUrl === 'function' ? csvUrl : () => csvUrl;
  }

  get _url() {
    const u = this._getScriptUrl();
    if (!u) throw new Error('No Apps Script URL — add one in Settings → Google Sheets');
    return u;
  }

  /** GET: action + data as query params. Safe for reads up to ~2 KB. */
  _get(action, data) {
    const dataStr = encodeURIComponent(JSON.stringify(data || {}));
    return fetch(this._url + '?action=' + encodeURIComponent(action) + '&data=' + dataStr)
      .then(r => r.json());
  }

  /** POST: body as text/plain JSON to avoid CORS pre-flight. */
  _post(action, payload) {
    return fetch(this._url, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify({ action, data: JSON.stringify(payload) })
    }).then(r => r.json());
  }

  /** Strip photo/binary fields; normalise to the 8 sheet columns. */
  _sheetExpense(exp) {
    return {
      date:        exp.date        || '',
      merchant:    exp.merchant    || '',
      description: exp.description || '',
      category:    exp.category    || '',
      amount:      exp.amount      || 0,
      receiptNum:  exp.receiptNum  || '',
      receiptType: exp.receiptType || '',
      driveLink:   exp.driveLink   || ''
    };
  }

  // ── Bookings ─────────────────────────────────────────────────────────────
  async fetchBookings() {
    const url = this._getCsvUrl();   // reads config at call time via thunk
    const res = await fetch(url + '&t=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  async addBooking(booking)  { return this._get('add',    booking); }

  async updateBooking(booking) {
    const json = await this._get('update', booking);
    if (json.status === 'not_found') return this._get('add', booking);
    return json;
  }

  async deleteBooking(booking) { return this._get('delete', booking); }

  // ── App Data ─────────────────────────────────────────────────────────────
  async fetchAppData() {
    const res = await fetch(this._url + '?action=getAppData');
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
    return res.json();
  }

  async saveAppDataKey(key, value) {
    return fetch(this._url, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify({ action: 'setAppData', key, value })
    }).then(r => r.json());
  }

  async saveAllAppData(keyValueMap) {
    const errors = [];
    for (const [key, data] of Object.entries(keyValueMap)) {
      try {
        const j = await this.saveAppDataKey(key, data);
        if (!j.success) errors.push(key + ': ' + (j.error || j.status || 'failed'));
      } catch (e) {
        errors.push(key + ': network error');
      }
    }
    return { errors };
  }

  // ── Expenses ─────────────────────────────────────────────────────────────
  async fetchExpenses()          { return this._get('getExpenses', {}); }
  async addExpense(exp)          { return this._post('addExpense',    this._sheetExpense(exp)); }
  async updateExpense(exp)       { return this._post('updateExpense', this._sheetExpense(exp)); }

  async deleteExpense(exp) {
    return this._post('deleteExpense', {
      date:     exp.date     || '',
      merchant: exp.merchant || '',
      amount:   exp.amount   || 0
    });
  }

  async migrateExpenseCategories() { return this._get('migrateCategories', {}); }

  // ── Backup & Restore ─────────────────────────────────────────────────────
  async saveBackup(payload) {
    return fetch(this._url, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify({ action: 'saveBackup', data: JSON.stringify(payload) })
    }).then(r => r.json());
  }

  async listBackups() { return this._get('listBackups', {}); }

  async restoreBackup(fileId) {
    const res = await fetch(
      this._url + '?action=restoreBackup&fileId=' + encodeURIComponent(fileId)
    );
    return res.json();
  }

  // ── Email ────────────────────────────────────────────────────────────────
  async sendEmail(to, subject, html, text) {
    return fetch(this._url, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify({ action: 'sendEmail', to, subject, html, text })
    }).then(r => r.json());
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────
  async testConnection() {
    const res = await fetch(this._url + '?action=test');
    return res.json();
  }
}
