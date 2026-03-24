/*
  Data adapter layer (Supabase-only cleanup).
  Legacy Google Sheets adapter code has been removed.
*/

class DataAdapter {
  async fetchBookings() { return ''; }
  async addBooking() { return { success: true }; }
  async updateBooking() { return { success: true }; }
  async deleteBooking() { return { success: true }; }
  async fetchAppData() { return {}; }
  async saveAppDataKey() { return { success: true }; }
  async saveAllAppData() { return { errors: [] }; }
  async fetchExpenses() { return []; }
  async addExpense() { return { success: true }; }
  async updateExpense() { return { success: true }; }
  async deleteExpense() { return { success: true }; }
  async migrateExpenseCategories() { return { success: true }; }
  async saveBackup() { return { success: true }; }
  async listBackups() { return { files: [] }; }
  async restoreBackup() { return { success: true }; }
  async sendEmail() { return { success: true }; }
  async testConnection() { return { success: true }; }
}

class SupabaseAdapter extends DataAdapter {}
