/**
 * StayOps — shared helpers used by finance.js AND the finance-* slice modules.
 * Lives in its own file so slices never import the barrel (no import cycles).
 * Split out of finance.js 2026-07-08 (see the architecture plan).
 */
import { getActivePropertyId, getActivePropertyConfig } from './config.js';

/** Cloud property id of the active property ('' when none / portfolio mode). */
export function _financeActiveCloudPropertyId() {
  const cloudIds = window._cloudPropertyIds || {};
  const cfg = getActivePropertyConfig ? (getActivePropertyConfig() || {}) : {};
  return String(cloudIds[getActivePropertyId?.()] || cloudIds[cfg.propertyId] || cfg.supabaseId || '');
}
