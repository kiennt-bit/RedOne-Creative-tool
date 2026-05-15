// Selection toolbar + multi-select helpers for generator galleries (content,
// image, long_video). Each page calls renderSelectionToolbar() above its
// gallery grid; cards mark themselves with .selected when checkbox is ticked.
import { el, toast } from './ui.js';
import { api } from './api.js';

/**
 * Build a toolbar element with: select-all, clear, download, clear-from-view.
 * Action buttons are hidden until at least one card is selected.
 *
 * @param {Object} opts
 * @param {() => HTMLElement[]} opts.getCards         - all card elements in DOM
 * @param {(card: HTMLElement) => string|null} opts.pathOf - server path on a card
 * @param {() => void} [opts.onChange]                - re-render hook
 * @param {(paths: string[]) => void} [opts.onClearSelected] - remove items
 *        from the in-memory gallery (NOT delete from disk). If absent, the
 *        Clear button is hidden.
 * @returns {HTMLElement}
 */
export function makeSelectionToolbar({ getCards, pathOf, onChange, onClearSelected }) {
  const counterEl = el('span', { class: 'text-muted text-sm' }, '0 đã chọn');

  function selectedCards() {
    return getCards().filter(c => c.classList.contains('selected'));
  }

  // Buttons that should only appear when ≥1 card is selected
  const btnDownload = iconBtn('download', 'Tải về đã chọn', async () => {
    const paths = selectedCards().map(pathOf).filter(Boolean);
    if (!paths.length) return;
    try {
      if (paths.length === 1) {
        const url = '/files/' + paths[0].replace(/\\/g, '/').split('outputs/').pop();
        const a = document.createElement('a');
        a.href = url; a.download = '';
        document.body.appendChild(a);
        a.click(); a.remove();
        toast('Đang tải về...', 'info');
      } else {
        await api.files.downloadZip(paths);
        toast(`Đã tải zip ${paths.length} files`, 'success');
      }
    } catch (e) { toast(`Tải lỗi: ${e.message}`, 'error'); }
  }, 'btn-primary');

  const btnSave = iconBtn('plus', 'Lưu vào outputs', async () => {
    const paths = selectedCards().map(pathOf).filter(Boolean);
    const pending = paths.filter(p => p.replace(/\\/g, '/').includes('outputs/_pending/'));
    if (!pending.length) return toast('Chỉ áp dụng cho file tạm (outputs/_pending)', 'info');
    try {
      const r = await api.files.moveToOutputs(pending);
      toast(`Đã chuyển ${r.moved} file sang outputs/`, 'success');
      if (onChange) onChange();
    } catch (e) { toast(e.message, 'error'); }
  });

  const btnClear = iconBtn('x', 'Bỏ khỏi danh sách', () => {
    const paths = selectedCards().map(pathOf).filter(Boolean);
    if (!paths.length) return;
    if (onClearSelected) onClearSelected(paths);
    toast(`Đã bỏ ${paths.length} mục khỏi danh sách (file vẫn còn trên ổ đĩa)`, 'info');
  }, 'btn-danger');

  // Hide selection actions by default
  const selectionButtons = [btnDownload, btnSave, btnClear];
  for (const b of selectionButtons) b.style.display = 'none';

  function refreshCounter() {
    const n = selectedCards().length;
    counterEl.textContent = `${n} đã chọn`;
    const show = n > 0;
    btnDownload.style.display = show ? '' : 'none';
    btnSave.style.display = show ? '' : 'none';
    btnClear.style.display = (show && onClearSelected) ? '' : 'none';
  }

  const toolbar = el('div', {
    class: 'selection-toolbar',
    style: {
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '10px 12px', marginBottom: '12px',
      background: 'var(--bg-2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md)',
      flexWrap: 'wrap',
    },
  },
    iconBtn('check', 'Chọn tất cả', () => {
      getCards().forEach(c => {
        c.classList.add('selected');
        const cb = c.querySelector('.card-checkbox');
        if (cb) cb.checked = true;
      });
      refreshCounter();
    }),
    iconBtn('x', 'Bỏ chọn', () => {
      getCards().forEach(c => {
        c.classList.remove('selected');
        const cb = c.querySelector('.card-checkbox');
        if (cb) cb.checked = false;
      });
      refreshCounter();
    }),
    counterEl,
    el('div', { style: { flex: 1 } }),
    btnDownload,
    btnSave,
    btnClear,
  );

  function iconBtn(name, label, onclick, extraClass = '') {
    const icons = {
      check: '<path d="M5 12l5 5L20 7" stroke="currentColor" stroke-width="2" fill="none"/>',
      x: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2"/>',
      download: '<path d="M5 20h14v-2H5v2z M12 4v10l4-4 1 1-5 5-5-5 1-1 4 4V4z" fill="currentColor"/>',
      plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2"/>',
      trash: '<path d="M6 7v13h12V7H6z M9 4h6v2H9z" fill="none" stroke="currentColor" stroke-width="2"/>',
    };
    const wrap = document.createElement('span');
    wrap.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14">${icons[name] || ''}</svg>`;
    return el('button', { class: `btn btn-sm ${extraClass}`, onclick },
      wrap.firstChild,
      label,
    );
  }

  toolbar._refreshCounter = refreshCounter;

  return toolbar;
}

/**
 * Attach a checkbox to a card. The card element will toggle .selected.
 * Returns the card element (for chaining).
 *
 * @param {HTMLElement} card      - .scene-card element
 * @param {string} path           - server file path
 * @param {HTMLElement} toolbar   - toolbar from makeSelectionToolbar()
 */
export function attachCardCheckbox(card, path, toolbar) {
  if (!path) return card;
  card.dataset.path = path;
  const cb = el('input', {
    type: 'checkbox',
    class: 'card-checkbox',
    onclick: (e) => {
      e.stopPropagation();
      card.classList.toggle('selected', e.target.checked);
      if (toolbar && toolbar._refreshCounter) toolbar._refreshCounter();
    },
  });
  const thumb = card.querySelector('.scene-thumb');
  if (thumb) thumb.appendChild(cb);
  return card;
}
