// Image generation page (Imagen / Nano Banana via Google Labs)
// State is persisted in tasksStore so the gallery survives page navigation.
import { el, clear, toast, setLoading, icon } from '../ui.js';
import { api } from '../api.js';
import { tasksStore } from '../tasks_store.js';
import { makeSelectionToolbar, attachCardCheckbox, makeRetryFailedButton } from '../gallery_actions.js';

// ── Per-form state that survives navigation (singleton, module-level) ──
const form = {
  prompts: [''],
  model: 'nano_banana_pro',
  aspect: '1:1',
  countPerPrompt: 1,
  concurrent: 1,
  taskName: '',
  refImagePaths: [],
  refImagePreviews: [],   // [{ name, url }]  — preserved across re-renders
};

function defaultTaskName() {
  const d = new Date();
  const ts = `${d.getHours().toString().padStart(2, '0')}h${d.getMinutes().toString().padStart(2, '0')}`;
  return `image_${ts}`;
}

function applySavedDefaults() {
  if (form._initialized) return;
  form._initialized = true;
  const s = window.__app?.store?.settings || {};
  // Image page only uses aspect from settings (its model dropdown is independent
  // of video quality presets)
  if (s.default_aspect) form.aspect = s.default_aspect;
}

export function renderImage(root) {
  applySavedDefaults();

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 22)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Tạo Ảnh AI'),
      el('p', null, 'Sinh ảnh bằng Nano Banana / Imagen qua Google Labs, hàng loạt + reference'),
    ),
  ));

  const layout = el('div', { class: 'gen-layout' });
  root.appendChild(layout);

  // ── LEFT: config ──────────────────────────────────────
  const left = el('div', { class: 'gen-config' },
    el('div', { class: 'card' },
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Tên task'),
        el('input', { class: 'input', id: 'img-taskname',
          placeholder: 'vd: chan_dung_studio' }),
        el('div', { class: 'field-help' },
          'File sẽ lưu tại outputs/image/<ngày>/<tên_task>/'),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Model'),
        el('select', { class: 'select', id: 'img-model' },
          el('option', { value: 'nano_banana_pro' }, 'Nano Banana Pro (mới nhất)'),
          el('option', { value: 'nano_banana_2' }, 'Nano Banana 2'),
          el('option', { value: 'imagen_4' }, 'Imagen 4'),
        ),
      ),
      el('div', { class: 'form-row' },
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Tỉ lệ'),
          el('select', { class: 'select', id: 'img-aspect' },
            el('option', { value: '1:1' }, '1:1 (vuông)'),
            el('option', { value: '16:9' }, '16:9 (ngang)'),
            el('option', { value: '9:16' }, '9:16 (dọc)'),
            el('option', { value: '4:3' }, '4:3'),
            el('option', { value: '3:4' }, '3:4'),
          ),
        ),
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Số ảnh / prompt'),
          el('input', { type: 'number', class: 'input', id: 'img-count', value: form.countPerPrompt, min: 1, max: 8 }),
        ),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Số luồng song song'),
        el('input', { type: 'number', class: 'input', id: 'img-concurrent', value: form.concurrent, min: 1, max: 8 }),
        el('div', { class: 'field-help' },
          'Số ảnh tạo đồng thời. 2-3 là tốt nhất, cao hơn dễ bị reCAPTCHA 403.'),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Ảnh tham chiếu (nhân vật / phong cách)'),
        el('div', { class: 'dropzone', id: 'img-dropzone' },
          el('div', { class: 'dropzone-icon' }, icon('image', 22)),
          el('div', null, 'Kéo thả nhiều ảnh hoặc click'),
          el('div', { class: 'field-help' }, 'Tùy chọn — model sẽ tham chiếu phong cách / nhân vật'),
          el('input', { type: 'file', accept: 'image/*', multiple: 'true', id: 'img-ref-file', style: { display: 'none' } }),
        ),
        el('div', { id: 'img-ref-list', style: { marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '6px' } }),
      ),
      el('div', { style: { display: 'flex', gap: '8px', marginTop: '20px' } },
        el('button', { class: 'btn btn-primary', style: { flex: 1 }, id: 'img-start' },
          icon('sparkles'), el('span', null, 'Tạo ảnh'),
        ),
        el('button', { class: 'btn btn-danger hidden', id: 'img-cancel' },
          icon('stop'), el('span', null, 'Hủy'),
        ),
      ),
      el('div', { class: 'field-help', style: { marginTop: '12px' } },
        'Bấm sang trang khác rồi quay lại sẽ KHÔNG mất tiến độ.'),
    ),
  );
  layout.appendChild(left);

  // Restore form select values
  left.querySelector('#img-model').value = form.model;
  left.querySelector('#img-aspect').value = form.aspect;
  left.querySelector('#img-concurrent').value = form.concurrent;
  const nameInput = left.querySelector('#img-taskname');
  nameInput.value = form.taskName || defaultTaskName();
  form.taskName = nameInput.value;
  nameInput.addEventListener('input', (e) => { form.taskName = e.target.value; });

  // ── RIGHT: prompts + gallery ──────────────────────────
  const right = el('div', { class: 'gen-results' });
  layout.appendChild(right);

  const promptsCard = el('div', { class: 'card', style: { marginBottom: '16px' } },
    el('div', { class: 'card-header' },
      el('div', null,
        el('h3', { class: 'card-title' }, 'Prompts'),
        el('div', { class: 'card-subtitle', id: 'img-count-label' }, '1 prompt'),
      ),
      el('div', { style: { display: 'flex', gap: '8px' } },
        el('button', { class: 'btn btn-sm btn-ghost', id: 'img-import' },
          icon('upload', 14), 'Import .txt',
        ),
        el('button', { class: 'btn btn-sm btn-danger', id: 'img-clear-prompts' },
          icon('trash', 14), 'Xóa tất cả',
        ),
        el('button', { class: 'btn btn-sm btn-primary', id: 'img-add' },
          icon('plus', 14), 'Thêm prompt',
        ),
      ),
    ),
    // Bulk paste — split by blank lines into separate prompts
    el('div', { style: {
      background: 'var(--bg-2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md)',
      padding: '12px',
      marginBottom: '12px',
    } },
      el('label', { class: 'field-label' },
        '⚡ Bulk prompt — paste nhanh nhiều prompts'),
      el('textarea', { class: 'textarea', id: 'img-bulk-prompt', rows: 4,
        placeholder: '• 1 đoạn → ghi đè danh sách bằng 1 prompt\n• Nhiều đoạn cách nhau bằng dòng trắng → mỗi đoạn = 1 prompt riêng\n\nVí dụ:\n\nchân dung phụ nữ, ánh sáng vàng\n\ntoàn cảnh núi, sương mù\n\ncận cảnh hoa hồng đỏ' }),
      el('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' } },
        el('button', { class: 'btn btn-sm btn-primary', id: 'img-bulk-apply' },
          icon('check', 14), 'Áp dụng'),
        el('div', { class: 'field-help', id: 'img-bulk-help', style: { margin: 0 } },
          'Nhập 1 hoặc nhiều prompts'),
      ),
    ),
    el('div', { class: 'prompt-list', id: 'img-list' }),
  );
  right.appendChild(promptsCard);

  // Helpers for bulk-paste
  function splitBulkPrompts(text) {
    return (text || '')
      .split(/\n\s*\n+/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  function refreshImgBulkHelp() {
    const help = root.querySelector('#img-bulk-help');
    const ta = root.querySelector('#img-bulk-prompt');
    if (!help || !ta) return;
    const blocks = splitBulkPrompts(ta.value);
    if (blocks.length >= 2) {
      help.textContent = `→ phát hiện ${blocks.length} đoạn — sẽ thay thế danh sách bằng ${blocks.length} prompts`;
      help.style.color = 'var(--brand)';
    } else if (blocks.length === 1) {
      help.textContent = '→ ghi đè danh sách bằng 1 prompt này';
      help.style.color = 'var(--text-muted)';
    } else {
      help.textContent = 'Nhập 1 hoặc nhiều prompts';
      help.style.color = 'var(--text-muted)';
    }
  }

  const resultsCard = el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', null,
        el('h3', { class: 'card-title' }, 'Ảnh kết quả'),
        el('div', { class: 'card-subtitle', id: 'img-status' }, 'Chưa có job'),
      ),
      el('div', { id: 'img-header-actions', style: { display: 'flex', gap: '8px' } },
        el('button', {
          class: 'btn btn-sm btn-danger hidden',
          id: 'img-clear-all',
          title: 'Xóa toàn bộ danh sách (huỷ tác vụ đang chạy, file vẫn còn trên ổ đĩa)',
          onclick: clearCurrentTask,
        }, icon('trash', 14), 'Xóa danh sách'),
      ),
    ),
    el('div', { id: 'img-results' },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 28)),
        el('div', null, 'Sinh ảnh để xem ở đây'),
      ),
    ),
  );
  right.appendChild(resultsCard);

  // Run upscale on selected items. Backend processes sequentially and
  // streams WS events (`upscale_started` / `_completed` / `_error`) which
  // tasks_store translates into per-item `upscale_status` flags — the
  // gallery chips re-render automatically via the normal notify path.
  // When the batch finishes, auto-download all the upscaled files.
  async function runBatchUpscale(itemIds, resolution) {
    const initial = toast(
      `Đang upscale ${itemIds.length} ảnh → ${resolution.toUpperCase()}… `
      + `(có thể mất 5-10s/ảnh)`,
      'info', 0,   // sticky toast — won't auto-dismiss
    );
    try {
      const r = await api.image.upscaleBatch(itemIds, resolution);
      // Auto-download results
      const paths = (r.completed || []).map(c => c.path);
      if (paths.length === 1) {
        const url = (r.completed[0].url) || ('/files/' + paths[0].split(/outputs[\\/]/).pop());
        const a = document.createElement('a');
        a.href = url; a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
      } else if (paths.length > 1) {
        try {
          await api.files.downloadZip(paths);
        } catch (e) {
          toast(`Tải zip lỗi: ${e.message}`, 'error');
        }
      }
      const okN = (r.completed || []).length;
      const errN = (r.errors || []).length;
      if (errN === 0) {
        toast(`Đã upscale ${okN} ảnh → ${resolution.toUpperCase()}`, 'success');
      } else {
        toast(`Upscale: ${okN} OK, ${errN} lỗi`, errN ? 'warning' : 'success');
      }
    } finally {
      // Dismiss the sticky toast
      if (initial && typeof initial.remove === 'function') initial.remove();
    }
  }

  async function clearCurrentTask() {
    const tid = currentTaskId();
    if (!tid) return;
    // Best-effort cancel if still running
    try {
      const t = tasksStore.get(tid);
      if (t && t.status === 'running') {
        await api.image.cancel(tid).catch(() => {});
      }
    } catch (e) { /* ignore */ }
    tasksStore.remove(tid);
    _currentTaskId = null;
    renderTaskGallery(null);
    toast('Đã xóa danh sách (file vẫn còn trên ổ đĩa)', 'info');
  }

  // ── Prompts list rendering ────────────────────────────
  const list = root.querySelector('#img-list');
  const countLabel = root.querySelector('#img-count-label');
  function refreshList() {
    clear(list);
    form.prompts.forEach((p, i) => {
      const row = el('div', { class: 'prompt-row' },
        el('div', { class: 'row-number' }, String(i + 1)),
        el('textarea', {
          class: 'textarea',
          rows: 2,
          placeholder: 'Mô tả ảnh muốn tạo... (English work best)',
          oninput: (e) => { form.prompts[i] = e.target.value; },
          style: { flex: 1, minHeight: '44px' },
        }, p),
        el('div', { class: 'row-actions' },
          form.prompts.length > 1
            ? el('button', { class: 'btn btn-icon btn-ghost', title: 'Xóa', onclick: () => {
                form.prompts.splice(i, 1); refreshList();
              } }, icon('trash', 14))
            : null,
        ),
      );
      row.querySelector('textarea').value = p;
      list.appendChild(row);
    });
    countLabel.textContent = `${form.prompts.length} prompt${form.prompts.length > 1 ? 's' : ''}`;
  }
  refreshList();

  root.querySelector('#img-add').addEventListener('click', () => {
    form.prompts.push(''); refreshList();
  });
  root.querySelector('#img-import').addEventListener('click', () => {
    const fi = document.createElement('input');
    fi.type = 'file'; fi.accept = '.txt';
    fi.onchange = async () => {
      if (!fi.files[0]) return;
      const text = await fi.files[0].text();
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length === 0) return toast('File rỗng', 'warning');
      form.prompts = lines;
      refreshList();
      toast(`Đã import ${lines.length} prompts`, 'success');
    };
    fi.click();
  });

  // Bulk-paste: smart split by blank lines, replace prompts list
  root.querySelector('#img-bulk-prompt').addEventListener('input', refreshImgBulkHelp);
  root.querySelector('#img-bulk-apply').addEventListener('click', () => {
    const blocks = splitBulkPrompts(root.querySelector('#img-bulk-prompt').value);
    if (blocks.length === 0) return toast('Nhập prompt trước', 'warning');
    form.prompts = blocks.slice();
    refreshList();
    toast(`Đã thay thế danh sách bằng ${blocks.length} prompt${blocks.length > 1 ? 's' : ''}`, 'success');
  });

  // Clear all prompts (keep reference images)
  root.querySelector('#img-clear-prompts').addEventListener('click', async () => {
    const { confirm } = await import('../ui.js');
    if (!await confirm('Xóa tất cả prompts hiện có?', 'Xác nhận')) return;
    form.prompts = [''];
    refreshList();
    toast('Đã xóa toàn bộ prompts (ảnh tham chiếu vẫn còn)', 'info');
  });

  // Initial help text
  refreshImgBulkHelp();

  // ── Reference images ──────────────────────────────────
  const refDz = root.querySelector('#img-dropzone');
  const refFi = root.querySelector('#img-ref-file');
  const refListEl = root.querySelector('#img-ref-list');
  refDz.addEventListener('click', () => refFi.click());
  ['dragover', 'dragleave', 'drop'].forEach(ev => {
    refDz.addEventListener(ev, e => {
      e.preventDefault();
      refDz.classList.toggle('dragover', ev === 'dragover');
      if (ev === 'drop' && e.dataTransfer.files.length) {
        refFi.files = e.dataTransfer.files;
        handleRefFiles();
      }
    });
  });
  refFi.addEventListener('change', handleRefFiles);

  function appendRefThumb(thumb) {
    const node = el('div', { style: { position: 'relative' } },
      el('img', { src: thumb.url, style: {
        width: '64px', height: '64px', objectFit: 'cover',
        borderRadius: '8px', border: '1px solid var(--border)',
      } }),
      el('button', { class: 'btn btn-icon btn-ghost', style: {
        position: 'absolute', top: '-6px', right: '-6px',
        background: 'var(--red)', color: 'white', width: '20px', height: '20px',
        padding: 0, borderRadius: '50%',
      }, onclick: () => {
        const idx = form.refImagePaths.indexOf(thumb.path);
        if (idx >= 0) {
          form.refImagePaths.splice(idx, 1);
          form.refImagePreviews.splice(idx, 1);
        }
        node.remove();
      } }, icon('x', 12)),
    );
    refListEl.appendChild(node);
  }
  // Restore previously uploaded ref thumbs
  form.refImagePreviews.forEach(appendRefThumb);

  async function handleRefFiles() {
    for (const file of refFi.files) {
      try {
        const r = await api.content.uploadImage(file);
        const url = URL.createObjectURL(file);
        const thumb = { path: r.path, url, name: file.name };
        form.refImagePaths.push(r.path);
        form.refImagePreviews.push(thumb);
        appendRefThumb(thumb);
      } catch (e) {
        toast(`Upload lỗi: ${e.message}`, 'error');
      }
    }
    refFi.value = '';
  }

  // ── Start / cancel ────────────────────────────────────
  const startBtn = root.querySelector('#img-start');
  const cancelBtn = root.querySelector('#img-cancel');

  startBtn.addEventListener('click', async () => {
    const prompts = form.prompts.map(p => (p || '').trim()).filter(Boolean);
    if (prompts.length === 0) return toast('Cần ít nhất 1 prompt', 'warning');
    form.model = root.querySelector('#img-model').value;
    form.aspect = root.querySelector('#img-aspect').value;
    form.countPerPrompt = parseInt(root.querySelector('#img-count').value || '1', 10);
    form.concurrent = parseInt(root.querySelector('#img-concurrent').value || '1', 10);

    // Expand prompts × count_per_prompt (matches backend)
    const expanded = [];
    for (const p of prompts) {
      for (let k = 0; k < form.countPerPrompt; k++) expanded.push(p);
    }

    setLoading(startBtn, true);
    try {
      const res = await api.image.start({
        prompts,
        model: form.model,
        aspect_ratio: form.aspect,
        count_per_prompt: form.countPerPrompt,
        concurrent: form.concurrent,
        reference_image_paths: form.refImagePaths.length ? form.refImagePaths : null,
        task_name: form.taskName || defaultTaskName(),
      });
      // Register the task in the global store so it survives navigation
      tasksStore.register(res.task_id, 'image', {
        items: expanded,
        aspect: form.aspect,
        model: form.model,
      });
      attachToTask(res.task_id);
      toast(`Task #${res.task_id} (${res.items} ảnh)`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setLoading(startBtn, false);
    }
  });

  cancelBtn.addEventListener('click', async () => {
    const t = currentTaskId();
    if (!t) return;
    try {
      await api.image.cancel(t);
      toast('Đã hủy', 'info');
    } catch (e) { toast(e.message, 'error'); }
  });

  // ── Gallery rendering (driven by tasksStore) ──────────
  function aspectThumbClass(aspect) {
    if (aspect === '9:16' || aspect === '3:4') return 'thumb-portrait';
    if (aspect === '1:1') return 'thumb-square';
    return '';
  }

  function renderTaskGallery(taskState) {
    // Skip if our DOM has been replaced by navigation — the WS callback may
    // fire after the user has navigated to another page.
    if (!root.isConnected) return;
    const wrap = root.querySelector('#img-results');
    if (!wrap) return;
    clear(wrap);

    const clearBtn = root.querySelector('#img-clear-all');
    if (clearBtn) clearBtn.classList.toggle('hidden', !taskState);
    retryBtn.refresh(taskState);

    if (!taskState) {
      wrap.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 28)),
        el('div', null, 'Sinh ảnh để xem ở đây'),
      ));
      root.querySelector('#img-status').textContent = 'Chưa có job';
      cancelBtn.classList.add('hidden');
      return;
    }

    const grid = el('div', { style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
      gap: '14px',
    } });
    const aspectCls = aspectThumbClass(taskState.aspect);

    // Selection toolbar — shown once any item is done
    const hasAnyDone = taskState.items.some(it => it.status === 'done' && it.output_path);
    let toolbar = null;
    if (hasAnyDone) {
      toolbar = makeSelectionToolbar({
        getCards: () => [...grid.querySelectorAll('.scene-card[data-path]')],
        pathOf: (card) => card.dataset.path,
        itemOf: (card) => {
          const id = parseInt(card.dataset.itemId || '0', 10);
          return id ? { id, mediaId: card.dataset.mediaId || null } : null;
        },
        onUpscale: async (itemIds, resolution) => {
          await runBatchUpscale(itemIds, resolution);
        },
        onChange: () => renderTaskGallery(tasksStore.get(taskState.id)),
        onClearSelected: (paths) => {
          tasksStore.removeItemsByPath(taskState.id, paths);
          renderTaskGallery(tasksStore.get(taskState.id));
        },
      });
      wrap.appendChild(toolbar);
    }

    taskState.items.forEach((it, i) => {
      const card = el('div', { class: 'scene-card' });
      const thumb = el('div', { class: `scene-thumb ${aspectCls}` },
        el('div', { class: 'scene-number' }, `#${i + 1}`),
      );

      if (it.status === 'done' && it.output_url) {
        const img = el('img', { src: it.output_url, style: { width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in' } });
        img.addEventListener('click', () => window.open(it.output_url, '_blank'));
        thumb.appendChild(img);
      } else if (it.status === 'error') {
        thumb.appendChild(el('div', { style: { color: 'var(--red)', fontSize: '11px', padding: '8px', textAlign: 'center' } },
          (it.error || 'Lỗi').slice(0, 80)));
      } else {
        thumb.appendChild(el('div', { class: 'spinner' }));
      }
      card.appendChild(thumb);

      const chipClass = it.status === 'done' ? 'chip-green'
                     : it.status === 'error' ? 'chip-red'
                     : it.status === 'generating' ? 'chip-blue'
                     : 'chip-yellow';
      const chipText = it.status === 'done' ? 'Hoàn thành'
                     : it.status === 'error' ? 'Lỗi'
                     : it.status === 'generating' ? 'Đang tạo'
                     : 'Đang chờ';

      const info = el('div', { class: 'scene-info' },
        el('div', { class: 'scene-meta' },
          el('span', { class: `chip ${chipClass}` }, chipText),
        ),
        el('div', { class: 'scene-prompt' }, it.prompt),
      );

      if (it.status === 'done' && it.output_url) {
        const actions = el('div', { class: 'scene-actions' },
          el('a', { href: it.output_url, download: '', class: 'btn btn-sm btn-ghost' },
            icon('download', 14), 'Tải'),
          el('button', { class: 'btn btn-sm btn-ghost', title: 'Copy URL', onclick: () => {
            navigator.clipboard.writeText(location.origin + it.output_url);
            toast('Đã copy URL', 'success');
          } }, icon('copy', 14)),
        );
        // Upscale status chip — shows realtime progress when 2K/4K is running
        if (it.upscale_status === 'running') {
          actions.appendChild(el('span', { class: 'chip chip-blue', style: { marginLeft: 'auto' } },
            `Đang upscale ${(it.upscale_resolution || '').toUpperCase()}…`));
        } else if (it.upscale_status === 'done' && it.upscale_url) {
          actions.appendChild(el('a', {
            href: it.upscale_url, download: '', target: '_blank',
            class: 'chip chip-green', style: { marginLeft: 'auto', textDecoration: 'none' },
            title: 'File upscaled — click để tải về',
          }, `✓ ${(it.upscale_resolution || '').toUpperCase()}`));
        } else if (it.upscale_status === 'error') {
          actions.appendChild(el('span', {
            class: 'chip chip-red', style: { marginLeft: 'auto' },
            title: it.upscale_error || 'Lỗi upscale',
          }, 'Upscale lỗi'));
        }
        info.appendChild(actions);
      }
      card.appendChild(info);
      // Attach checkbox only if file exists server-side
      if (it.status === 'done' && it.output_path) {
        // Stamp the item_id + media_id onto the card so the toolbar's upscale
        // handler can grab them without re-querying the store.
        if (it.id != null) card.dataset.itemId = String(it.id);
        if (it.media_id) card.dataset.mediaId = it.media_id;
        attachCardCheckbox(card, it.output_path, toolbar);
      }
      grid.appendChild(card);
    });

    wrap.appendChild(grid);

    const total = taskState.total || taskState.items.length;
    const done = taskState.done;
    const err = taskState.error;
    let statusText;
    if (taskState.status === 'running') {
      statusText = `Đang tạo ${done + err}/${total} • OK: ${done}, lỗi: ${err}`;
      cancelBtn.classList.remove('hidden');
    } else if (taskState.status === 'completed') {
      statusText = `Hoàn tất: ${done} OK / ${err} lỗi`;
      cancelBtn.classList.add('hidden');
    } else if (taskState.status === 'error') {
      statusText = `Lỗi: ${taskState.error_message || ''}`;
      cancelBtn.classList.add('hidden');
    } else if (taskState.status === 'cancelled') {
      statusText = 'Đã hủy';
      cancelBtn.classList.add('hidden');
    } else {
      statusText = '—';
    }
    root.querySelector('#img-status').textContent = statusText;
  }

  // ── "Gen lại N lỗi" button ───────────────────────────
  // Created once; refresh() is called from renderTaskGallery() on every
  // state update. Prepended into the header actions container so it lands
  // left of "Xóa danh sách" — the most relevant action when items failed.
  const retryBtn = makeRetryFailedButton({
    getTaskState: () => {
      const id = currentTaskId();
      const t = id && tasksStore.get(id);
      return t ? { taskId: id, errorCount: t.error || 0, status: t.status } : null;
    },
    onResetUI: (id) => tasksStore.resetErrorItems(id),
  });
  root.querySelector('#img-header-actions').prepend(retryBtn);

  // ── Live subscription ────────────────────────────────
  let unsubscribe = null;
  let _currentTaskId = null;
  function currentTaskId() { return _currentTaskId; }

  function attachToTask(taskId) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    _currentTaskId = taskId;
    const t = tasksStore.get(taskId);
    renderTaskGallery(t);
    unsubscribe = tasksStore.on(taskId, (state) => renderTaskGallery(state));
  }

  // On mount: restore the latest image task if any
  const latest = tasksStore.latestByKind('image');
  if (latest) attachToTask(latest.id);

  // Cleanup when navigated away
  const obs = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Inject any prompts sent from other pages
  const inject = sessionStorage.getItem('inject_prompts');
  if (inject) {
    try {
      const arr = JSON.parse(inject);
      if (Array.isArray(arr) && arr.length) {
        form.prompts = arr.filter(Boolean);
        refreshList();
        toast(`Đã import ${arr.length} prompt`, 'success');
      }
    } catch (e) { /* ignore */ }
    sessionStorage.removeItem('inject_prompts');
  }
}
