// Selection toolbar + multi-select helpers for generator galleries (content,
// image, long_video). Each page calls renderSelectionToolbar() above its
// gallery grid; cards mark themselves with .selected when checkbox is ticked.
import { el, toast } from './ui.js';
import { api } from './api.js';
import { tasksStore } from './tasks_store.js';

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
 * @param {(card: HTMLElement) => {id:number, mediaId:string}|null} [opts.itemOf]
 *        - extract item_id + media_id from a card; required for upscale.
 *          When provided, "Tải về 2K" / "Tải về 4K" buttons appear next to
 *          download. Only items with a media_id are sent.
 * @param {(itemIds:number[], resolution:'2k'|'4k') => Promise} [opts.onUpscale]
 *        - called when user clicks 2K/4K. Receives the IDs of selected items
 *          that actually have a media_id. Responsible for showing progress
 *          and triggering download of the result.
 * @param {(paths:string[]) => Promise} [opts.onRemoveWatermark]
 *        - called when user clicks "Xóa watermark". Receives selected card
 *          file paths. Responsible for showing progress + result.
 * @returns {HTMLElement}
 */
export function makeSelectionToolbar({ getCards, pathOf, onChange, onClearSelected, itemOf, onUpscale, onRemoveWatermark }) {
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

  // Upscale buttons — only created when an itemOf+onUpscale pair is provided
  // (image page passes them; video pages don't, since Flow upscale is image-only).
  const upscaleEnabled = !!(itemOf && onUpscale);

  function selectedUpscalable() {
    return selectedCards()
      .map(itemOf)
      .filter(x => x && x.id != null && x.mediaId);
  }

  async function runUpscale(res) {
    const items = selectedUpscalable();
    if (!items.length) {
      return toast(
        'Không có ảnh nào upscale được — ảnh phải được tạo từ phiên bản tool mới '
        + '(có media_id). Hãy generate lại để dùng tính năng này.',
        'warning',
      );
    }
    const skipped = selectedCards().length - items.length;
    if (skipped > 0) {
      toast(`Bỏ qua ${skipped} ảnh không có media_id`, 'info');
    }
    try {
      await onUpscale(items.map(x => x.id), res);
    } catch (e) {
      toast(`Upscale lỗi: ${e.message}`, 'error');
    }
  }

  const btn2k = upscaleEnabled
    ? iconBtn('upscale', 'Tải về 2K', () => runUpscale('2k'))
    : null;
  const btn4k = upscaleEnabled
    ? iconBtn('upscale', 'Tải về 4K', () => runUpscale('4k'), 'btn-primary')
    : null;

  // Watermark removal — uses built-in Veo mask. Only shown when caller
  // wired an onRemoveWatermark handler (video pages do, image pages don't).
  const wmEnabled = !!onRemoveWatermark;
  const btnWm = wmEnabled ? iconBtn('eraser', 'Xóa watermark', async () => {
    const paths = selectedCards().map(pathOf).filter(Boolean);
    if (!paths.length) return;
    try {
      await onRemoveWatermark(paths);
    } catch (e) {
      toast(`Xóa watermark lỗi: ${e.message}`, 'error');
    }
  }, 'btn-warm') : null;

  // Hide selection actions by default
  const selectionButtons = [btnDownload, btn2k, btn4k, btnWm, btnSave, btnClear].filter(Boolean);
  for (const b of selectionButtons) b.style.display = 'none';

  function refreshCounter() {
    const n = selectedCards().length;
    counterEl.textContent = `${n} đã chọn`;
    const show = n > 0;
    btnDownload.style.display = show ? '' : 'none';
    btnSave.style.display = show ? '' : 'none';
    btnClear.style.display = (show && onClearSelected) ? '' : 'none';
    if (btn2k) btn2k.style.display = show ? '' : 'none';
    if (btn4k) btn4k.style.display = show ? '' : 'none';
    if (btnWm) btnWm.style.display = show ? '' : 'none';
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
    ...(btn2k ? [btn2k] : []),
    ...(btn4k ? [btn4k] : []),
    ...(btnWm ? [btnWm] : []),
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
      // 4 arrows pointing outward — universal "upscale" / "expand" glyph
      upscale: '<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" stroke="currentColor" stroke-width="2" fill="none"/>',
      // Eraser glyph for watermark removal
      eraser: '<path d="M3 17l8-8 6 6-8 8H3v-6zM14 6l4-4 6 6-4 4-6-6z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
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


/**
 * Build a "Gen lại N lỗi" button for the gallery card-header. Wraps
 * api.tasks.retry() with a confirmation, loading state, and clear toast
 * feedback. Returns the button element (or null when there's nothing to
 * retry).
 *
 * Shape:
 *   <button class="btn btn-sm btn-warning">🔄 Gen lại 3 lỗi</button>
 *
 * Why a separate helper instead of inlining in each page:
 *  - 3 generator pages (content, image, long_video) need identical
 *    behavior. Without this helper they'd diverge over time.
 *  - The retry flow has subtle ordering: call backend → reset store
 *    immediately so user sees instant spinners → WS events take over.
 *
 * @param {Object} opts
 * @param {() => {taskId:number, errorCount:number, status:string}} opts.getTaskState
 *        - Pulled fresh on each click so the button reflects current state
 *          (errors may have been resolved before the click).
 * @param {(taskId:number) => void} opts.onResetUI
 *        - Page-level hook called after backend confirms; usually wraps
 *          tasksStore.resetErrorItems(taskId).
 * @returns {HTMLElement}
 */
export function makeRetryFailedButton({ getTaskState, onResetUI, retryFn }) {
  // retryFn lets non-Flow galleries (e.g. Shakker) swap in their own
  // retry-failed endpoint. Defaults to the Flow tasks endpoint.
  const doRetryFailed = retryFn || ((taskId) => api.tasks.retryFailed(taskId));
  const labelSpan = el('span', null, 'Gen lại lỗi');
  const btn = el('button', {
    class: 'btn btn-sm btn-warm hidden',
    title: 'Gen lại các item bị lỗi của task hiện tại (giữ nguyên item đã hoàn thành)',
    onclick: async () => {
      const s = getTaskState();
      if (!s || !s.taskId || !s.errorCount) return;
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Đang gửi…';
      try {
        // retry-failed runs in a detached coroutine on the backend, so it
        // works even while the task is still generating other items.
        await doRetryFailed(s.taskId);
        // Reset local UI immediately. Subsequent WS events will drive the
        // per-item progress (pending → generating → done/error).
        if (onResetUI) onResetUI(s.taskId);
        toast(`Đang gen lại ${s.errorCount} item lỗi…`, 'success');
      } catch (e) {
        toast(`Retry lỗi: ${e.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    },
  },
    // Retry/refresh icon — circular arrow
    (() => {
      const wrap = document.createElement('span');
      wrap.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14">'
        + '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" stroke="currentColor" stroke-width="2" fill="none"/>'
        + '<path d="M18 3v4h-4M6 21v-4h4" stroke="currentColor" stroke-width="2" fill="none"/>'
        + '</svg>';
      return wrap.firstChild;
    })(),
    labelSpan,
  );

  /** Page calls this from renderTaskGallery() with the latest state. */
  btn.refresh = (taskState) => {
    if (!taskState || !taskState.error || taskState.error <= 0) {
      btn.classList.add('hidden');
      return;
    }
    // Visible + enabled whenever there's ≥1 error — including WHILE the task
    // is still running. The backend regenerates failed items in a detached
    // coroutine, so there's no need to wait for the task to finish.
    btn.classList.remove('hidden');
    btn.disabled = false;
    btn.title = 'Gen lại các item bị lỗi (giữ nguyên item đã hoàn thành)';
    labelSpan.textContent = `Gen lại ${taskState.error} lỗi`;
  };

  return btn;
}

/**
 * Build a small per-card "Gen lại" button for an errored item. Optimistically
 * flips the item to 'generating' in the store, then calls the backend. WS
 * events then drive it to done/error. Works even while the parent task is
 * still generating other items.
 *
 * @param {number} taskId
 * @param {number} itemId   - DB item id (null until the first WS event claims
 *                            a slot; button is only rendered for error items,
 *                            which always have an id by then)
 * @returns {HTMLElement}
 */
export function makeItemRetryButton(taskId, itemId, retryFn) {
  // retryFn lets non-Flow galleries (e.g. Shakker) swap in their own
  // per-item retry endpoint. Defaults to the Flow tasks endpoint.
  const doRetryItem = retryFn || ((iid) => api.tasks.retryItem(iid));
  const btn = el('button', {
    class: 'btn btn-sm btn-warm',
    title: 'Gen lại riêng prompt này',
    onclick: async () => {
      if (itemId == null) return;
      const orig = btn.innerHTML;
      btn.disabled = true;
      try {
        // API first (returns immediately — backend runs gen in background).
        // Only then flip the UI, so a failed call leaves the card as 'error'
        // instead of stuck on a spinner.
        await doRetryItem(itemId);
        tasksStore.retryItemUI(taskId, itemId);
      } catch (e) {
        toast(`Gen lại lỗi: ${e.message}`, 'error');
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    },
  },
    (() => {
      const wrap = document.createElement('span');
      wrap.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" style="vertical-align:-2px">'
        + '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" stroke="currentColor" stroke-width="2" fill="none"/>'
        + '<path d="M18 3v4h-4M6 21v-4h4" stroke="currentColor" stroke-width="2" fill="none"/>'
        + '</svg>';
      return wrap.firstChild;
    })(),
    el('span', { style: { marginLeft: '4px' } }, 'Gen lại'),
  );
  return btn;
}
