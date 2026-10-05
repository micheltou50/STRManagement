/**
 * StayOps — bank statement import: load a file, save every new line, explain
 * it, land on the Bank screen.
 *
 * There is no review wall. The old screen would not import a row — a deposit
 * included — until it had a property and an expense category, so early
 * imports show 59 of 73 rows skipped and the same file re-imported five times.
 * Now: parse (CSV in-browser, PDF/photo via Claude vision), drop what is
 * already in, save the rest as bank lines, hand them to the explain engine,
 * and open Bank on that month with "N new · M explained · K to decide".
 *
 * Same module name and `bankImportPickFile` bridge as before, so the Expenses
 * screen's button and the portfolio toolbar keep working.
 */
import { parseCSV, parseBankFileWithAI, checkDuplicates, getBankImportError, resetBankImportError } from './bank-import.js';
import { getOrCreateDefaultBankAccount, createBankImportBatch, updateBankImportBatch, insertBankLines } from './supabase.js';
import { counterpartyKey } from './bank-explain.js';
import { explainAndApplyLines, bankAfterImport } from './finance-bank.js';

function _say(msg, kind) {
  if (typeof globalThis.showBanner === 'function') globalThis.showBanner(msg, kind || 'info');
}

function getOrCreateBankCsvFileInput() {
  let input = document.getElementById('bank-csv-file-input');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.id = 'bank-csv-file-input';
  input.accept = '.csv,text/csv,application/pdf,image/*';
  input.style.display = 'none';
  input.onchange = (ev) => bankImportOnFileSelected(ev);
  document.body.appendChild(input);
  return input;
}

function _readFile(file, as) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('Could not read file'));
    if (as === 'dataUrl') r.readAsDataURL(file); else r.readAsText(file);
  });
}

async function bankImportOnFileSelected(ev) {
  const file = ev.target && ev.target.files && ev.target.files[0];
  if (ev.target) ev.target.value = '';
  if (!file) return;
  const userId = window._supabaseUser && window._supabaseUser.id;
  if (!userId) { _say('Sign in to load a bank statement', 'warn'); return; }
  if (typeof resetBankImportError === 'function') resetBankImportError();

  const lowerName = (file.name || '').toLowerCase();
  const mime = file.type || '';
  const isPdf = mime === 'application/pdf' || lowerName.endsWith('.pdf');
  const isImage = mime.startsWith('image/');
  const useAI = isPdf || isImage;

  let parsed;
  try {
    if (useAI) {
      _say('⏳ Reading the statement with AI — 10 to 30 seconds…', 'info');
      const dataUrl = await _readFile(file, 'dataUrl');
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      parsed = await parseBankFileWithAI(base64, isPdf ? 'application/pdf' : (mime || 'image/jpeg'));
    } else {
      _say('⏳ Reading ' + (file.name || 'statement') + '…', 'info');
      parsed = await parseCSV(await _readFile(file, 'text'));
    }
  } catch (err) {
    console.error('[StayOps] Bank import: parse failed', err);
    _say('Could not read that file — ' + ((err && err.message) || 'unknown error'), 'warn');
    return;
  }
  if (!parsed.length) {
    const why = typeof getBankImportError === 'function' ? getBankImportError() : '';
    _say(why ? 'Import failed: ' + why : (useAI ? 'AI found no transactions in that file — try a clearer PDF or the CSV export' : 'No transactions found — check the file is a bank CSV export'), 'warn');
    return;
  }
  await bankImportSaveRows(parsed, { filename: file.name || 'statement', sourceType: isPdf ? 'pdf' : isImage ? 'image' : 'csv', userId });
}

/**
 * Save parsed rows as bank lines and explain them. Rows: { date, description,
 * amount (absolute), type: 'debit'|'credit' } from the parsers.
 */
export async function bankImportSaveRows(parsed, { filename = 'statement', sourceType = 'csv', userId } = {}) {
  const acct = await getOrCreateDefaultBankAccount();
  if (!acct) { _say('⚠ No bank account to import into — sign in and try again', 'warn'); return null; }

  _say(`Checking ${parsed.length} rows against what is already in…`, 'info');
  const checked = await checkDuplicates(parsed, userId);
  const fresh = checked.filter(r => r && !r.isDuplicate && r.date && Number(r.amount) > 0);
  const dups = checked.length - fresh.length;
  if (!fresh.length) {
    _say(`Nothing new — all ${checked.length} rows of ${filename} are already in.`, 'warn');
    return { inserted: [], duplicates: dups };
  }

  const dates = fresh.map(r => r.date).sort();
  const batch = await createBankImportBatch({
    accountId: acct._cloudId,
    filename,
    totalRows: checked.length,
    sourceType,
    periodStart: dates[0],
    periodEnd: dates[dates.length - 1],
  });
  const bankLabel = filename ? filename.replace(/\.[^.]+$/, '') : null;

  let inserted;
  try {
    inserted = await insertBankLines(fresh.map(r => ({
      date: r.date,
      amount: r.amount,
      description: r.description,
      direction: r.type === 'credit' ? 'credit' : 'debit',
      counterparty: counterpartyKey(r.description),
      bankAccountId: acct._cloudId,
      importBatchId: batch ? batch.id : null,
      bankName: bankLabel,
    })));
  } catch (err) {
    const msg = (err && (err.message || err.details || err.hint)) || String(err);
    _say('Import failed — nothing was saved. ' + msg, 'warn');
    return null;
  }

  // The duplicate check already found the recorded expense some payments pay
  // for; hand that to the engine as evidence instead of making it guess again.
  const keyOf = r => `${r.date}|${Number(r.amount).toFixed(2)}|${r.description}`;
  const byKey = new Map(fresh.map(r => [keyOf(r), r]));
  for (const l of inserted) {
    const r = byKey.get(keyOf(l));
    if (r && r.matchesExistingExpense && r.existingExpenseId) l.existingExpenseId = r.existingExpenseId;
  }

  _say(`Saved ${inserted.length} new line${inserted.length === 1 ? '' : 's'} — explaining…`, 'info');
  const stats = await explainAndApplyLines(inserted, {
    force: false,
    onProgress: (i, n) => _say(`Explaining ${i} of ${n}…`, 'info'),
  });
  if (batch) await updateBankImportBatch(batch.id, { imported: inserted.length, skipped: 0, duplicates: dups });

  const toDecide = stats.suggested + stats.undecided;
  const summary = `${inserted.length} new · ${stats.explained} explained · ${toDecide} to decide${dups ? ` · ${dups} already in` : ''}`;
  await bankAfterImport({ lines: inserted, summary });
  _say('✓ ' + summary, 'ok');
  return { inserted, duplicates: dups, stats };
}

/** "Import Bank Statement" button on the Expenses list header. */
function ensureBankImportToolbar() {
  if (document.getElementById('exp-bank-import-link')) { getOrCreateBankCsvFileInput(); return; }
  const listEl = document.getElementById('expenses-list');
  if (!listEl) return;
  const card = listEl.closest('.card');
  const header = card && card.querySelector(':scope > div:first-child');
  if (!header || document.getElementById('bank-import-trigger-btn')) return;
  const titleRow = header.querySelector('div[style*="justify-content:space-between"]');
  if (!titleRow) return;
  titleRow.style.flexWrap = 'wrap';
  titleRow.style.gap = '8px';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'bank-import-trigger-btn';
  btn.textContent = 'Load bank statement';
  btn.style.cssText = "font-size:12px;color:var(--primary);background:transparent;border:1px solid var(--primary);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;white-space:nowrap";
  btn.onclick = () => getOrCreateBankCsvFileInput().click();
  titleRow.appendChild(btn);
  getOrCreateBankCsvFileInput();
}

/** Same button on the portfolio (all properties) finance page. */
function ensureBankImportToolbarPortfolio() {
  const root = document.getElementById('portfolio-finance');
  if (!root || document.getElementById('bank-import-trigger-btn-portfolio')) return;
  const wrap = document.createElement('div');
  wrap.id = 'bank-import-portfolio-toolbar';
  wrap.style.cssText = 'margin-bottom:12px;display:flex;justify-content:flex-end;align-items:center;padding:0 2px';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'bank-import-trigger-btn-portfolio';
  btn.textContent = 'Load bank statement';
  btn.style.cssText = "font-size:12px;color:var(--primary);background:transparent;border:1px solid var(--primary);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;white-space:nowrap";
  btn.onclick = () => getOrCreateBankCsvFileInput().click();
  wrap.appendChild(btn);
  root.insertBefore(wrap, root.firstChild);
  getOrCreateBankCsvFileInput();
}

export { ensureBankImportToolbar, ensureBankImportToolbarPortfolio };

globalThis.bankImportPickFile = () => getOrCreateBankCsvFileInput().click();
