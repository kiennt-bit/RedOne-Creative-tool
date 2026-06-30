// Kho tính năng — install state.
//  - builtin features: toggled locally (code already in app) → localStorage.
//  - frontend/asset features: "installed" = present in backend installed.json
//    (surfaced as catalog.installed); install/uninstall go through the backend.
// onChange() lets the sidebar re-render its dynamic feature tabs immediately.
import { getCatalog, getFeature, getFeatures, loadCatalog } from './catalog.js';

const LS_KEY = 'redone_features';        // builtin installs: array of ids
const SEEN_KEY = 'redone_features_seen'; // ids whose default-install was applied
const _listeners = new Set();

function _readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch { return new Set(); }
}
function _saveSet(key, set) { localStorage.setItem(key, JSON.stringify([...set])); }
function _markSeen(id) { const s = _readSet(SEEN_KEY); s.add(id); _saveSet(SEEN_KEY, s); }
function _fire() { for (const cb of _listeners) { try { cb(); } catch (e) { console.warn(e); } } }

export function onChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }

// Apply defaultInstalled=true ONCE per builtin feature (so removing it later sticks).
export function initBuiltinDefaults() {
  const seen = _readSet(SEEN_KEY);
  const inst = _readSet(LS_KEY);
  let changed = false;
  for (const f of getFeatures()) {
    if (f.kind === 'builtin' && f.defaultInstalled && !seen.has(f.id)) {
      inst.add(f.id); seen.add(f.id); changed = true;
    }
  }
  if (changed) { _saveSet(LS_KEY, inst); _saveSet(SEEN_KEY, seen); }
}

export function isInstalled(idOrFeature) {
  const f = typeof idOrFeature === 'string' ? getFeature(idOrFeature) : idOrFeature;
  if (!f) return false;
  if (f.kind === 'builtin') return _readSet(LS_KEY).has(f.id);
  const inst = getCatalog() && getCatalog().installed;
  return !!(inst && inst[f.id]);
}

export function hasUpdate(f) {
  if (!f || f.kind === 'builtin') return false;
  const inst = (getCatalog() && getCatalog().installed) || {};
  const rec = inst[f.id];
  if (!rec) return false;
  return String(rec.version || '') !== String(f.version || '');
}

// builtin: instant local toggle.
export function installBuiltin(id) { const s = _readSet(LS_KEY); s.add(id); _saveSet(LS_KEY, s); _markSeen(id); _fire(); }
export function uninstallBuiltin(id) { const s = _readSet(LS_KEY); s.delete(id); _saveSet(LS_KEY, s); _markSeen(id); _fire(); }

// frontend/asset: re-pull catalog (its .installed reflects backend state) then notify.
export async function refreshInstalled() { await loadCatalog(true); _fire(); }
