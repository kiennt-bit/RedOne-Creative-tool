// Kho tính năng — catalog loader.
// The backend (/api/features/catalog) fetches the remote index.json (with
// offline cache + bundled fallback); here we just hold the result in memory
// for the session so nav + store render from a single source.
import { api } from '../api.js';

let _catalog = null;     // { tags, features, installed }
let _loading = null;

export async function loadCatalog(force = false) {
  if (_catalog && !force) return _catalog;
  if (_loading && !force) return _loading;
  _loading = api.features.catalog()
    .then((d) => { _catalog = d || { tags: {}, features: [], installed: {} }; return _catalog; })
    .catch(() => { _catalog = _catalog || { tags: {}, features: [], installed: {} }; return _catalog; })
    .finally(() => { _loading = null; });
  return _loading;
}

export function getCatalog() { return _catalog; }
export function getFeatures() { return (_catalog && _catalog.features) || []; }
export function getFeature(id) { return getFeatures().find((f) => f.id === id) || null; }
export function getTags() { return (_catalog && _catalog.tags) || {}; }
export function getInstalledMap() { return (_catalog && _catalog.installed) || {}; }
