// Long video page — N scenes + extend + concat. State survives navigation.
import { el, clear, toast, setLoading, icon } from '../ui.js';
import { api } from '../api.js';
import { tasksStore } from '../tasks_store.js';

const form = {
  prompts: ['', ''],
  quality: 'fast',
  aspect: '16:9',
  taskName: '',
  startImagePath: null,
  startImagePreviewUrl: null,
};

function defaultTaskName() {
  const d = new Date();
  const ts = `${d.getHours().toString().padStart(2, '0')}h${d.getMinutes().toString().padStart(2, '0')}`;
  return `long_video_${ts}`;
}

// Long video supports only 16:9 and 9:16 (same as single-scene video)
const VIDEO_ASPECTS = ['16:9', '9:16'];

function applySavedDefaults() {
  if (form._initialized) return;
  form._initialized = true;
  const s = window.__app?.store?.settings || {};
  if (s.default_quality) form.quality = s.default_quality;
  if (s.default_aspect && VIDEO_ASPECTS.includes(s.default_aspect)) {
    form.aspect = s.default_aspect;
  }
  if (!VIDEO_ASPECTS.includes(form.aspect)) form.aspect = '16:9';
}

export function renderLongVideo(root) {
  applySavedDefaults();

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('play', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Tạo Video Dài (Multi-Scene)'),
      el('p', null, 'Cảnh 1 generate, các cảnh tiếp dùng Extend từ cảnh trước, rồi ghép bằng FFmpeg'),
    ),
  ));

  const layout = el('div', { class: 'gen-layout' });
  root.appendChild(layout);

  // LEFT
  layout.appendChild(el('div', { class: 'gen-config' },
    el('div', { class: 'card' },
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Tên task'),
        el('input', { class: 'input', id: 'lv-taskname',
          placeholder: 'vd: cau_chuyen_5_canh' }),
        el('div', { class: 'field-help' },
          'File sẽ lưu tại outputs/video/<ngày>/<tên_task>/'),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Model'),
        el('select', { class: 'select', id: 'lv-quality' },
          el('option', { value: 'lite_lp' }, 'Veo 3.1 — Lite [Lower Priority] · Miễn phí'),
          el('option', { value: 'lite' },    'Veo 3.1 — Lite · 5 credit/cảnh'),
          el('option', { value: 'fast' },    'Veo 3.1 — Fast · 10 credit/cảnh'),
          el('option', { value: 'quality' }, 'Veo 3.1 — Quality · 100 credit/cảnh'),
        ),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Tỉ lệ'),
        el('select', { class: 'select', id: 'lv-aspect' },
          el('option', { value: '16:9' }, '16:9 (ngang)'),
          el('option', { value: '9:16' }, '9:16 (dọc)'),
        ),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Ảnh frame đầu (tùy chọn)'),
        el('div', { class: 'dropzone', id: 'lv-dropzone' },
          el('div', { class: 'dropzone-icon' }, icon('image', 24)),
          el('div', null, 'Click để chọn ảnh'),
          el('div', { class: 'field-help' }, 'Cảnh đầu sẽ bắt đầu từ ảnh này'),
          el('input', { type: 'file', accept: 'image/*', id: 'lv-image', style: { display: 'none' } }),
        ),
        el('div', { id: 'lv-image-preview', style: { marginTop: '8px' } }),
      ),
      el('div', { style: { display: 'flex', gap: '8px', marginTop: '20px' } },
        el('button', { class: 'btn btn-primary', style: { flex: 1 }, id: 'lv-start' },
          icon('play'), 'Render video dài',
        ),
        el('button', { class: 'btn btn-danger hidden', id: 'lv-cancel' },
          icon('stop'), 'Hủy',
        ),
      ),
      el('div', { class: 'field-help', style: { marginTop: '12px' } },
        'Tối thiểu 2 prompts, tối đa 20. Mỗi cảnh ~8s. Tiến độ KHÔNG mất khi đổi trang.'),
    ),
  ));

  // Restore selects
  root.querySelector('#lv-quality').value = form.quality;
  root.querySelector('#lv-aspect').value = form.aspect;
  const nameInput = root.querySelector('#lv-taskname');
  nameInput.value = form.taskName || defaultTaskName();
  form.taskName = nameInput.value;
  nameInput.addEventListener('input', (e) => { form.taskName = e.target.value; });
  if (form.startImagePreviewUrl) {
    root.querySelector('#lv-image-preview').appendChild(
      el('img', { src: form.startImagePreviewUrl, class: 'thumb', style: { maxWidth: '200px' } })
    );
  }

  // RIGHT
  const right = el('div', { class: 'gen-results' });
  layout.appendChild(right);

  right.appendChild(el('div', { class: 'card', style: { marginBottom: '16px' } },
    el('div', { class: 'card-header' },
      el('div', null,
        el('h3', { class: 'card-title' }, 'Kịch bản từng cảnh'),
        el('div', { class: 'card-subtitle', id: 'lv-count' }, '2 cảnh'),
      ),
      el('button', { class: 'btn btn-sm btn-primary', id: 'lv-add' },
        icon('plus', 14), 'Thêm cảnh',
      ),
    ),
    el('div', { class: 'prompt-list', id: 'lv-list' }),
  ));

  right.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', null,
        el('h3', { class: 'card-title' }, 'Tiến độ'),
        el('div', { class: 'card-subtitle', id: 'lv-status' }, 'Chưa render'),
      ),
      el('button', {
        class: 'btn btn-sm btn-danger hidden',
        id: 'lv-clear-all',
        title: 'Xóa toàn bộ danh sách (huỷ tác vụ đang chạy)',
        onclick: clearCurrentTask,
      }, icon('trash', 14), 'Xóa danh sách'),
    ),
    el('div', { id: 'lv-progress' },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('play', 32)),
        el('div', null, 'Bắt đầu render để xem tiến độ từng cảnh'),
      ),
    ),
  ));

  const list = root.querySelector('#lv-list');
  const countEl = root.querySelector('#lv-count');
  function refreshList() {
    clear(list);
    form.prompts.forEach((p, i) => {
      const row = el('div', { class: 'prompt-row' },
        el('div', { class: 'row-number' }, String(i + 1)),
        el('textarea', { class: 'textarea', rows: 2, style: { flex: 1 },
          oninput: (e) => { form.prompts[i] = e.target.value; } }, p),
        el('div', { class: 'row-actions' },
          form.prompts.length > 2
            ? el('button', { class: 'btn btn-icon btn-ghost', onclick: () => {
                form.prompts.splice(i, 1); refreshList();
              } }, icon('trash', 14))
            : null,
        ),
      );
      row.querySelector('textarea').value = p;
      list.appendChild(row);
    });
    countEl.textContent = `${form.prompts.length} cảnh`;
  }
  refreshList();

  root.querySelector('#lv-add').addEventListener('click', () => {
    if (form.prompts.length >= 20) return toast('Tối đa 20 cảnh', 'warning');
    form.prompts.push(''); refreshList();
  });

  // Image upload
  const dz = root.querySelector('#lv-dropzone');
  const fi = root.querySelector('#lv-image');
  const preview = root.querySelector('#lv-image-preview');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', async () => {
    const file = fi.files[0]; if (!file) return;
    try {
      const r = await api.content.uploadImage(file);
      form.startImagePath = r.path;
      form.startImagePreviewUrl = URL.createObjectURL(file);
      preview.innerHTML = '';
      preview.appendChild(el('img', { src: form.startImagePreviewUrl, class: 'thumb', style: { maxWidth: '200px' } }));
      toast('Đã tải ảnh', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  // Start / cancel
  const startBtn = root.querySelector('#lv-start');
  const cancelBtn = root.querySelector('#lv-cancel');
  let _taskId = null;

  startBtn.addEventListener('click', async () => {
    const prompts = form.prompts.map(p => (p || '').trim()).filter(Boolean);
    if (prompts.length < 2) return toast('Cần ít nhất 2 cảnh', 'warning');
    form.quality = root.querySelector('#lv-quality').value;
    form.aspect = root.querySelector('#lv-aspect').value;
    setLoading(startBtn, true);
    try {
      const res = await api.longVideo.start({
        prompts,
        quality: form.quality,
        aspect_ratio: form.aspect,
        start_image_path: form.startImagePath,
        task_name: form.taskName || defaultTaskName(),
      });
      tasksStore.register(res.task_id, 'long_video', {
        items: prompts,
        aspect: form.aspect,
        model: form.quality,
      });
      attachToTask(res.task_id);
      toast(`Đã tạo task #${res.task_id}`, 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(startBtn, false); }
  });

  cancelBtn.addEventListener('click', async () => {
    if (!_taskId) return;
    try { await api.longVideo.cancel(_taskId); toast('Đã hủy', 'info'); } catch (e) {}
  });

  async function clearCurrentTask() {
    if (!_taskId) return;
    try {
      const t = tasksStore.get(_taskId);
      if (t && t.status === 'running') {
        await api.longVideo.cancel(_taskId).catch(() => {});
      }
    } catch (e) { /* ignore */ }
    tasksStore.remove(_taskId);
    _taskId = null;
    renderProgress(null);
    toast('Đã xóa danh sách (file vẫn còn trên ổ đĩa)', 'info');
  }

  function renderProgress(taskState) {
    if (!root.isConnected) return;
    const wrap = root.querySelector('#lv-progress');
    if (!wrap) return;
    clear(wrap);
    const clearBtn = root.querySelector('#lv-clear-all');
    if (clearBtn) clearBtn.classList.toggle('hidden', !taskState);
    if (!taskState) {
      wrap.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('play', 32)),
        el('div', null, 'Bắt đầu render để xem tiến độ từng cảnh'),
      ));
      root.querySelector('#lv-status').textContent = 'Chưa render';
      cancelBtn.classList.add('hidden');
      return;
    }

    const strip = el('div', { class: 'scene-strip' });
    taskState.items.forEach((it, i) => {
      const card = el('div', { class: 'scene-card', 'data-scene': i + 1 });
      const thumb = el('div', { class: 'scene-thumb' },
        el('div', { class: 'scene-number' }, `Cảnh ${i + 1}`),
      );
      if (it.status === 'done' && it.output_url) {
        thumb.appendChild(el('video', { src: it.output_url, controls: true, style: { width: '100%', height: '100%' } }));
      } else if (it.status === 'error') {
        thumb.appendChild(el('div', { style: { color: 'var(--red)', fontSize: '11px', padding: '8px' } },
          (it.error || 'Lỗi').slice(0, 60)));
      } else {
        thumb.appendChild(el('div', { class: 'spinner' }));
      }
      card.appendChild(thumb);

      const chipClass = it.status === 'done' ? 'chip-green'
                     : it.status === 'error' ? 'chip-red'
                     : it.status === 'generating' ? 'chip-blue'
                     : 'chip-yellow';
      const chipText = it.status === 'done' ? 'Hoàn tất'
                     : it.status === 'error' ? 'Lỗi'
                     : it.status === 'generating' ? 'Đang render'
                     : 'Chờ';

      card.appendChild(el('div', { class: 'scene-info' },
        el('div', { class: 'scene-meta' },
          el('span', { class: `chip ${chipClass}` }, chipText),
        ),
        el('div', { class: 'scene-prompt' }, it.prompt),
      ));
      strip.appendChild(card);
    });
    wrap.appendChild(strip);

    const total = taskState.items.length;
    const doneCount = taskState.items.filter(x => x.status === 'done').length;
    let statusText;
    if (taskState.status === 'running') {
      statusText = `Đang xử lý ${doneCount}/${total} cảnh`;
      cancelBtn.classList.remove('hidden');
    } else if (taskState.status === 'completed') {
      statusText = `Hoàn tất ${doneCount}/${total} cảnh — đang ghép FFmpeg`;
      cancelBtn.classList.add('hidden');
    } else if (taskState.status === 'error') {
      statusText = `Lỗi: ${taskState.error_message || ''}`;
      cancelBtn.classList.add('hidden');
    } else if (taskState.status === 'cancelled') {
      statusText = 'Đã hủy';
      cancelBtn.classList.add('hidden');
    }
    root.querySelector('#lv-status').textContent = statusText;
  }

  let unsubscribe = null;
  function attachToTask(taskId) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    _taskId = taskId;
    renderProgress(tasksStore.get(taskId));
    unsubscribe = tasksStore.on(taskId, (s) => renderProgress(s));
  }

  // Restore latest task
  const latest = tasksStore.latestByKind('long_video');
  if (latest) attachToTask(latest.id);

  const obs = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}
