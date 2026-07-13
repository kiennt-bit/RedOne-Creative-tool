// Dedicated "Xóa Watermark Video" page (sidebar group: Xử lý video).
//
// UX is intentionally minimal:
//   1. Drop one or many MP4 files (multi-select OK)
//   2. Click "Bắt đầu" — videos process sequentially, no per-job settings
//   3. Each video has a status chip + progress bar in the queue
//
// Engine and device choice are deliberately HIDDEN from the user. The
// backend's `auto` resolves to LaMa if all deps are installed, else OpenCV.
// Built-in Veo3 mask is always used (Veo logo bottom-right). For custom
// masks/rect-drawing, users go to the image-only "Xóa Logo / Watermark" page.
//
// A dependency status panel sits at the bottom: chips + a single
// copy-paste install command. Reduces user confusion when something isn't
// installed yet (matches the screenshot the user complained about).

import { el, clear, toast, icon } from '../ui.js';
import { api } from '../api.js';
import { ws } from '../ws.js';


// Per-file state. We keep this in a module-scoped Map keyed by a synthetic
// id so the queue survives re-renders within the same page session.
let nextId = 1;
const queue = new Map();   // id -> {file, name, size, status, progress, label, outputUrl, error}

// Backend's job_id <-> our queue id. Filled in once watermark_started fires
// for the in-flight upload so subsequent progress events can route correctly.
let activeQueueId = null;
let lamaStatusCache = null;

// Region-mode state kept at MODULE level so it SURVIVES tab navigation (pages
// re-render on every visit; locals would be wiped). Same pattern as the
// generator tabs' `form` objects + the image-watermark `_st`.
//
// "Khoanh vùng tự chọn" supports BATCH: pick many videos, draw the region ONCE
// on a representative frame, then erase that same region from every video. The
// backend resizes the single mask to each clip (lama_inpaint `_find_crop_region`
// → mask.resize(frame_size)), so one drawn region maps to the same RELATIVE
// spot in every video — works best when the logo sits in the same place
// (ideally same resolution/aspect ratio).
const _rst = {
  items: [],        // [{id, file, name, status, progress, url, path, error}] — items[0] = đại diện
  boxes: [],        // [{x,y,w,h}] in representative-native px (mask is drawn here)
  repW: 0, repH: 0, // representative native dims; mask PNG is generated at this size
};
let _vwmMode = 'veo';
let _rNextId = 1;

// In-flight batch run. Module-level so per-video progress survives tab switches;
// the painters below re-target whatever DOM is currently mounted on each render.
const _rrun = { active: false, activeId: null, jobId: null };
let _rQueueEl = null;   // current render's #vwmr-queue (per-video rows)
let _rGoBtnEl = null;   // current render's "Xóa watermark" button
let _rOnRemove = null;  // current render's removeItem(id) (queue rows call it)

function _rRowLabel(it) {
  if (it.status === 'running') return `Đang xử lý… ${it.progress || 0}%`;
  if (it.status === 'done') return 'Hoàn thành';
  if (it.status === 'error') return '';
  return 'Đang chờ';
}

// Full render of the per-video queue — one row per video, each with its OWN
// status chip + progress bar + (when done) download. Called on structural
// changes (add/remove/status transition). Progress % ticks within a running
// row use _rUpdateRow to avoid flicker.
function paintRegionQueue() {
  const out = _rQueueEl;
  if (!out) return;
  clear(out);
  const items = _rst.items;
  if (!items.length) return;
  out.appendChild(el('div', { class: 'field-help', style: { margin: '10px 0 6px' } },
    items.length > 1 ? `${items.length} video — vùng khoanh áp cho tất cả` : '1 video'));
  items.forEach((it, i) => {
    const chipClass = it.status === 'done' ? 'chip-green' : it.status === 'error' ? 'chip-red' : it.status === 'running' ? 'chip-blue' : 'chip-yellow';
    const chipText = it.status === 'done' ? 'Xong' : it.status === 'error' ? 'Lỗi' : it.status === 'running' ? 'Đang xử lý' : 'Chờ';
    const row = el('div', { 'data-rqid': String(it.id),
      style: { padding: '10px', marginBottom: '8px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' } },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        el('span', { class: `chip ${chipClass}` }, chipText),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('div', { style: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            it.name, i === 0 ? el('span', { class: 'field-help', style: { marginLeft: '6px', fontWeight: 400 } }, '• đại diện') : null),
          el('div', { 'data-role': 'rowlabel', class: 'field-help' }, _rRowLabel(it)),
        ),
        (!_rrun.active && it.status !== 'running') ? el('button', { class: 'btn btn-icon btn-ghost', title: 'Bỏ khỏi danh sách',
          onclick: () => { if (_rOnRemove) _rOnRemove(it.id); } }, icon('x', 14)) : null,
      ),
      (it.status === 'running' || it.status === 'done')
        ? el('div', { style: { marginTop: '8px', height: '6px', background: 'var(--bg-1)', borderRadius: '3px', overflow: 'hidden' } },
            el('div', { 'data-role': 'bar', style: { height: '100%', width: (it.status === 'done' ? 100 : it.progress || 0) + '%', background: it.status === 'done' ? 'var(--green)' : 'var(--brand)', transition: 'width 0.3s' } }))
        : null,
      (it.status === 'done' && it.url)
        ? el('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            el('a', { href: it.url, download: '', class: 'btn btn-sm btn-primary' }, icon('download', 14), 'Tải về'),
            it.path ? el('button', { class: 'btn btn-sm btn-ghost', title: 'Mở thư mục',
              onclick: async () => { try { await api.files.openFolder(it.path); } catch (e) { toast(e.message, 'error'); } } }, icon('folder', 14), 'Mở thư mục') : null)
        : null,
      (it.status === 'error' && it.error)
        ? el('div', { style: { marginTop: '6px', color: 'var(--red)', fontSize: '11px' } }, it.error)
        : null,
    );
    out.appendChild(row);
  });
}

// Update ONE running row's bar + label in place (avoids flicker on % ticks).
function _rUpdateRow(it) {
  const out = _rQueueEl;
  if (!out) return;
  const row = out.querySelector(`[data-rqid="${it.id}"]`);
  if (!row) { paintRegionQueue(); return; }
  const bar = row.querySelector('[data-role="bar"]');
  if (bar) bar.style.width = (it.progress || 0) + '%';
  const lbl = row.querySelector('[data-role="rowlabel"]');
  if (lbl) lbl.textContent = _rRowLabel(it);
}


export function renderVideoWatermark(root) {
  // Hero
  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Xóa Watermark Video'),
      el('p', null,
        'Xóa logo Veo (hoặc watermark khác có mask sẵn) khỏi nhiều video cùng lúc. '
        + 'Sequential processing — mỗi video ~10-60s tùy độ dài.'),
    ),
  ));

  // ─── Mode toggle: Logo Veo (nhanh) | Chọn vùng (LaMa) ───
  const modeVeoBtn = el('button', { class: 'btn btn-sm', onclick: () => setMode('veo') },
    icon('sparkles', 15), 'Logo Veo (nhanh)');
  const modeRegionBtn = el('button', { class: 'btn btn-sm', onclick: () => setMode('region') },
    icon('image', 15), 'Khoanh vùng tự chọn');
  root.appendChild(el('div', {
    style: { display: 'inline-flex', gap: '4px', padding: '4px', marginBottom: '12px',
             background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' },
  }, modeVeoBtn, modeRegionBtn));

  const layout = el('div', { class: 'gen-layout' });
  root.appendChild(layout);

  // ─── LEFT: drop zone + actions ──────────────────────
  const left = el('div', { class: 'gen-config' });
  layout.appendChild(left);

  left.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Video nguồn'),
    el('p', { class: 'card-subtitle', style: { marginBottom: '12px' } },
      'Có thể chọn nhiều file. File sẽ được xử lý theo thứ tự.'),
    el('div', { class: 'dropzone', id: 'vwm-dz', style: { marginTop: '12px' } },
      el('div', { class: 'dropzone-icon' }, icon('upload', 28)),
      el('div', null, 'Kéo thả nhiều file MP4 hoặc click để chọn'),
      el('div', { class: 'field-help', style: { marginTop: '6px' } },
        'Hỗ trợ: .mp4, .mov, .webm, .mkv'),
      el('input', {
        type: 'file', accept: 'video/*', multiple: 'true',
        id: 'vwm-file', style: { display: 'none' },
      }),
    ),
    el('div', { style: { display: 'flex', gap: '8px', marginTop: '16px' } },
      el('button', { class: 'btn btn-primary', style: { flex: 1 }, id: 'vwm-go' },
        icon('sparkles'), 'Bắt đầu xóa watermark'),
      el('button', { class: 'btn btn-ghost', id: 'vwm-clear' },
        icon('trash', 14), 'Xóa hàng đợi'),
    ),
    el('div', { class: 'field-help', style: { marginTop: '12px' } },
      'Mặc định dùng mask Veo logo bottom-right + auto chọn engine tốt nhất có sẵn '
      + '(LaMa AI nếu cài, OpenCV nếu không). Output lưu tại '
      + 'outputs/video/watermark_removed/<ngày>/<tên> [RedOne].mp4'),
  ));

  // Dependency status card — hidden by default; loadDepsStatus() reveals
  // it only when something is missing. Avoids visual noise when everything
  // is already installed.
  const depsCard = el('div', { class: 'card', id: 'vwm-deps-card',
    style: { marginTop: '16px', display: 'none' } },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Trạng thái cài đặt'),
      el('button', { class: 'btn btn-sm btn-ghost', id: 'vwm-deps-refresh',
        title: 'Kiểm tra lại sau khi vừa cài xong (không cần restart server)' },
        icon('refresh', 14), 'Kiểm tra lại'),
    ),
    el('div', { id: 'vwm-deps', class: 'field-help' }, 'Đang kiểm tra...'),
  );
  left.appendChild(depsCard);

  // Wire refresh button — bypasses the 60s server-side cache so a check
  // right after installing reflects the new state.
  depsCard.querySelector('#vwm-deps-refresh').addEventListener('click', () => {
    loadDepsStatus(root, true);
  });

  // ─── RIGHT: queue ────────────────────────────────────
  const right = el('div', { class: 'gen-results' });
  layout.appendChild(right);

  right.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', null,
        el('h3', { class: 'card-title' }, 'Hàng đợi xử lý'),
        el('div', { class: 'card-subtitle', id: 'vwm-summary' }, 'Chưa có file'),
      ),
    ),
    el('div', { id: 'vwm-queue' },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('play', 32)),
        el('div', null, 'Drop video vào ô bên trái để bắt đầu'),
      ),
    ),
  ));

  // ─── Wire dropzone ──────────────────────────────────
  const dz = root.querySelector('#vwm-dz');
  const fi = root.querySelector('#vwm-file');
  dz.addEventListener('click', () => fi.click());
  ['dragover', 'dragleave', 'drop'].forEach(ev => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.toggle('dragover', ev === 'dragover');
      if (ev === 'drop' && e.dataTransfer.files.length) {
        addFiles([...e.dataTransfer.files]);
      }
    });
  });
  fi.addEventListener('change', () => {
    addFiles([...fi.files]);
    fi.value = '';
  });

  function addFiles(files) {
    for (const f of files) {
      // Crude video MIME / ext filter — don't block on edge cases
      const ok = f.type.startsWith('video/')
        || /\.(mp4|mov|webm|mkv|avi)$/i.test(f.name);
      if (!ok) {
        toast(`Bỏ qua "${f.name}" — không phải video`, 'warning');
        continue;
      }
      const id = nextId++;
      queue.set(id, {
        id, file: f, name: f.name, size: f.size,
        status: 'queued', progress: 0, label: 'Đang chờ',
      });
    }
    renderQueue();
  }

  // Render entire queue list (called on every change — small list, no diff needed)
  function renderQueue() {
    const wrap = root.querySelector('#vwm-queue');
    clear(wrap);
    if (queue.size === 0) {
      wrap.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('play', 32)),
        el('div', null, 'Drop video vào ô bên trái để bắt đầu'),
      ));
      root.querySelector('#vwm-summary').textContent = 'Chưa có file';
      return;
    }
    const items = [...queue.values()];
    const stats = {
      done: items.filter(x => x.status === 'done').length,
      err: items.filter(x => x.status === 'error').length,
      running: items.filter(x => x.status === 'running').length,
    };
    root.querySelector('#vwm-summary').textContent =
      `${items.length} file • OK: ${stats.done} • Lỗi: ${stats.err}`
      + (stats.running ? ` • Đang chạy: ${stats.running}` : '');

    for (const it of items) {
      const chipClass = it.status === 'done' ? 'chip-green'
                     : it.status === 'error' ? 'chip-red'
                     : it.status === 'running' ? 'chip-blue'
                     : 'chip-yellow';
      const chipText = it.status === 'done' ? 'Hoàn thành'
                     : it.status === 'error' ? 'Lỗi'
                     : it.status === 'running' ? 'Đang xử lý'
                     : 'Đang chờ';
      const sizeStr = `${(it.size / 1024 / 1024).toFixed(1)} MB`;

      const row = el('div', {
        'data-qid': it.id,
        style: {
          padding: '12px',
          marginBottom: '8px',
          background: 'var(--bg-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
        },
      },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          el('span', { class: `chip ${chipClass}` }, chipText),
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('div', { style: {
              fontWeight: 600, fontSize: '13px',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            } }, it.name),
            el('div', { class: 'field-help', 'data-role': 'label' }, `${sizeStr} • ${it.label || ''}`),
          ),
          // Per-row remove button (only when not running)
          it.status !== 'running' ? el('button', {
            class: 'btn btn-icon btn-ghost', title: 'Bỏ khỏi hàng đợi',
            onclick: () => { queue.delete(it.id); renderQueue(); },
          }, icon('x', 14)) : null,
        ),
        // Progress bar — only shown while running or post-done
        it.status === 'running' || (it.status === 'done' && it.progress > 0)
          ? el('div', {
              style: {
                marginTop: '8px', height: '6px', background: 'var(--bg-1)',
                borderRadius: '3px', overflow: 'hidden',
              },
            },
              el('div', {
                'data-role': 'bar',
                style: {
                  height: '100%', width: `${it.progress || 0}%`,
                  background: it.status === 'done' ? 'var(--green)' : 'var(--brand)',
                  transition: 'width 0.3s',
                },
              }),
            )
          : null,
        // Done actions: download + open output folder (no inline preview —
        // keeps the queue compact when processing many files).
        it.status === 'done' && it.outputUrl
          ? el('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              el('a', {
                href: it.outputUrl, download: '',
                class: 'btn btn-sm btn-primary',
              }, icon('download', 14), 'Tải về'),
              it.outputPath ? el('button', {
                class: 'btn btn-sm btn-ghost',
                title: 'Mở thư mục chứa file đã xóa watermark',
                onclick: async () => {
                  try {
                    await api.files.openFolder(it.outputPath);
                  } catch (e) { toast(e.message, 'error'); }
                },
              }, icon('folder', 14), 'Mở thư mục') : null
            )
          : null,
        it.status === 'error' && it.error
          ? el('div', {
              style: { marginTop: '6px', color: 'var(--red)', fontSize: '11px' },
            }, it.error)
          : null,
      );
      wrap.appendChild(row);
    }
  }

  // Update ONE row's progress + label in place. Rebuilding the whole queue on
  // every WS progress tick (renderQueue) tore down + recreated all rows, which
  // made them flicker continuously while a video was processing.
  function updateProgress(it) {
    const row = root.querySelector(`#vwm-queue [data-qid="${it.id}"]`);
    if (!row) { renderQueue(); return; }
    const bar = row.querySelector('[data-role="bar"]');
    if (bar) bar.style.width = `${it.progress || 0}%`;
    const lbl = row.querySelector('[data-role="label"]');
    if (lbl) lbl.textContent = `${(it.size / 1024 / 1024).toFixed(1)} MB • ${it.label || ''}`;
    const sum = root.querySelector('#vwm-summary');
    if (sum) {
      const xs = [...queue.values()];
      const done = xs.filter(x => x.status === 'done').length;
      const err = xs.filter(x => x.status === 'error').length;
      const running = xs.filter(x => x.status === 'running').length;
      sum.textContent = `${xs.length} file • OK: ${done} • Lỗi: ${err}`
        + (running ? ` • Đang chạy: ${running}` : '');
    }
  }

  // ─── Subscribe WS events ────────────────────────────
  // We watch all watermark_* events while on this page. activeQueueId routes
  // events to the correct queue item. Other pages also receive these events
  // (gallery's bulk button uses the same channel) so we must filter strictly
  // by whether we have an active upload in flight.
  const unsubs = [
    ws.on('watermark_started', (d) => {
      if (activeQueueId == null) return;
      const it = queue.get(activeQueueId);
      if (it) {
        it.job_id = d.job_id;
        it.status = 'running';
        it.label = 'Bắt đầu…';
        renderQueue();
      }
    }),
    ws.on('watermark_progress', (d) => {
      if (activeQueueId == null) return;
      const it = queue.get(activeQueueId);
      // The video tab can also receive batch progress from the gallery flow;
      // ignore unless this event's job_id matches the one we just started.
      if (!it || (it.job_id && d.job_id !== it.job_id)) return;
      it.progress = d.progress || 0;
      it.label = d.status || '';
      updateProgress(it);
    }),
  ];

  // `root` is the PERSISTENT #page-container so document.body.contains(root) is
  // always true — detect unmount via our own marker, else the watermark WS
  // subscriptions leak and accumulate across re-visits.
  const obs = new MutationObserver(() => {
    if (!root.querySelector('#vwm-go')) {
      for (const u of unsubs) try { u(); } catch (e) { /* ignore */ }
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // ─── Buttons ────────────────────────────────────────
  root.querySelector('#vwm-clear').addEventListener('click', () => {
    const running = [...queue.values()].find(x => x.status === 'running');
    if (running) return toast('Đang xử lý, không thể xóa hàng đợi', 'warning');
    queue.clear();
    renderQueue();
  });

  root.querySelector('#vwm-go').addEventListener('click', async () => {
    const pending = [...queue.values()].filter(x => x.status === 'queued' || x.status === 'error');
    if (pending.length === 0) {
      return toast('Hàng đợi trống', 'warning');
    }
    if (lamaStatusCache && !lamaStatusCache.opencv_ok && !lamaStatusCache.lama_ok) {
      return toast(
        'Chưa cài đủ dependencies — xem mục "Trạng thái cài đặt" bên dưới',
        'error',
      );
    }
    const btn = root.querySelector('#vwm-go');
    btn.disabled = true;
    btn.textContent = `Đang xử lý 0/${pending.length}…`;

    for (let i = 0; i < pending.length; i++) {
      const it = pending[i];
      btn.textContent = `Đang xử lý ${i + 1}/${pending.length}…`;
      it.status = 'running';
      it.progress = 0;
      it.label = 'Upload…';
      it.error = null;
      it.outputUrl = null;
      it.job_id = null;
      activeQueueId = it.id;
      renderQueue();

      try {
        const fd = new FormData();
        fd.append('file', it.file);
        fd.append('use_default_mask', 'true');
        fd.append('method', 'auto');
        fd.append('device', 'auto');
        const r = await api.media.videoWatermark(fd);
        it.status = 'done';
        it.progress = 100;
        it.label = 'Hoàn thành';
        it.outputUrl = r.url;
        it.outputPath = r.path;
      } catch (e) {
        it.status = 'error';
        it.error = e.message || 'Lỗi không xác định';
        it.label = 'Lỗi';
      } finally {
        activeQueueId = null;
        renderQueue();
      }
    }

    btn.disabled = false;
    btn.innerHTML = '';
    btn.appendChild(icon('sparkles'));
    btn.append(' Bắt đầu xóa watermark');

    const stats = [...queue.values()];
    const okN = stats.filter(x => x.status === 'done').length;
    const errN = stats.filter(x => x.status === 'error').length;
    if (errN === 0) {
      toast(`Hoàn tất ${okN} video — file mới có suffix [RedOne].mp4`, 'success');
    } else {
      toast(`${okN} OK / ${errN} lỗi — xem chi tiết trong hàng đợi`, 'warning');
    }
  });

  // ─── Chế độ "Khoanh vùng tự chọn" — bố cục 2 cột, đồng bộ với các tab khác ──
  // Tái dùng đúng gen-layout / gen-config / gen-results của tab "Logo Veo":
  //   TRÁI (gen-config) = nguồn video + hàng đợi + nút Xóa watermark / Xóa hàng đợi
  //   PHẢI (gen-results) = khung xử lý video đại diện để khoanh vùng
  const regionWrap = el('div', { id: 'vwm-region', class: 'gen-layout', style: { display: 'none' } });
  root.appendChild(regionWrap);

  let rVideoEl = null, rCanvas = null, rOverlay = null;

  const rStage = el('div', { id: 'vwmr-stage', style: { marginTop: '12px', position: 'relative', userSelect: 'none' } },
    el('div', { class: 'empty' }, el('div', { class: 'empty-icon' }, icon('play', 32)), el('div', null, 'Chọn video bên trái để khoanh vùng')),
  );
  const rQueueEl = el('div', { id: 'vwmr-queue' });
  const rUseFrameBtn = el('button', { class: 'btn btn-sm btn-ghost', disabled: true }, icon('image', 14), 'Chụp khung để khoanh vùng');
  const rClearBtn = el('button', { class: 'btn btn-sm btn-ghost', disabled: true }, icon('trash', 14), 'Xóa vùng đã chọn');
  const rGoBtn = el('button', { class: 'btn btn-primary', style: { flex: 1 }, disabled: true }, icon('sparkles'), 'Xóa watermark');
  const rClearAllBtn = el('button', { class: 'btn btn-ghost', disabled: true }, icon('trash', 14), 'Xóa hàng đợi');

  const rDz = el('div', { class: 'dropzone', style: { marginTop: '12px' } },
    el('div', { class: 'dropzone-icon' }, icon('upload', 28)),
    el('div', null, 'Kéo thả hoặc click chọn video (chọn được nhiều)'),
    el('div', { class: 'field-help', style: { marginTop: '6px' } }, 'Hỗ trợ: .mp4, .mov, .webm, .mkv'),
    el('input', { type: 'file', accept: 'video/*', multiple: 'true', id: 'vwmr-file', style: { display: 'none' } }),
  );
  const rFi = rDz.querySelector('#vwmr-file');
  rDz.addEventListener('click', () => rFi.click());
  ['dragover', 'dragleave', 'drop'].forEach(ev => rDz.addEventListener(ev, (e) => {
    e.preventDefault(); rDz.classList.toggle('dragover', ev === 'dragover');
    if (ev === 'drop' && e.dataTransfer.files.length) addRegionFiles([...e.dataTransfer.files]);
  }));
  rFi.addEventListener('change', () => { if (rFi.files.length) addRegionFiles([...rFi.files]); rFi.value = ''; });

  // LEFT — nguồn video + hành động + hàng đợi
  const rLeft = el('div', { class: 'gen-config' });
  rLeft.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Video nguồn'),
    el('p', { class: 'card-subtitle' },
      'Chọn nhiều video — vùng khoanh trên video đại diện áp cho tất cả. Logo nên ở cùng vị trí (tốt nhất cùng tỉ lệ).'),
    rDz,
    el('div', { style: { display: 'flex', gap: '8px', marginTop: '16px' } }, rGoBtn, rClearAllBtn),
    rQueueEl,
    el('div', { class: 'field-help', style: { marginTop: '12px' } },
      'Tự chọn bộ xử lý tốt nhất có sẵn. Output lưu tại '
      + 'outputs/video/watermark_removed/<ngày>/<tên> [RedOne].mp4'),
  ));
  regionWrap.appendChild(rLeft);

  // RIGHT — khung xử lý video đại diện (khoanh vùng)
  const rRight = el('div', { class: 'gen-results' });
  rRight.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', null,
        el('h3', { class: 'card-title' }, 'Khoanh vùng trên video đại diện'),
        el('div', { class: 'card-subtitle' },
          'Tua tới chỗ thấy rõ logo → "Chụp khung" → kéo chuột khoanh ô quanh logo (được nhiều ô).'),
      ),
    ),
    rStage,
    el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' } }, rUseFrameBtn, rClearBtn),
  ));
  regionWrap.appendChild(rRight);

  function clearBoxes() {
    _rst.boxes.length = 0;
    if (rOverlay) [...rOverlay.querySelectorAll('[data-box]')].forEach(b => b.remove());
  }

  function showStageEmpty() {
    clear(rStage);
    rStage.appendChild(el('div', { class: 'empty' }, el('div', { class: 'empty-icon' }, icon('play', 32)), el('div', null, 'Chọn video bên trái để khoanh vùng')));
  }

  function updateGoLabel() {
    const n = _rst.items.length;
    rUseFrameBtn.disabled = n === 0;
    rClearBtn.disabled = n === 0;
    rClearAllBtn.disabled = _rrun.active || n === 0;
    rGoBtn.disabled = _rrun.active || n === 0;
    clear(rGoBtn);
    rGoBtn.appendChild(icon('sparkles'));
    rGoBtn.append(n > 1 ? ` Xóa watermark (${n} video)` : ' Xóa watermark');
  }

  // Xóa toàn bộ hàng đợi (giống nút "Xóa hàng đợi" của tab Logo Veo).
  function clearAll() {
    if (_rrun.active) return toast('Đang xử lý, không thể xóa hàng đợi', 'warning');
    _rst.items.length = 0;
    _rst.boxes.length = 0;
    _rst.repW = _rst.repH = 0;
    paintRegionQueue(); updateGoLabel(); showStageEmpty();
  }

  // Remove one video from the batch. If it was the representative (items[0]),
  // reset the drawn region and reload the new representative for drawing.
  function removeItem(id) {
    if (_rrun.active) return toast('Đang xử lý, đợi xong đã nhé', 'warning');
    const idx = _rst.items.findIndex(x => x.id === id);
    if (idx < 0) return;
    const wasRep = idx === 0;
    _rst.items.splice(idx, 1);
    if (wasRep) { _rst.boxes.length = 0; _rst.repW = _rst.repH = 0; }
    paintRegionQueue(); updateGoLabel();
    if (wasRep) { if (_rst.items.length) loadRep(); else showStageEmpty(); }
  }

  function addRegionFiles(files) {
    if (_rrun.active) return toast('Đang xử lý, đợi xong đã nhé', 'warning');
    const vids = files.filter(f => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(f.name));
    if (!vids.length) return toast('Không có video hợp lệ', 'warning');
    const hadNone = _rst.items.length === 0;
    for (const f of vids) _rst.items.push({ id: _rNextId++, file: f, name: f.name, status: 'queued', progress: 0, url: null, path: null, error: null });
    paintRegionQueue(); updateGoLabel();
    if (hadNone) loadRep();   // show the representative video so the user can draw
  }

  // Load the representative video (items[0]) into the stage for region drawing.
  // Custom seek bar BELOW the video so the native control bar doesn't cover a
  // logo sitting at the bottom edge.
  function loadRep() {
    const it0 = _rst.items[0];
    if (!it0) return;
    const file = it0.file;
    rCanvas = null; rOverlay = null;
    clear(rStage);
    // Build the element WITHOUT src first, attach listeners, append to the
    // (visible) stage, THEN set src + load(). Setting src inside el() let a fast
    // blob 'loadedmetadata' fire before the listener attached AND sometimes left
    // the first frame unpainted until the page re-rendered — that was the
    // "phải sang tab khác rồi quay lại mới thấy video" bug. Append-first + load()
    // last makes the representative frame appear immediately on selection.
    rVideoEl = el('video', { preload: 'auto', muted: true, playsinline: true,
      style: { maxWidth: '100%', maxHeight: '58vh', borderRadius: '8px', display: 'block', background: '#000' } });
    const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
    const playBtn = el('button', { class: 'btn btn-sm btn-ghost', style: { minWidth: '38px' } }, '▶');
    const seek = el('input', { type: 'range', min: '0', max: '1000', value: '0', step: '1', style: { flex: 1 } });
    const timeLbl = el('span', { class: 'field-help', style: { minWidth: '84px', textAlign: 'right' } }, '0:00 / 0:00');
    playBtn.addEventListener('click', () => { if (rVideoEl.paused) rVideoEl.play(); else rVideoEl.pause(); });
    rVideoEl.addEventListener('play', () => { playBtn.textContent = '⏸'; });
    rVideoEl.addEventListener('pause', () => { playBtn.textContent = '▶'; });
    rVideoEl.addEventListener('loadedmetadata', () => {
      _rst.repW = rVideoEl.videoWidth; _rst.repH = rVideoEl.videoHeight;
      timeLbl.textContent = `0:00 / ${fmt(rVideoEl.duration)}`;
    });
    // Force the first frame to actually paint (some browsers show a black box
    // until a tiny seek) and backfill dims if loadedmetadata fired pre-listener.
    rVideoEl.addEventListener('loadeddata', () => {
      if (!_rst.repW) { _rst.repW = rVideoEl.videoWidth; _rst.repH = rVideoEl.videoHeight; }
      try { if (rVideoEl.currentTime < 0.01) rVideoEl.currentTime = 0.03; } catch (_) { /* ignore */ }
    });
    rVideoEl.addEventListener('timeupdate', () => {
      if (rVideoEl.duration) seek.value = String(Math.round(rVideoEl.currentTime / rVideoEl.duration * 1000));
      timeLbl.textContent = `${fmt(rVideoEl.currentTime)} / ${fmt(rVideoEl.duration)}`;
    });
    seek.addEventListener('input', () => { if (rVideoEl.duration) rVideoEl.currentTime = (seek.value / 1000) * rVideoEl.duration; });
    rStage.appendChild(rVideoEl);
    rStage.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' } }, playBtn, seek, timeLbl));
    // src LAST — element is now connected + visible, so load() reliably kicks
    // off and the frame renders without a tab switch.
    rVideoEl.src = URL.createObjectURL(file);
    rVideoEl.load();
  }

  rUseFrameBtn.addEventListener('click', () => {
    if (!rVideoEl || rVideoEl.readyState < 2) return toast('Đợi video tải xong rồi thử lại', 'warning');
    _rst.repW = rVideoEl.videoWidth; _rst.repH = rVideoEl.videoHeight;
    const cv = document.createElement('canvas'); cv.width = _rst.repW; cv.height = _rst.repH;
    cv.getContext('2d').drawImage(rVideoEl, 0, 0, _rst.repW, _rst.repH);
    Object.assign(cv.style, { maxWidth: '100%', maxHeight: '58vh', borderRadius: '8px', display: 'block', cursor: 'crosshair', pointerEvents: 'none' });
    const container = el('div', { style: { position: 'relative', display: 'inline-block', maxWidth: '100%' } });
    const overlay = el('div', { style: { position: 'absolute', inset: 0, cursor: 'crosshair', touchAction: 'none' } });
    container.appendChild(cv); container.appendChild(overlay);
    clear(rStage); rStage.appendChild(container);
    rCanvas = cv; rOverlay = overlay; _rst.boxes.length = 0;

    let drawing = false, startPt = null, tempBox = null;
    const loc = (e) => { const r = overlay.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const mkBox = () => el('div', { 'data-box': '1', style: { position: 'absolute', border: '2px solid #00d4ff', background: 'rgba(0,212,255,0.18)', pointerEvents: 'none' } });
    overlay.addEventListener('pointerdown', (e) => {
      e.preventDefault(); drawing = true; startPt = loc(e);
      tempBox = mkBox(); overlay.appendChild(tempBox);
      tempBox.style.left = startPt.x + 'px'; tempBox.style.top = startPt.y + 'px';
      overlay.setPointerCapture(e.pointerId);
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!drawing) return; const p = loc(e);
      tempBox.style.left = Math.min(p.x, startPt.x) + 'px';
      tempBox.style.top = Math.min(p.y, startPt.y) + 'px';
      tempBox.style.width = Math.abs(p.x - startPt.x) + 'px';
      tempBox.style.height = Math.abs(p.y - startPt.y) + 'px';
    });
    overlay.addEventListener('pointerup', (e) => {
      if (!drawing) return; drawing = false;
      try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
      const p = loc(e);
      const dx = Math.min(p.x, startPt.x), dy = Math.min(p.y, startPt.y);
      const dw = Math.abs(p.x - startPt.x), dh = Math.abs(p.y - startPt.y);
      const scale = _rst.repW / cv.clientWidth;
      if (dw * scale < 4 || dh * scale < 4) { if (tempBox) tempBox.remove(); return; }
      _rst.boxes.push({ x: Math.round(dx * scale), y: Math.round(dy * scale), w: Math.round(dw * scale), h: Math.round(dh * scale) });
    });
    overlay.addEventListener('pointercancel', () => { drawing = false; if (tempBox) tempBox.remove(); });
    toast('Kéo chuột khoanh ô quanh logo (khoanh được nhiều ô)', 'info');
  });

  rClearBtn.addEventListener('click', clearBoxes);
  rClearAllBtn.addEventListener('click', clearAll);

  rGoBtn.addEventListener('click', async () => {
    if (!_rst.items.length) return toast('Chọn ít nhất 1 video', 'warning');
    if (!_rst.boxes.length) return toast('Hãy chụp khung rồi khoanh vùng quanh logo', 'warning');
    if (!_rst.repW || !_rst.repH) return toast('Chưa đọc được kích thước video đại diện', 'warning');

    // Mask drawn ONCE at the representative's native size. The backend resizes
    // it to each video, so the region lands at the same RELATIVE spot in every
    // clip.
    // The backend reads the mask's ALPHA channel for RGBA masks (the Veo mask
    // encodes its glyph in alpha). So leave the background TRANSPARENT (alpha 0)
    // and paint each region as OPAQUE WHITE (alpha 255) — the alpha channel then
    // marks exactly the region to erase. (Filling a solid black background made
    // the whole canvas opaque -> alpha 255 everywhere -> backend inpainted the
    // ENTIRE frame -> the whole video came out gray/black.) White RGB + opaque
    // also reads correctly if the PNG is interpreted as luminance.
    const mc = document.createElement('canvas'); mc.width = _rst.repW; mc.height = _rst.repH;
    const mx = mc.getContext('2d');
    mx.clearRect(0, 0, _rst.repW, _rst.repH);   // transparent background
    mx.fillStyle = '#fff';
    for (const b of _rst.boxes) mx.fillRect(b.x, b.y, b.w, b.h);
    const blob = await new Promise(res => mc.toBlob(res, 'image/png'));

    // Reset every row to queued (supports a re-run). Run state is MODULE-level
    // so each video's own progress bar survives tab switches.
    for (const it of _rst.items) { it.status = 'queued'; it.progress = 0; it.url = null; it.path = null; it.error = null; }
    _rrun.active = true; _rrun.activeId = null; _rrun.jobId = null;
    updateGoLabel();
    paintRegionQueue();

    // WS progress routes to the row currently uploading (matched by job_id).
    const offStart = ws.on('watermark_started', (d) => { _rrun.jobId = d.job_id; });
    const offProg = ws.on('watermark_progress', (d) => {
      if (_rrun.jobId && d.job_id !== _rrun.jobId) return;
      const it = _rst.items.find(x => x.id === _rrun.activeId);
      if (!it) return;
      it.progress = Math.round(d.progress || 0);
      _rUpdateRow(it);
    });
    try {
      // Snapshot ids so the loop is stable even if the list re-renders.
      const ids = _rst.items.map(x => x.id);
      for (const id of ids) {
        const it = _rst.items.find(x => x.id === id);
        if (!it) continue;
        _rrun.activeId = id; _rrun.jobId = null;
        it.status = 'running'; it.progress = 0;
        paintRegionQueue();   // status transition -> full row rebuild (shows the bar)
        try {
          const fd = new FormData();
          fd.append('file', it.file);
          fd.append('mask', blob, 'mask.png');
          fd.append('use_default_mask', 'false');
          fd.append('method', 'auto');
          fd.append('device', 'auto');
          const r = await api.media.videoWatermark(fd);
          it.status = 'done'; it.progress = 100; it.url = r.url; it.path = r.path;
        } catch (e) {
          it.status = 'error'; it.error = e.message || 'Lỗi xử lý';
        }
        paintRegionQueue();
      }
      const ok = _rst.items.filter(x => x.status === 'done').length;
      const err = _rst.items.filter(x => x.status === 'error').length;
      if (err === 0) toast(`Đã xóa watermark ${ok} video`, 'success');
      else toast(`${ok} OK / ${err} lỗi — xem chi tiết trong hàng đợi`, 'warning');
    } finally {
      _rrun.active = false; _rrun.activeId = null; _rrun.jobId = null;
      offStart(); offProg();
      updateGoLabel();                                  // same-render button
      if (_rGoBtnEl) _rGoBtnEl.disabled = false;        // visible button after a tab switch
      paintRegionQueue();   // drop remove buttons back in, etc.
    }
  });

  function setMode(m) {
    _vwmMode = m;
    const region = m === 'region';
    layout.style.display = region ? 'none' : '';
    regionWrap.style.display = region ? '' : 'none';
    modeVeoBtn.className = `btn btn-sm ${region ? 'btn-ghost' : 'btn-primary'}`;
    modeRegionBtn.className = `btn btn-sm ${region ? 'btn-primary' : 'btn-ghost'}`;
  }
  // Bind the freshly-rendered DOM to module-level refs so a batch run started in
  // a previous render's closure keeps painting into the now-visible elements.
  _rQueueEl = rQueueEl;
  _rGoBtnEl = rGoBtn;
  _rOnRemove = removeItem;

  // Khôi phục trạng thái chế độ khoanh vùng khi quay lại tab. paintRegionQueue
  // tự vẽ lại từng dòng theo trạng thái hiện tại (đang chạy + % / đã xong + tải
  // về / lỗi), nên một batch đang chạy dở cũng nối lại đúng tiến trình mỗi video.
  updateGoLabel();
  if (_rst.items.length) loadRep();   // re-show the representative video
  paintRegionQueue();
  setMode(_vwmMode);

  // ─── Load deps status ───────────────────────────────
  loadDepsStatus(root);
}


async function loadDepsStatus(root, force = false) {
  const wrap = root.querySelector('#vwm-deps');
  const card = root.querySelector('#vwm-deps-card');
  try {
    const st = await api.media.lamaStatus(force);
    lamaStatusCache = st;

    // Hide entirely if LaMa is fully ready — nothing to upgrade.
    if (st.lama_ok) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    clear(wrap);

    // ── Case 1: OpenCV ready (bundled in EXE) — offer LaMa upgrade ──
    // This is the happy path for users on the official EXE. Watermark
    // removal already works; the wizard is OPTIONAL for higher quality.
    if (st.opencv_ok) {
      wrap.appendChild(el('div', {
        class: 'chip chip-green',
        style: { fontSize: '12px', fontWeight: 600, marginBottom: '10px' },
      }, '✓ Sẵn sàng xóa watermark'));

      wrap.appendChild(el('div', { class: 'field-help', style: { marginBottom: '12px' } },
        'Muốn chất lượng cao hơn cho watermark phức tạp? Cài thêm bộ xử lý AI '
        + '(~700MB-1.5GB tùy máy). Chỉ cài 1 lần, dùng mãi.'));

      wrap.appendChild(el('button', {
        class: 'btn btn-warm', style: { width: '100%' },
        onclick: () => openLamaWizard(root),
      }, icon('sparkles', 14), 'Nâng cấp chất lượng cao'));
      return;
    }

    // ── Case 2: OpenCV NOT available — dev mode or broken EXE ──
    // Show the chips + copy-paste install command (old behavior).
    const chip = (ok, text) => el('span', {
      class: ok ? 'chip chip-green' : 'chip chip-yellow',
      style: { marginRight: '6px', marginBottom: '6px' },
    }, `${ok ? '✓' : '⚠'} ${text}`);

    wrap.appendChild(el('div', { style: { marginBottom: '10px' } },
      chip(st.python_ok, 'Python 3'),
      chip(st.ffmpeg_ok, 'FFmpeg'),
      chip(st.cv2, 'opencv-python'),
    ));

    if (st.python) {
      wrap.appendChild(el('div', {
        class: 'field-help',
        style: {
          marginBottom: '10px', fontSize: '11px',
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--text-muted)',
        },
      }, `🔍 Đang kiểm tra: ${st.python}`));
    }

    wrap.appendChild(el('div', {
      class: `chip ${st.python_ok ? 'chip-yellow' : 'chip-red'}`,
      style: { fontSize: '12px', fontWeight: 600 },
    }, st.python_ok ? '⚠ Cần cài opencv-python — xem lệnh bên dưới'
                    : '✕ Cần cài Python 3 trước'));

    const serverPython = st.python || 'python';
    const needsQuote = serverPython.includes(' ');
    const pyArg = needsQuote ? `"${serverPython}"` : serverPython;
    const minCmd = `${pyArg} -m pip install opencv-python`;

    wrap.appendChild(el('div', {
      style: {
        marginTop: '14px', padding: '12px',
        background: 'var(--bg-2)', borderRadius: 'var(--r-md)',
        border: '1px solid var(--border)',
      },
    },
      el('div', { style: { fontWeight: 600, marginBottom: '8px' } },
        'Lệnh cài để chạy được (1 lần):'),
      el('div', { style: {
        fontFamily: 'JetBrains Mono, monospace', fontSize: '12px',
        background: 'var(--bg-1)', padding: '8px',
        borderRadius: '6px', wordBreak: 'break-all', marginBottom: '8px',
      } }, minCmd),
      el('button', {
        class: 'btn btn-sm btn-primary',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(minCmd);
            toast('Đã copy — paste vào PowerShell rồi Enter', 'success');
          } catch (e) { toast('Copy thất bại', 'error'); }
        },
      }, icon('copy', 14), 'Copy lệnh'),
      st.python_ok ? null : el('div', {
        class: 'field-help',
        style: { marginTop: '8px', color: 'var(--red)' },
      }, '⚠ Tải Python tại https://python.org/downloads/ (tick "Add Python to PATH")'),
    ));
  } catch (e) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', { style: { color: 'var(--red)' } },
      `Không check được: ${e.message}`));
  }
}


// ── LaMa upgrade wizard modal ────────────────────────────────────
// Triggered from the deps card's "Nâng cấp lên LaMa AI" button. Backend
// runs pip install + downloads the big-lama.pt model in a background
// task; WS events drive the progress bar.

let _wizardState = null;   // { root, bar, label, logBox, status, actionBtn }
let _wizardUnsub = null;

function openLamaWizard(pageRoot) {
  if (_wizardState) {
    _wizardState.root.style.display = 'flex';
    return;
  }

  const root = el('div', { class: 'modal-backdrop', style: { display: 'flex' } });
  const card = el('div', { class: 'modal', style: { maxWidth: '600px' } });
  root.appendChild(card);
  document.body.appendChild(root);

  card.appendChild(el('h3', { class: 'modal-title' }, 'Nâng cấp lên LaMa AI'));
  card.appendChild(el('div', { class: 'field-help' },
    'Cài 3 thứ vào Python trên máy bạn: '
    + 'opencv-python · simple-lama-inpainting · torch (~700MB) — '
    + 'và tải model big-lama.pt (~204MB). Mất 5-15 phút tùy mạng. '
    + 'Sau khi xong, vẫn cần restart RedOne để áp dụng.'));

  const label = el('div', {
    class: 'field-label',
    style: { marginTop: '14px', wordBreak: 'break-all' },
  }, 'Sẵn sàng cài đặt');

  const barWrap = el('div', {
    style: {
      marginTop: '10px', height: '10px', background: 'var(--bg-2)',
      borderRadius: '5px', overflow: 'hidden',
    },
  });
  const bar = el('div', {
    style: {
      height: '100%', width: '0%', background: 'var(--brand)',
      transition: 'width 0.3s',
    },
  });
  barWrap.appendChild(bar);

  // Scrolling log panel showing pip's last 20 lines
  const logBox = el('div', {
    style: {
      marginTop: '12px', maxHeight: '180px', overflowY: 'auto',
      background: 'var(--bg-1)', padding: '8px', borderRadius: '6px',
      fontFamily: 'JetBrains Mono, monospace', fontSize: '11px',
      color: 'var(--text-muted)', whiteSpace: 'pre-wrap',
      display: 'none',
    },
  });

  card.appendChild(label);
  card.appendChild(barWrap);
  card.appendChild(logBox);

  const actionBtn = el('button', { class: 'btn btn-primary' }, 'Bắt đầu cài');
  const closeBtn = el('button', { class: 'btn btn-ghost' }, 'Đóng');
  card.appendChild(el('div', {
    style: { display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' },
  }, closeBtn, actionBtn));

  _wizardState = { root, bar, label, logBox, actionBtn, stage: 'idle' };

  // Subscribe to live progress events
  import('../ws.js').then(({ ws }) => {
    if (_wizardUnsub) { _wizardUnsub(); _wizardUnsub = null; }
    _wizardUnsub = ws.on('lama_install_progress', (state) => {
      if (!_wizardState) return;
      applyWizardState(state);
    });
  });

  // Reattach to in-progress install (e.g. user reloaded page mid-install)
  api.system.lamaInstallState().then(s => {
    if (s && s.stage !== 'idle') applyWizardState(s);
  }).catch(() => {});

  actionBtn.addEventListener('click', async () => {
    const st = _wizardState;
    if (!st) return;
    if (st.stage === 'idle' || st.stage === 'error') {
      actionBtn.disabled = true;
      label.textContent = 'Đang gửi yêu cầu…';
      try {
        await api.system.lamaInstall();
        // WS events take over from here
      } catch (e) {
        label.textContent = `Lỗi: ${e.message}`;
        actionBtn.disabled = false;
      }
    } else if (st.stage === 'done') {
      // "Restart tool" path — call shutdown then user has to reopen
      try {
        await api.system.shutdown();
        document.body.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;'
          + 'height:100vh;font-family:sans-serif;color:#666;text-align:center;'
          + 'padding:20px;background:#fff">'
          + '<div><h2 style="color:#dc2626;margin-bottom:12px">Đã tắt RedOne</h2>'
          + '<p>LaMa AI đã cài xong. Mở lại tool để bắt đầu dùng.</p>'
          + '</div></div>';
      } catch (e) {
        toast(`Không tắt được tool: ${e.message}. Tắt thủ công rồi mở lại.`, 'warning');
      }
    }
  });

  closeBtn.addEventListener('click', closeLamaWizard);
}

function applyWizardState(state) {
  if (!_wizardState) return;
  const w = _wizardState;
  w.stage = state.stage;
  w.bar.style.width = `${state.percent || 0}%`;
  w.label.textContent = state.label || state.stage;

  // Show the pip log panel when we have lines to show
  if (Array.isArray(state.pip_log_tail) && state.pip_log_tail.length) {
    w.logBox.style.display = 'block';
    w.logBox.textContent = state.pip_log_tail.slice(-20).join('\n');
    w.logBox.scrollTop = w.logBox.scrollHeight;
  }

  if (state.stage === 'installing_pip') {
    w.bar.style.background = 'var(--accent-orange)';
    w.actionBtn.disabled = true;
    w.actionBtn.textContent = 'Đang cài pip packages…';
  } else if (state.stage === 'downloading_model') {
    w.bar.style.background = 'var(--brand)';
    w.actionBtn.disabled = true;
    w.actionBtn.textContent = 'Đang tải model…';
  } else if (state.stage === 'done') {
    w.bar.style.background = 'var(--green)';
    w.actionBtn.disabled = false;
    w.actionBtn.textContent = 'Tắt & restart tool';
  } else if (state.stage === 'error') {
    w.bar.style.background = 'var(--red)';
    w.actionBtn.disabled = false;
    w.actionBtn.textContent = 'Thử lại';
  }
}

function closeLamaWizard() {
  if (!_wizardState) return;
  _wizardState.root.remove();
  _wizardState = null;
  if (_wizardUnsub) { _wizardUnsub(); _wizardUnsub = null; }
}
