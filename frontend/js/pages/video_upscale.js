/**
 * Video Upscale — Addon tab module.
 *
 * Renders a page where users can:
 *  - Upload new videos or select from gallery
 *  - Choose scale (x2/x3/x4) and denoise strength
 *  - Monitor progress via WebSocket
 *  - View/download upscaled results
 */

import { api } from '/js/api.js';
import { el, icon, toast, makeLazyVideoObserver } from '/js/ui.js';
import { ws } from '/js/ws.js';

let _root = null;
let _upscaling = false;
let _selectedPaths = []; // Array of { path, name }
let _mediaObserver = null;
let _galleryItems = [];

export async function renderVideoUpscale(root) {
  _root = root;
  root.innerHTML = '';

  // Check availability
  let available = false;
  try {
    const res = await api.get('/api/content/upscale-status');
    available = res.available;
  } catch { /* ignore */ }

  if (!available) {
    root.append(
      el('div', { className: 'card', style: { maxWidth: '600px', margin: '40px auto', textAlign: 'center' } },
        icon('warning', 32, { style: { color: 'var(--yellow)', marginBottom: '12px' } }),
        el('h3', { className: 'card-title' }, 'Chưa sẵn sàng'),
        el('p', { className: 'field-help', style: { fontSize: '13.5px', marginTop: '8px' } },
          'realesrgan-ncnn-vulkan chưa được cài đặt. Vui lòng cài đặt tính năng "Video Upscale" từ Kho tính năng.'
        )
      )
    );
    return;
  }

  // 1. Layout Container
  const layout = el('div', { className: 'upscale-layout' });

  // ── LEFT COLUMN (Media Selection) ──
  const mediaCol = el('div', { className: 'upscale-col media-col' });
  
  // Dropzone
  const fileInput = el('input', { type: 'file', accept: 'video/*', multiple: true, style: 'display:none' });
  const dropZone = el('div', { className: 'dropzone', id: 'upscale-dropzone' },
    el('div', { className: 'dropzone-icon' }, icon('upload', 24)),
    el('div', { style: { fontWeight: '600', fontSize: '14px', marginBottom: '4px' } }, 'Kéo thả hoặc click để tải video lên'),
    el('div', { className: 'field-help' }, 'Hỗ trợ MP4, MOV, AVI, MKV (Tối đa 1GB)'),
    fileInput
  );
  
  const uploadProgress = el('div', { className: 'upload-progress', style: 'display:none; margin-top: 14px;' },
    el('div', { className: 'upload-bar' }, el('div', { className: 'upload-fill', id: 'upload-fill' })),
    el('span', { id: 'upload-text', className: 'field-help' }, 'Đang tải lên...')
  );
  dropZone.append(uploadProgress);

  dropZone.addEventListener('click', (e) => {
    if (e.target.closest('.upload-progress')) return;
    fileInput.click();
  });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleUploads(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleUploads(fileInput.files);
    fileInput.value = '';
  });

  // Gallery Area
  const galleryHeader = el('div', { className: 'gallery-header' },
    el('h3', { className: 'card-title' }, 'Thư viện video'),
    el('button', { className: 'btn btn-icon btn-ghost', title: 'Làm mới', onclick: () => loadGallery() }, icon('refresh', 16))
  );
  const gallerySearch = el('input', { 
    class: 'input', 
    id: 'gallery-search', 
    placeholder: 'Tìm kiếm video theo tên...', 
    style: { width: '100%', marginBottom: '12px' } 
  });
  const galleryGrid = el('div', { className: 'media-gallery', id: 'media-gallery' }, 
    el('div', { className: 'field-help' }, 'Đang tải danh sách video...')
  );
  
  mediaCol.append(dropZone, galleryHeader, gallerySearch, galleryGrid);

  gallerySearch.addEventListener('input', (e) => {
    renderGalleryGrid(e.target.value.trim().toLowerCase());
  });

  // ── RIGHT COLUMN (Settings & Controls) ──
  const settingsCol = el('div', { className: 'upscale-col settings-col' });

  // Settings Card
  const settingsCard = el('div', { className: 'card' },
    el('h3', { className: 'card-title' }, 'Cấu hình AI'),
    
    // Scale option using native select style
    el('div', { className: 'field-group', style: { marginTop: '16px' } },
      el('label', { className: 'field-label' }, 'Tỷ lệ phóng đại'),
      el('select', { className: 'select', id: 'upscale-scale' },
        el('option', { value: '2', selected: true }, 'x2 (Khuyên dùng - Cân bằng nhất)'),
        el('option', { value: '3' }, 'x3 (Độ chi tiết cao)'),
        el('option', { value: '4' }, 'x4 (Chậm - Yêu cầu GPU mạnh)')
      )
    ),

    // Denoise slider
    el('div', { className: 'field-group' },
      el('label', { className: 'field-label', style: { display: 'flex', justifyContent: 'space-between' } }, 
        el('span', {}, 'Khử nhiễu (Denoise)'),
        el('span', { id: 'denoise-label', style: { color: 'var(--brand)', fontWeight: '700' } }, '0.5')
      ),
      el('input', { type: 'range', id: 'upscale-denoise', min: '0', max: '1', step: '0.1', value: '0.5', style: { width: '100%', cursor: 'pointer' } }),
      el('div', { className: 'range-marks field-help' }, el('span', {}, 'Giữ hạt nhiễu (0.0)'), el('span', {}, 'Mịn tuyệt đối (1.0)'))
    )
  );

  settingsCard.querySelector('#upscale-denoise').addEventListener('input', (e) => {
    document.getElementById('denoise-label').textContent = e.target.value;
  });

  // Action Queue Card
  const queueCard = el('div', { className: 'card queue-card' },
    el('h3', { className: 'card-title' }, 'Hàng chờ xử lý (', el('span', { id: 'queue-count' }, '0'), ')'),
    el('div', { className: 'selected-list', id: 'upscale-selected', style: { marginTop: '12px' } },
      el('div', { className: 'field-help' }, 'Chưa chọn video nào. Nhấp chọn video ở bên trái.')
    ),
    el('button', { className: 'btn btn-primary upscale-start', id: 'upscale-start-btn', disabled: true, style: { width: '100%', marginTop: '16px' }, onclick: startUpscale },
      icon('sparkles', 16), 'Bắt đầu Upscale'
    )
  );

  const progressArea = el('div', { className: 'progress-area', id: 'upscale-progress', style: { display: 'none' } });
  const resultsArea = el('div', { className: 'results-area', id: 'upscale-results' });

  settingsCol.append(settingsCard, queueCard, progressArea, resultsArea);
  
  layout.append(mediaCol, settingsCol);
  root.append(layout);

  // WS events
  const offs = [
    ws.on('video_upscale_progress', onProgress),
    ws.on('video_upscale_completed', onCompleted),
    ws.on('video_upscale_error', onError),
    ws.on('video_upscale_batch_done', onBatchDone)
  ];

  const obs = new MutationObserver(() => {
    if (!root.contains(layout)) {
      offs.forEach(o => o());
      if (_mediaObserver) { _mediaObserver.disconnect(); _mediaObserver = null; }
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  _addStyles();
  loadGallery();
  _updateSelectedList();
}

// ── Upload Logic ──
async function handleUploads(files) {
  const filesArray = Array.from(files);
  const fill = document.getElementById('upload-fill');
  const text = document.getElementById('upload-text');
  const progress = document.querySelector('.upload-progress');
  
  progress.style.display = 'block';
  fill.style.width = '0%';
  
  for (let i = 0; i < filesArray.length; i++) {
    const file = filesArray[i];
    text.textContent = `Đang tải lên: ${file.name} (${i+1}/${filesArray.length})`;
    const fd = new FormData();
    fd.append('file', file);
    
    try {
      fill.style.width = `${((i) / filesArray.length) * 100 + 10}%`;
      const res = await api.postForm('/api/video-editor/upload', fd);
      toast(`Đã tải lên: ${file.name}`, 'success');
      addVideoToQueue({ path: res.path, name: file.name });
    } catch (e) {
      toast(`Lỗi tải lên ${file.name}: ${e.message}`, 'error');
    }
    fill.style.width = `${((i+1) / filesArray.length) * 100}%`;
  }
  
  setTimeout(() => { progress.style.display = 'none'; }, 1000);
  loadGallery();
}

// ── Gallery Logic ──
async function loadGallery() {
  const gallery = document.getElementById('media-gallery');
  if (!gallery) return;
  gallery.innerHTML = '<div class="field-help">Đang tải danh sách video...</div>';
  
  try {
    const res = await api.get('/api/video-editor/my-media?type=video');
    _galleryItems = res.media || [];
    
    // Reset search input value
    const searchInput = document.getElementById('gallery-search');
    if (searchInput) searchInput.value = '';
    
    renderGalleryGrid('');
  } catch (e) {
    gallery.innerHTML = `<div class="field-help text-danger" style="color:var(--red)">Lỗi tải danh sách video: ${e.message}</div>`;
  }
}

function renderGalleryGrid(q) {
  const gallery = document.getElementById('media-gallery');
  if (!gallery) return;
  
  if (_mediaObserver) {
    _mediaObserver.disconnect();
    _mediaObserver = null;
  }
  
  gallery.innerHTML = '';
  
  let items = _galleryItems;
  if (q) {
    items = items.filter(item => (item.name || '').toLowerCase().includes(q));
  }
  
  if (items.length === 0) {
    gallery.innerHTML = '<div class="field-help">Không tìm thấy video nào.</div>';
    return;
  }

  items.forEach(item => {
    const isSelected = _selectedPaths.some(p => p.path === item.path);
    const card = el('div', { 
      className: `media-card ${isSelected ? 'selected' : ''}`,
      onclick: () => toggleVideoSelection(item, card)
    });
    
    const thumb = el('div', { className: 'media-thumb' });
    const vid = el('video', { 'data-src': item.url, muted: true, preload: 'none' });
    thumb.append(vid);
    
    const info = el('div', { className: 'media-info' },
      el('div', { className: 'media-name', title: item.name }, item.name),
      el('div', { className: 'media-meta field-help' }, formatBytes(item.size))
    );
    
    const check = el('div', { className: 'check-circle' }, icon('check', 14));
    card.append(thumb, info, check);
    gallery.append(card);
  });

  _mediaObserver = makeLazyVideoObserver(gallery, { rootMargin: '300px' });
  gallery.querySelectorAll('video[data-src]').forEach((v) => _mediaObserver.observe(v));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ── Selection Logic ──
function toggleVideoSelection(item, cardElement) {
  const idx = _selectedPaths.findIndex(p => p.path === item.path);
  if (idx > -1) {
    _selectedPaths.splice(idx, 1);
    cardElement.classList.remove('selected');
  } else {
    _selectedPaths.push({ path: item.path, name: item.name });
    cardElement.classList.add('selected');
  }
  _updateSelectedList();
}

function addVideoToQueue(item) {
  if (!_selectedPaths.some(p => p.path === item.path)) {
    _selectedPaths.push(item);
    _updateSelectedList();
  }
}

export function upscaleVideos(videoPaths) {
  videoPaths.forEach(p => {
    const name = p.split(/[/\\]/).pop();
    addVideoToQueue({ path: p, name });
  });
}

function _updateSelectedList() {
  const listEl = document.getElementById('upscale-selected');
  const countEl = document.getElementById('queue-count');
  const btn = document.getElementById('upscale-start-btn');
  if (!listEl) return;

  countEl.textContent = _selectedPaths.length;

  if (_selectedPaths.length === 0) {
    listEl.innerHTML = '<div class="field-help">Chưa chọn video nào. Chọn từ thư viện bên trái hoặc tải lên.</div>';
    if (btn) btn.disabled = true;
    return;
  }

  listEl.innerHTML = '';
  for (const item of _selectedPaths) {
    const li = el('div', { className: 'queue-item' },
      icon('movie', 16, { style: { color: 'var(--text-muted)' } }),
      el('span', { className: 'queue-name', title: item.name }, item.name),
      el('button', {
        className: 'btn btn-icon btn-ghost remove-btn',
        style: { padding: '4px', border: 'none', background: 'none' },
        onclick: (e) => {
          e.stopPropagation();
          _selectedPaths = _selectedPaths.filter(x => x.path !== item.path);
          _updateSelectedList();
          loadGallery(); 
        },
      }, icon('x', 14))
    );
    listEl.append(li);
  }
  if (btn) btn.disabled = false;
}

// ── Upscale Execution ──
async function startUpscale() {
  if (_upscaling || _selectedPaths.length === 0) return;
  _upscaling = true;

  const scale = parseInt(document.getElementById('upscale-scale').value);
  const denoise = parseFloat(document.getElementById('upscale-denoise')?.value || '0.5');
  
  const btn = document.getElementById('upscale-start-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Đang xử lý...'; }

  const progressArea = document.getElementById('upscale-progress');
  if (progressArea) {
    progressArea.style.display = 'block';
    progressArea.innerHTML = `
      <div class="card active-task-card" style="border-color: var(--brand); margin-top: 16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-weight:600; font-size:13px;">
          <span>Tiến trình Upscale AI</span>
          <span id="upscale-percent" style="color:var(--brand)">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="upscale-fill" style="width:0%"></div></div>
        <p id="upscale-msg" class="field-help" style="margin-top:8px;">Đang tải AI model...</p>
      </div>`;
  }

  const pathsOnly = _selectedPaths.map(p => p.path);
  try {
    await api.post('/api/content/upscale-video', {
      video_paths: pathsOnly,
      scale,
      denoise,
    });
  } catch (e) {
    toast(`Lỗi bắt đầu: ${e.message || e}`, 'error');
    _upscaling = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">sparkles</span> Bắt đầu Upscale'; }
  }
}

// ── WS Handlers ──
function onProgress(d) {
  const fill = document.getElementById('upscale-fill');
  const pct = document.getElementById('upscale-percent');
  const msg = document.getElementById('upscale-msg');
  if (fill) fill.style.width = `${d.percent}%`;
  if (pct) pct.textContent = `${Math.round(d.percent)}%`;
  if (msg) msg.textContent = d.message;
}

function onCompleted(d) {
  const resultsArea = document.getElementById('upscale-results');
  if (!resultsArea) return;
  const name = d.output_path.split(/[/\\]/).pop();
  
  // Resolve absolute path to /files/ URL
  let fileUrl = `/files/video/${name}`;
  const parts = d.output_path.replace(/\\/g, '/').split('/outputs/');
  if (parts.length > 1) {
    fileUrl = '/files/' + parts[1];
  }

  const card = el('div', { className: 'card result-card slide-in', style: { borderLeft: '4px solid var(--green)', marginTop: '12px', padding: '14px 18px' } },
    icon('check_circle', 20, { style: { color: 'var(--green)' } }),
    el('div', { className: 'result-info', style: { flex: 1, overflow: 'hidden' } },
      el('strong', { style: { fontSize: '13px', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
      el('span', { className: 'field-help', style: { color: 'var(--green)' } }, 'Hoàn tất')
    ),
    el('a', {
      href: fileUrl,
      download: name,
      className: 'btn btn-sm btn-primary',
      title: 'Tải về'
    }, icon('download', 14), 'Tải')
  );
  if (resultsArea.firstChild) {
    resultsArea.insertBefore(card, resultsArea.firstChild);
  } else {
    resultsArea.append(card);
  }
}

function onError(d) {
  toast(`Upscale thất bại: ${d.error}`, 'error');
}

function onBatchDone(d) {
  _upscaling = false;
  const btn = document.getElementById('upscale-start-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">sparkles</span> Bắt đầu Upscale'; }
  const msg = document.getElementById('upscale-msg');
  if (msg) msg.textContent = `Hoàn tất ${d.results?.length || 0}/${d.total} video!`;
  toast(`Upscale xong ${d.results?.length || 0} video.`, 'success');
  loadGallery();
}

// ── Styles (Seamless Integration with RedOne Design System) ──
function _addStyles() {
  if (document.getElementById('upscale-styles-v3')) return;
  const style = document.createElement('style');
  style.id = 'upscale-styles-v3';
  style.textContent = `
    .upscale-layout {
      display: grid;
      grid-template-columns: 1fr 360px;
      gap: 22px;
      align-items: start;
      margin-top: 10px;
    }
    @media (max-width: 900px) {
      .upscale-layout { grid-template-columns: 1fr; }
    }

    .media-col {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .gallery-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
    }

    .media-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      gap: 14px;
      max-height: 480px;
      overflow-y: auto;
      padding-right: 6px;
    }

    .media-card {
      position: relative;
      border-radius: var(--r-md);
      overflow: hidden;
      background: var(--bg-1);
      border: 1px solid var(--border);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .media-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--sh-md);
      border-color: var(--border-strong);
    }
    .media-card.selected {
      border-color: var(--brand);
      box-shadow: 0 0 0 2px var(--brand-soft);
    }

    .media-thumb {
      height: 94px;
      background: #000;
      overflow: hidden;
    }
    .media-thumb video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0.85;
    }

    .media-info {
      padding: 10px;
    }
    .media-name {
      font-size: 12.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
      color: var(--text);
    }

    .check-circle {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--brand);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transform: scale(0.8);
      transition: all 0.15s ease;
    }
    .media-card.selected .check-circle {
      opacity: 1;
      transform: scale(1);
    }

    .settings-col {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .range-marks {
      display: flex;
      justify-content: space-between;
      margin-top: 4px;
    }

    .selected-list {
      max-height: 220px;
      overflow-y: auto;
    }

    .queue-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      background: var(--bg-2);
      border-radius: var(--r-md);
      margin-bottom: 6px;
      border: 1px solid var(--border-soft);
    }
    .queue-name {
      flex: 1;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .upload-bar {
      height: 4px;
      background: var(--border-strong);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 6px;
    }
    .upload-fill {
      height: 100%;
      background: var(--brand);
      width: 0%;
      transition: width 0.2s ease;
    }

    .progress-bar {
      height: 5px;
      background: var(--border-strong);
      border-radius: 3px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--brand);
      transition: width 0.2s ease;
    }

    .result-card {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
    }

    .spin {
      animation: spin 1.2s linear infinite;
      display: inline-block;
    }
    @keyframes spin {
      100% { transform: rotate(360deg); }
    }

    .slide-in {
      animation: slideIn 0.2s ease-out;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.append(style);
}
