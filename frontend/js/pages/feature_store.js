// Kho tính năng (feature store) — simple card grid (per approved mockup).
// Lists heavy/optional features from the catalog; install/uninstall toggles
// whether the feature's tab appears in the sidebar. UI only — no A1111-style
// dense table.
import { el, clear, toast, icon } from '../ui.js';
import { api } from '../api.js';
import { ws } from '../ws.js';
import { loadCatalog, getFeatures } from '../features/catalog.js';
import * as state from '../features/state.js';

let _root = null;
const _installing = new Set();   // feature ids currently downloading

export async function renderFeatureStore(root) {
  _root = root;
  clear(root);
  root.appendChild(el('p', {
    class: 'field-help', style: { margin: '0 0 18px', maxWidth: '720px' },
  }, 'Cài thêm tính năng nặng khi cần. Máy cấu hình thấp có thể bỏ qua để giao diện gọn và nhẹ hơn — cài rồi mới hiện tab tương ứng.'));
  const body = el('div', { id: 'fs-body' });
  root.appendChild(body);
  body.appendChild(el('div', { class: 'field-help' }, 'Đang tải danh sách…'));
  await loadCatalog();
  _renderBody(body);
}

function _renderBody(body) {
  clear(body);
  const feats = getFeatures();
  if (!feats.length) {
    body.appendChild(el('div', { class: 'card' }, 'Chưa có tính năng nào trong kho.'));
    return;
  }
  const installed = feats.filter((f) => state.isInstalled(f));
  const available = feats.filter((f) => !state.isInstalled(f));
  if (available.length) body.appendChild(_section('Có sẵn', available));
  if (installed.length) body.appendChild(_section('Đã cài', installed));
}

function _section(title, feats) {
  const grid = el('div', {
    style: {
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
      gap: '14px',
    },
  }, ...feats.map(_card));
  return el('div', { style: { marginBottom: '22px' } },
    el('div', { class: 'field-label', style: { marginBottom: '10px' } }, title),
    grid);
}

function _card(f) {
  const isHeavy = (f.tags || []).includes('heavy');
  const ic = icon(f.icon || 'sparkles', 20);
  const iconBox = el('div', {
    style: {
      width: '38px', height: '38px', borderRadius: '10px', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--brand-soft)', color: 'var(--brand)', flex: '0 0 auto',
    },
  }, ic);
  const chips = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
  if (isHeavy) chips.appendChild(el('span', { class: 'chip chip-yellow' }, 'Nặng'));

  return el('div', {
    class: 'card', 'data-fid': f.id,
    style: { display: 'flex', flexDirection: 'column', gap: '10px' },
  },
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' } }, iconBox, chips),
    el('div', { style: { fontWeight: '600' } }, f.name),
    el('div', { class: 'field-help', style: { flex: '1', minHeight: '34px' } }, f.description || ''),
    _action(f),
  );
}

function _action(f) {
  const installed = state.isInstalled(f);
  const hasDownload = (f.download && f.download.url) || (f.assets && f.assets.length > 0);
  const comingSoon = f.comingSoon || (f.kind !== 'builtin' && !hasDownload);

  if (_installing.has(f.id)) return _progress(f);

  if (!installed && comingSoon) {
    return el('button', { class: 'btn', disabled: true, style: { width: '100%' } }, 'Sắp có');
  }

  if (installed) {
    const row = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      el('span', { class: 'chip chip-green' }, 'Đã cài'));
    if (state.hasUpdate(f)) {
      row.appendChild(el('button', { class: 'btn btn-sm btn-primary', onclick: () => _install(f) }, 'Cập nhật'));
    }
    row.appendChild(el('button', { class: 'btn btn-sm', style: { marginLeft: 'auto' }, onclick: () => _uninstall(f) }, 'Gỡ'));
    return row;
  }

  return el('button', { class: 'btn btn-primary', style: { width: '100%' }, onclick: () => _install(f) }, 'Cài đặt');
}

function _progress(f) {
  return el('div', null,
    el('div', { class: 'progress' },
      el('div', { class: 'progress-bar', 'data-fid-bar': f.id, style: { width: '0%' } })),
    el('div', { class: 'field-help', 'data-fid-msg': f.id, style: { marginTop: '4px' } }, 'Đang tải…'));
}

async function _install(f) {
  if (f.kind === 'builtin') {
    state.installBuiltin(f.id);
    toast(`Đã cài "${f.name}"`, 'success');
    _rerender();
    return;
  }
  _installing.add(f.id);
  _rerender();
  try {
    await api.features.install(f.id);   // progress + completion arrive via WS
  } catch (e) {
    _installing.delete(f.id);
    toast(`Cài thất bại: ${e.message}`, 'error');
    _rerender();
  }
}

async function _uninstall(f) {
  if (f.kind === 'builtin') {
    state.uninstallBuiltin(f.id);
    toast(`Đã gỡ "${f.name}"`, 'info');
    _rerender();
    return;
  }
  try {
    await api.features.uninstall(f.id);
    await state.refreshInstalled();
    toast(`Đã gỡ "${f.name}"`, 'info');
    _rerender();
  } catch (e) {
    toast(`Gỡ thất bại: ${e.message}`, 'error');
  }
}

function _rerender() {
  if (!_root || !document.body.contains(_root)) return;
  const body = _root.querySelector('#fs-body');
  if (body) _renderBody(body);
}

// WS — install progress/completion (registered once; updates DOM if the store
// is open, refreshes catalog so the sidebar nav picks up the new tab).
ws.on('feature_install_progress', (d) => {
  if (!d) return;
  const bar = document.querySelector(`[data-fid-bar="${d.id}"]`);
  const msg = document.querySelector(`[data-fid-msg="${d.id}"]`);
  if (bar) bar.style.width = `${d.percent || 0}%`;
  if (msg) msg.textContent = d.message || d.stage || '';
});
ws.on('feature_installed', async (d) => {
  if (!d) return;
  _installing.delete(d.id);
  await state.refreshInstalled();   // fires onChange → sidebar adds the tab
  toast('Cài đặt hoàn tất', 'success');
  _rerender();
});
ws.on('feature_install_error', (d) => {
  if (!d) return;
  _installing.delete(d.id);
  toast(`Cài thất bại: ${d.error || ''}`, 'error');
  _rerender();
});
