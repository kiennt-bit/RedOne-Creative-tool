/**
 * Video Upscale — Addon tab module.
 *
 * Renders a page where users can:
 *  - Select videos from outputs/ to upscale
 *  - Choose scale (x2/x3/x4) and denoise strength
 *  - Monitor progress via WebSocket
 *  - View/download upscaled results
 *
 * Loaded dynamically by app.js when the feature is installed.
 */

import { api } from '/js/api.js';
import { el, icon, toast } from '/js/ui.js';
import { ws } from '/js/ws.js';

let _root = null;
let _upscaling = false;

export async function renderVideoUpscale(root) {
  _root = root;
  root.innerHTML = '';

  const header = el('div', { className: 'upscale-header' },
    el('h2', {}, icon('trending_up', 22), ' Video Upscale'),
    el('p', { className: 'subtitle' },
      'Nâng cấp chất lượng video với Real-ESRGAN AI (GPU-accelerated)')
  );

  // Check availability
  const statusEl = el('div', { className: 'upscale-status' });
  let available = false;
  try {
    const res = await api.get('/api/content/upscale-status');
    available = res.available;
  } catch { /* ignore */ }

  if (!available) {
    statusEl.innerHTML = `
      <div class="status-warning">
        <span class="material-symbols-outlined">warning</span>
        <div>
          <strong>Chưa sẵn sàng</strong>
          <p>realesrgan-ncnn-vulkan chưa được cài đặt. 
             Vui lòng cài tính năng "Video Upscale" từ Kho tính năng.</p>
        </div>
      </div>`;
    root.append(header, statusEl);
    return;
  }

  // ── Controls ──
  const scaleSelect = el('select', { id: 'upscale-scale' },
    el('option', { value: '2', selected: true }, 'x2 (Khuyến nghị)'),
    el('option', { value: '3' }, 'x3'),
    el('option', { value: '4' }, 'x4 (Chậm)')
  );

  const denoiseSlider = el('input', {
    type: 'range', id: 'upscale-denoise',
    min: '0', max: '1', step: '0.1', value: '0.5',
  });
  const denoiseLabel = el('span', { className: 'denoise-value' }, '0.5');
  denoiseSlider.addEventListener('input', () => {
    denoiseLabel.textContent = denoiseSlider.value;
  });

  const fileInput = el('input', {
    type: 'file', id: 'upscale-file',
    accept: 'video/*', multiple: true,
    style: 'display:none',
  });

  const dropZone = el('div', { className: 'upscale-dropzone', id: 'upscale-dropzone' },
    el('div', { className: 'drop-content' },
      icon('upload_file', 48),
      el('p', {}, 'Kéo thả video hoặc bấm để chọn'),
      el('p', { className: 'drop-hint' }, 'Hỗ trợ MP4, MOV, AVI, MKV')
    )
  );

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handleFiles(e.dataTransfer.files);
    }
  });

  const selectedList = el('div', { className: 'upscale-selected', id: 'upscale-selected' });
  const progressArea = el('div', { className: 'upscale-progress', id: 'upscale-progress' });
  const resultsArea = el('div', { className: 'upscale-results', id: 'upscale-results' });

  const startBtn = el('button', {
    className: 'btn btn-primary upscale-start',
    id: 'upscale-start-btn',
    disabled: true,
  }, icon('rocket_launch', 18), ' Bắt đầu Upscale');

  startBtn.addEventListener('click', () => startUpscale());

  const controls = el('div', { className: 'upscale-controls' },
    el('div', { className: 'control-row' },
      el('label', {}, 'Tỷ lệ phóng:'), scaleSelect
    ),
    el('div', { className: 'control-row' },
      el('label', {}, 'Khử nhiễu:'), denoiseSlider, denoiseLabel
    )
  );

  root.append(header, statusEl, dropZone, fileInput, selectedList,
    controls, startBtn, progressArea, resultsArea);

  // ── WS listeners ──
  ws.on('video_upscale_progress', onProgress);
  ws.on('video_upscale_completed', onCompleted);
  ws.on('video_upscale_error', onError);
  ws.on('video_upscale_batch_done', onBatchDone);

  _addStyles();
}

let _selectedPaths = [];

function handleFiles(files) {
  // For now just show names — actual path resolution happens server-side
  // This is a placeholder; real integration uses output paths from tasks_store
  toast('info', 'Sử dụng nút Upscale từ tab Tạo Video để chọn video đã tạo.');
}

/** Called from content page's gallery toolbar */
export function upscaleVideos(videoPaths) {
  _selectedPaths = [...videoPaths];
  _updateSelectedList();
}

function _updateSelectedList() {
  const listEl = document.getElementById('upscale-selected');
  const btn = document.getElementById('upscale-start-btn');
  if (!listEl) return;

  if (_selectedPaths.length === 0) {
    listEl.innerHTML = '<p class="empty">Chưa chọn video nào</p>';
    if (btn) btn.disabled = true;
    return;
  }

  listEl.innerHTML = '';
  for (const p of _selectedPaths) {
    const name = p.split(/[/\\]/).pop();
    const item = el('div', { className: 'selected-item' },
      icon('movie', 16),
      el('span', {}, name),
      el('button', {
        className: 'btn-icon',
        onclick: () => {
          _selectedPaths = _selectedPaths.filter(x => x !== p);
          _updateSelectedList();
        },
      }, icon('close', 14))
    );
    listEl.append(item);
  }
  if (btn) btn.disabled = false;
}

async function startUpscale() {
  if (_upscaling || _selectedPaths.length === 0) return;
  _upscaling = true;

  const scale = parseInt(document.getElementById('upscale-scale')?.value || '2');
  const denoise = parseFloat(document.getElementById('upscale-denoise')?.value || '-1');
  const btn = document.getElementById('upscale-start-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Đang upscale...'; }

  const progressArea = document.getElementById('upscale-progress');
  if (progressArea) {
    progressArea.innerHTML = `
      <div class="progress-card">
        <div class="progress-bar"><div class="progress-fill" id="upscale-fill" style="width:0%"></div></div>
        <p id="upscale-msg">Đang khởi tạo...</p>
      </div>`;
  }

  try {
    await api.post('/api/content/upscale-video', {
      video_paths: _selectedPaths,
      scale,
      denoise,
    });
  } catch (e) {
    toast('error', `Upscale thất bại: ${e.message || e}`);
    _upscaling = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Bắt đầu Upscale'; }
  }
}

function onProgress(d) {
  const fill = document.getElementById('upscale-fill');
  const msg = document.getElementById('upscale-msg');
  if (fill) fill.style.width = `${d.percent}%`;
  if (msg) msg.textContent = d.message;
}

function onCompleted(d) {
  const resultsArea = document.getElementById('upscale-results');
  if (!resultsArea) return;
  const name = d.output_path.split(/[/\\]/).pop();
  const card = el('div', { className: 'result-card' },
    el('div', { className: 'result-info' },
      icon('check_circle', 20),
      el('span', {}, name)
    ),
    el('a', {
      href: `/outputs/video/${name}`,
      download: name,
      className: 'btn btn-sm',
    }, icon('download', 14), ' Tải')
  );
  resultsArea.append(card);
}

function onError(d) {
  toast('error', `Upscale thất bại: ${d.error}`);
}

function onBatchDone(d) {
  _upscaling = false;
  const btn = document.getElementById('upscale-start-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Bắt đầu Upscale'; }
  const msg = document.getElementById('upscale-msg');
  if (msg) msg.textContent = `Hoàn tất! ${d.results?.length || 0}/${d.total} video.`;
  toast('success', `Upscale hoàn tất: ${d.results?.length || 0} video`);
}

function _addStyles() {
  if (document.getElementById('upscale-styles')) return;
  const style = document.createElement('style');
  style.id = 'upscale-styles';
  style.textContent = `
    .upscale-header h2 { display:flex; align-items:center; gap:8px; margin:0 0 4px; }
    .upscale-header .subtitle { color:var(--text-muted); margin:0 0 16px; }
    .status-warning {
      display:flex; gap:12px; align-items:flex-start;
      padding:16px; border-radius:12px;
      background:var(--surface-warning, rgba(255,170,0,.12));
      border:1px solid var(--border-warning, rgba(255,170,0,.3));
    }
    .status-warning .material-symbols-outlined { color:#ffa600; font-size:28px; }
    .status-warning strong { color:var(--text); }
    .status-warning p { color:var(--text-muted); margin:4px 0 0; }
    .upscale-dropzone {
      border:2px dashed var(--border, #444); border-radius:16px;
      padding:40px 20px; text-align:center; cursor:pointer;
      transition: all .2s; margin:12px 0;
    }
    .upscale-dropzone:hover, .upscale-dropzone.dragover {
      border-color:var(--accent); background:rgba(var(--accent-rgb),.06);
    }
    .drop-content { display:flex; flex-direction:column; align-items:center; gap:8px; }
    .drop-content .material-symbols-outlined { font-size:48px; color:var(--text-muted); }
    .drop-hint { color:var(--text-muted); font-size:13px; }
    .upscale-controls {
      display:flex; gap:24px; flex-wrap:wrap; margin:16px 0;
      padding:16px; background:var(--surface-raised); border-radius:12px;
    }
    .control-row { display:flex; align-items:center; gap:8px; }
    .control-row label { font-weight:500; white-space:nowrap; }
    .control-row select { padding:6px 12px; border-radius:8px; background:var(--surface); border:1px solid var(--border); color:var(--text); }
    .control-row input[type=range] { width:120px; }
    .denoise-value { min-width:28px; text-align:center; font-variant-numeric:tabular-nums; }
    .upscale-start {
      display:flex; align-items:center; gap:6px;
      padding:10px 24px; font-size:15px; font-weight:600;
    }
    .upscale-selected { margin:8px 0; }
    .upscale-selected .empty { color:var(--text-muted); font-size:14px; }
    .selected-item {
      display:flex; align-items:center; gap:8px;
      padding:6px 10px; border-radius:8px; background:var(--surface-raised);
      margin:4px 0;
    }
    .selected-item .btn-icon { margin-left:auto; background:none; border:none; cursor:pointer; color:var(--text-muted); padding:2px; }
    .progress-card {
      padding:16px; border-radius:12px; background:var(--surface-raised);
      margin:12px 0;
    }
    .progress-bar {
      height:8px; border-radius:4px; background:var(--surface);
      overflow:hidden; margin-bottom:8px;
    }
    .progress-fill {
      height:100%; border-radius:4px;
      background:linear-gradient(90deg, var(--accent), var(--accent-hover, #7c3aed));
      transition: width .3s;
    }
    #upscale-msg { color:var(--text-muted); font-size:14px; margin:0; }
    .result-card {
      display:flex; align-items:center; justify-content:space-between;
      padding:10px 14px; border-radius:10px; background:var(--surface-raised);
      margin:6px 0;
    }
    .result-info { display:flex; align-items:center; gap:8px; }
    .result-info .material-symbols-outlined { color:#22c55e; }
    .btn-sm { padding:4px 12px; font-size:13px; display:flex; align-items:center; gap:4px; }
  `;
  document.head.append(style);
}
