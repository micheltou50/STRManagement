/**
 * StayOps — receipts: expense receipt upload to Supabase Storage + signed view
 * URLs (the `receipts` bucket). Split out of supabase.js 2026-07-09 (by-entity
 * data-layer split). supabase.js re-exports both functions. window._sb is the
 * global client; getCurrentSupabaseUser / getCloudPropertyId imported from the
 * barrel at call-time (safe cycle).
 */
import { getCurrentSupabaseUser, getCloudPropertyId } from './supabase.js';

// ── RECEIPTS (Supabase Storage) ───────────────────────────────────────────────

export async function uploadReceiptToStorage(file, expenseId, receiptIndex = 0) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !file) return null;
    const propertyId = await getCloudPropertyId();
    const ext = file.name.split('.').pop();
    const slotSuffix = receiptIndex > 0 ? `_${receiptIndex + 1}` : '';
    // Append a version timestamp so a "replace" upload writes to a NEW path —
    // the previous file in storage survives instead of being overwritten.
    // upsert remains true as a belt-and-suspenders guard against rare collisions.
    const version = Date.now();
    // Store the file under a unique folder, with the ATO-formatted file name
    // (YYYY-MM-DD_Category_Supplier_Amount.pdf, from generateReceiptFileName) as
    // the leaf, so downloads/exports carry that name.
    const leaf = (file.name || `receipt.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${user.id}/${propertyId || 'default'}/${expenseId || Date.now()}${slotSuffix}_v${version}/${leaf}`;
    // Upload an ArrayBuffer with an explicit content type rather than a File/Blob
    // body — the iOS WKWebView mangles/drops Blob bodies on cross-origin fetch,
    // which silently breaks receipt uploads in the native app (works on web).
    const body = (file && typeof file.arrayBuffer === 'function') ? await file.arrayBuffer() : file;
    const { error } = await window._sb.storage.from('receipts')
      .upload(path, body, { upsert: true, contentType: (file && file.type) || 'application/pdf' });
    if (error) {
      const msg = (error.message || error.error || error.statusText) || JSON.stringify(error);
      console.warn('[StayOps] uploadReceiptToStorage error', error);
      globalThis._lastReceiptUploadError = msg;
      return null;
    }
    globalThis._lastReceiptUploadError = null;
    return path;
  } catch (e) {
    const msg = (e && (e.message || String(e))) || 'unknown error';
    console.warn('[StayOps] uploadReceiptToStorage failed', e);
    globalThis._lastReceiptUploadError = msg;
    return null;
  }
}

/**
 * Get a viewable URL for a receipt, regardless of whether driveLinkValue is
 * a storage path (new format) or a legacy public URL.
 * Returns a signed URL valid for 1 hour.
 */
export async function getReceiptViewUrl(driveLinkValue, downloadName) {
  if (!driveLinkValue || !window._sb) return null;
  try {
    let path = String(driveLinkValue).trim();
    // Legacy: extract path from public URL like
    //   https://xxx.supabase.co/storage/v1/object/public/receipts/USER/PROPERTY/EXPENSE.ext
    const publicMatch = path.match(/\/storage\/v1\/object\/(?:public|sign)\/receipts\/(.+?)(?:\?.*)?$/);
    if (publicMatch) path = publicMatch[1];
    // If it's still a full URL (e.g. external Drive link), just return it as-is
    if (/^https?:\/\//i.test(path)) return path;
    // If an ATO download name is supplied AND the stored file isn't already named
    // that (i.e. an older receipt), force a download that saves it with the ATO
    // name — no physical rename needed. New receipts are already ATO-named on disk,
    // so they keep opening inline for quick viewing.
    let opts;
    if (downloadName && path.split('/').pop() !== downloadName) opts = { download: downloadName };
    // Generate a fresh signed URL
    const { data, error } = await window._sb.storage.from('receipts').createSignedUrl(path, 3600, opts);
    if (error) { console.warn('[StayOps] getReceiptViewUrl error', error); return null; }
    return data && data.signedUrl ? data.signedUrl : null;
  } catch (e) {
    console.warn('[StayOps] getReceiptViewUrl failed', e);
    return null;
  }
}
