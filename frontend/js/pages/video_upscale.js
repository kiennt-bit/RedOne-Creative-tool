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
import { el, icon, toast } from '/js/ui.js';
import { ws } from '/js/ws.js';

let _root = null;
let _upscaling = false;
let _selectedPaths = []; // Array of { path, name }

export async function renderVideoUpscale(root) {
  _root = root;
  root.innerHTML = '';

  // 1. Header
  const header = el('div', { className: 'upscale-header-premium' },
    el('div', { className: 'header-icon' }, icon('auto_awesome_motion', 32)),
    el('div', { className: 'header-text' },
      el('h2', {}, 'Video Upscale AI'),
      el('p', {}, 'Nâng cấp chất lượng video với Real-ESRGAN (GPU-accelerated)')
    )
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
      <div class="status-warning glass-card">
        <span class="material-symbols-outlined">warning</span>
        <div>
          <strong>Chưa sẵn sàng</strong>
          <p>realesrgan-ncnn-vulkan chưa được cài đặt. Vui lòng cài đặt từ Kho tính năng.</p>
        </div>
      </div>`;
    root.append(header, statusEl);
    return;
  }

  // 2. Layout Container
  const layout = el('div', { className: 'upscale-layout' });

  // ── LEFT COLUMN (Media & Gallery) ──
  const mediaCol = el('div', { className: 'upscale-col media-col' });
  
  // Dropzone
  const fileInput = el('input', { type: 'file', accept: 'video/*', multiple: true, style: 'display:none' });
  const dropZone = el('div', { className: 'glass-card upload-card', id: 'upscale-dropzone' },
    el('div', { className: 'upload-icon-wrapper' }, icon('cloud_upload', 36)),
    el('h3', {}, 'Kéo thả hoặc Click để Upload'),
    el('p', { className: 'text-muted' }, 'Hỗ trợ MP4, MOV, AVI, MKV (Tối đa 1GB)'),
    fileInput
  );
  
  const uploadProgress = el('div', { className: 'upload-progress', style: 'display:none' },
    el('div', { className: 'upload-bar' }, el('div', { className: 'upload-fill', id: 'upload-fill' })),
    el('span', { id: 'upload-text' }, 'Đang tải lên...')
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

  // Gallery
  const galleryHeader = el('div', { className: 'gallery-header' },
    el('h3', {}, 'Video đã có'),
    el('button', { className: 'btn-icon', title: 'Làm mới', onclick: () => loadGallery() }, icon('refresh', 20))
  );
  const galleryGrid = el('div', { className: 'media-gallery', id: 'media-gallery' }, 
    el('div', { className: 'loading-spinner' }, 'Đang tải...')
  );
  
  mediaCol.append(dropZone, galleryHeader, galleryGrid);

  // ── RIGHT COLUMN (Settings & Action) ──
  const settingsCol = el('div', { className: 'upscale-col settings-col' });

  // Settings Card
  const settingsCard = el('div', { className: 'glass-card settings-card' },
    el('h3', {}, 'Cài đặt'),
    el('div', { className: 'form-group' },
      el('label', {}, 'Tỷ lệ phóng'),
      el('div', { className: 'scale-options' },
        createRadioCard('scale', '2', '2x', 'Khuyên dùng', true),
        createRadioCard('scale', '3', '3x', 'Chất lượng cao', false),
        createRadioCard('scale', '4', '4x', 'Tối đa (Chậm)', false)
      )
    ),
    el('div', { className: 'form-group mt-4' },
      el('label', {}, 'Khử nhiễu (Denoise): ', el('span', { id: 'denoise-label', className: 'badge' }, '0.5')),
      el('input', { type: 'range', id: 'upscale-denoise', min: '0', max: '1', step: '0.1', value: '0.5' }),
      el('div', { className: 'range-marks text-muted' }, el('span', {}, '0.0'), el('span', {}, '1.0'))
    )
  );

  settingsCard.querySelector('#upscale-denoise').addEventListener('input', (e) => {
    document.getElementById('denoise-label').textContent = e.target.value;
  });

  // Queue Card
  const queueCard = el('div', { className: 'glass-card queue-card' },
    el('div', { className: 'queue-header' },
      el('h3', {}, 'Danh sách chờ (', el('span', { id: 'queue-count' }, '0'), ')')
    ),
    el('div', { className: 'selected-list', id: 'upscale-selected' },
      el('div', { className: 'empty-state text-muted' }, 'Chưa chọn video nào. Chọn từ thư viện bên trái.')
    ),
    el('button', { className: 'btn btn-primary btn-block upscale-start', id: 'upscale-start-btn', disabled: true, onclick: startUpscale },
      icon('rocket_launch', 20), ' Bắt đầu Upscale'
    )
  );

  const progressArea = el('div', { className: 'progress-area', id: 'upscale-progress', style: 'display:none' });
  const resultsArea = el('div', { className: 'results-area', id: 'upscale-results' });

  settingsCol.append(settingsCard, queueCard, progressArea, resultsArea);
  
  layout.append(mediaCol, settingsCol);
  root.append(header, layout);

  // WS events
  ws.on('video_upscale_progress', onProgress);
  ws.on('video_upscale_completed', onCompleted);
  ws.on('video_upscale_error', onError);
  ws.on('video_upscale_batch_done', onBatchDone);

  _addStyles();
  loadGallery();
  _updateSelectedList(); // init state
}

function createRadioCard(name, value, title, desc, checked) {
  const label = el('label', { className: 'radio-card' });
  const input = el('input', { type: 'radio', name, value });
  if (checked) input.checked = true;
  const content = el('div', { className: 'card-content' },
    el('h4', {}, title),
    el('small', {}, desc)
  );
  label.append(input, content);
  return label;
}

// ── Upload Logic ──
async function handleUploads(files) {
  const fill = document.getElementById('upload-fill');
  const text = document.getElementById('upload-text');
  const progress = document.querySelector('.upload-progress');
  
  progress.style.display = 'block';
  fill.style.width = '0%';
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    text.textContent = `Đang tải lên: ${file.name} (${i+1}/${files.length})`;
    const fd = new FormData();
    fd.append('file', file);
    
    try {
      // simulate progress
      fill.style.width = \`\${((i) / files.length) * 100 + 10}%\`;
      const res = await api.postForm('/api/video-editor/upload', fd);
      toast('success', \`Đã tải lên: \${file.name}\`);
      // Auto-add to selected list
      addVideoToQueue({ path: res.path, name: file.name });
    } catch (e) {
      toast('error', \`Lỗi tải lên \${file.name}: \${e.message}\`);
    }
    fill.style.width = \`\${((i+1) / files.length) * 100}%\`;
  }
  
  setTimeout(() => { progress.style.display = 'none'; }, 1000);
  loadGallery(); // Refresh gallery
}

// ── Gallery Logic ──
async function loadGallery() {
  const gallery = document.getElementById('media-gallery');
  if (!gallery) return;
  gallery.innerHTML = '<div class="loading-spinner">Đang tải...</div>';
  
  try {
    const items = await api.get('/api/video-editor/my-media?type=video');
    gallery.innerHTML = '';
    
    if (items.length === 0) {
      gallery.innerHTML = '<div class="empty-state text-muted">Chưa có video nào trong hệ thống.</div>';
      return;
    }

    items.forEach(item => {
      const isSelected = _selectedPaths.some(p => p.path === item.path);
      const card = el('div', { 
        className: \`media-card \${isSelected ? 'selected' : ''}\`,
        onclick: () => toggleVideoSelection(item, card)
      });
      
      const thumb = el('div', { className: 'media-thumb' });
      // Try to load video first frame or fallback to icon
      const vid = el('video', { src: item.url, muted: true, preload: 'metadata' });
      thumb.append(vid);
      
      const info = el('div', { className: 'media-info' },
        el('div', { className: 'media-name', title: item.name }, item.name),
        el('div', { className: 'media-meta text-muted' }, formatBytes(item.size))
      );
      
      const check = el('div', { className: 'check-circle' }, icon('check', 16));
      card.append(thumb, info, check);
      gallery.append(card);
    });
  } catch (e) {
    gallery.innerHTML = \`<div class="empty-state text-danger">Lỗi tải danh sách video: \${e.message}</div>\`;
  }
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

// Exported for external call (e.g. from gallery toolbar)
export function upscaleVideos(videoPaths) {
  videoPaths.forEach(p => {
    const name = p.split(/[/\\]/).pop();
    addVideoToQueue({ path: p, name });
  });
  // Auto switch to this tab should be handled by caller
}

function _updateSelectedList() {
  const listEl = document.getElementById('upscale-selected');
  const countEl = document.getElementById('queue-count');
  const btn = document.getElementById('upscale-start-btn');
  if (!listEl) return;

  countEl.textContent = _selectedPaths.length;

  if (_selectedPaths.length === 0) {
    listEl.innerHTML = '<div class="empty-state text-muted">Chưa chọn video nào. Nhấp vào video bên trái để thêm.</div>';
    if (btn) btn.disabled = true;
    return;
  }

  listEl.innerHTML = '';
  for (const item of _selectedPaths) {
    const li = el('div', { className: 'queue-item' },
      icon('movie', 18),
      el('span', { className: 'queue-name', title: item.name }, item.name),
      el('button', {
        className: 'btn-icon remove-btn',
        onclick: (e) => {
          e.stopPropagation();
          _selectedPaths = _selectedPaths.filter(x => x.path !== item.path);
          _updateSelectedList();
          // Update gallery visual state if rendered
          loadGallery(); 
        },
      }, icon('close', 16))
    );
    listEl.append(li);
  }
  if (btn) btn.disabled = false;
}

// ── Upscale Execution ──
async function startUpscale() {
  if (_upscaling || _selectedPaths.length === 0) return;
  _upscaling = true;

  const scaleInput = document.querySelector('input[name="scale"]:checked');
  const scale = parseInt(scaleInput ? scaleInput.value : '2');
  const denoise = parseFloat(document.getElementById('upscale-denoise')?.value || '0.5');
  
  const btn = document.getElementById('upscale-start-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined spin">sync</span> Đang xử lý...'; }

  const progressArea = document.getElementById('upscale-progress');
  if (progressArea) {
    progressArea.style.display = 'block';
    progressArea.innerHTML = `
      <div class="glass-card active-task-card">
        <div class="task-info">
          <span class="material-symbols-outlined spin text-primary">hourglass_empty</span>
          <div style="flex: 1">
            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
              <strong>Tiến trình Upscale</strong>
              <span id="upscale-percent">0%</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" id="upscale-fill" style="width:0%"></div></div>
            <p id="upscale-msg" class="text-muted mt-2">Đang khởi tạo AI model...</p>
          </div>
        </div>
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
    toast('error', \`Lỗi bắt đầu: \${e.message || e}\`);
    _upscaling = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">rocket_launch</span> Bắt đầu Upscale'; }
  }
}

// ── WS Handlers ──
function onProgress(d) {
  const fill = document.getElementById('upscale-fill');
  const pct = document.getElementById('upscale-percent');
  const msg = document.getElementById('upscale-msg');
  if (fill) fill.style.width = \`\${d.percent}%\`;
  if (pct) pct.textContent = \`\${Math.round(d.percent)}%\`;
  if (msg) msg.textContent = d.message;
}

function onCompleted(d) {
  const resultsArea = document.getElementById('upscale-results');
  if (!resultsArea) return;
  const name = d.output_path.split(/[/\\]/).pop();
  
  const card = el('div', { className: 'glass-card result-card slide-in' },
    el('div', { className: 'result-thumb' }, icon('play_circle', 24)),
    el('div', { className: 'result-info' },
      el('strong', {}, name),
      el('span', { className: 'text-success' }, icon('check_circle', 14), ' Hoàn tất')
    ),
    el('a', {
      href: \`/outputs/video/\${name}\`,
      download: name,
      className: 'btn btn-outline',
      title: 'Tải về'
    }, icon('download', 18))
  );
  // Prepend to show latest first
  if (resultsArea.firstChild) {
    resultsArea.insertBefore(card, resultsArea.firstChild);
  } else {
    resultsArea.append(card);
  }
}

function onError(d) {
  toast('error', \`Upscale thất bại: \${d.error}\`);
}

function onBatchDone(d) {
  _upscaling = false;
  const btn = document.getElementById('upscale-start-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">rocket_launch</span> Bắt đầu Upscale'; }
  const msg = document.getElementById('upscale-msg');
  const iconEl = document.querySelector('.active-task-card .material-symbols-outlined');
  
  if (msg) msg.textContent = \`Hoàn tất \${d.results?.length || 0}/\${d.total} video!\`;
  if (iconEl) {
    iconEl.textContent = 'check_circle';
    iconEl.classList.remove('spin', 'text-primary');
    iconEl.classList.add('text-success');
  }
  
  toast('success', \`Upscale xong \${d.results?.length || 0} video.\`);
  loadGallery(); // refresh gallery to show new files
}

// ── Styles (Premium UI/UX) ──
function _addStyles() {
  if (document.getElementById('upscale-styles-v2')) return;
  const style = document.createElement('style');
  style.id = 'upscale-styles-v2';
  style.textContent = \`
    /* Premium Layout & Glassmorphism */
    .upscale-header-premium {
      display: flex; align-items: center; gap: 16px; margin-bottom: 24px;
      padding: 0 8px;
    }
    .header-icon {
      width: 56px; height: 56px; border-radius: 16px;
      background: linear-gradient(135deg, var(--brand), var(--accent-orange));
      color: white; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 8px 16px rgba(220,38,38,0.2);
    }
    .header-text h2 { margin: 0 0 4px; font-weight: 700; letter-spacing: -0.5px; }
    .header-text p { margin: 0; color: var(--text-muted); font-size: 15px; }

    .upscale-layout {
      display: grid; grid-template-columns: 1fr 340px; gap: 24px;
      align-items: start;
    }
    @media (max-width: 900px) {
      .upscale-layout { grid-template-columns: 1fr; }
    }

    .glass-card {
      background: var(--surface);
      border: 1px solid var(--border-soft);
      border-radius: 16px; padding: 20px;
      box-shadow: var(--sh-sm);
      transition: box-shadow 0.2s, transform 0.2s;
    }
    
    /* Left Column: Media */
    .upload-card {
      border: 2px dashed var(--border-strong);
      background: var(--surface-alt);
      text-align: center; cursor: pointer;
      position: relative; overflow: hidden;
      margin-bottom: 24px;
    }
    .upload-card:hover, .upload-card.dragover {
      border-color: var(--brand);
      background: var(--brand-tint);
    }
    .upload-icon-wrapper {
      width: 64px; height: 64px; border-radius: 50%;
      background: var(--bg-0); display: flex; align-items: center; justify-content: center;
      margin: 0 auto 12px; color: var(--brand);
    }
    .upload-card h3 { margin: 0 0 8px; font-size: 16px; }
    .upload-card p { margin: 0; font-size: 13px; }
    
    .upload-progress { margin-top: 16px; }
    .upload-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-bottom: 8px;}
    .upload-fill { height: 100%; background: var(--brand); width: 0%; transition: width 0.3s ease; }
    #upload-text { font-size: 12px; color: var(--text-muted); font-weight: 500;}

    .gallery-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 16px; padding: 0 4px;
    }
    .gallery-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
    
    .media-gallery {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 16px; max-height: 500px; overflow-y: auto; padding-right: 4px;
    }
    .media-card {
      position: relative; border-radius: 12px; overflow: hidden;
      background: var(--surface); border: 1px solid var(--border);
      cursor: pointer; transition: all 0.2s;
    }
    .media-card:hover { transform: translateY(-2px); box-shadow: var(--sh-md); border-color: var(--border-strong); }
    .media-card.selected { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
    .media-thumb { height: 100px; background: #000; position: relative; }
    .media-thumb video { width: 100%; height: 100%; object-fit: cover; opacity: 0.8; }
    .media-info { padding: 12px; }
    .media-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px;}
    .media-meta { font-size: 11px; }
    
    .check-circle {
      position: absolute; top: 8px; right: 8px;
      width: 24px; height: 24px; border-radius: 50%;
      background: var(--brand); color: white;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transform: scale(0.8); transition: all 0.2s;
    }
    .media-card.selected .check-circle { opacity: 1; transform: scale(1); }

    /* Right Column: Settings & Queue */
    .settings-col { display: flex; flex-direction: column; gap: 16px; }
    .settings-card h3, .queue-card h3 { margin: 0 0 16px; font-size: 15px; }
    
    .scale-options { display: grid; grid-template-columns: 1fr; gap: 8px; }
    .radio-card {
      position: relative; display: block; cursor: pointer;
    }
    .radio-card input { position: absolute; opacity: 0; }
    .card-content {
      padding: 12px; border-radius: 10px; border: 1px solid var(--border);
      background: var(--surface-alt); transition: all 0.2s;
      display: flex; align-items: center; justify-content: space-between;
    }
    .radio-card:hover .card-content { border-color: var(--border-strong); }
    .radio-card input:checked + .card-content {
      border-color: var(--brand); background: var(--brand-tint);
      box-shadow: inset 0 0 0 1px var(--brand);
    }
    .card-content h4 { margin: 0; font-size: 14px; color: var(--text); }
    .card-content small { font-size: 12px; color: var(--brand); font-weight: 500; opacity: 0; transition: opacity 0.2s;}
    .radio-card input:checked + .card-content small { opacity: 1; }

    .queue-item {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px; background: var(--surface-alt);
      border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--border);
    }
    .queue-name { flex: 1; font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .remove-btn { color: var(--text-muted); }
    .remove-btn:hover { color: var(--brand); background: var(--brand-soft); }

    .upscale-start { height: 48px; border-radius: 12px; font-size: 15px; margin-top: 16px; }
    
    /* Progress & Results */
    .active-task-card { border-color: var(--brand); border-width: 2px; }
    .task-info { display: flex; gap: 16px; align-items: flex-start; }
    .progress-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--brand), var(--accent-orange)); transition: width 0.3s; }
    
    .result-card {
      display: flex; align-items: center; gap: 16px; padding: 12px 16px;
      margin-bottom: 12px; border-left: 4px solid #22c55e;
    }
    .result-thumb { color: var(--text-muted); display: flex; }
    .result-info { flex: 1; display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
    .result-info strong { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .result-info span { font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 4px; }
    .text-success { color: #22c55e; }
    
    .slide-in { animation: slideIn 0.3s ease-out; }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .spin { animation: spin 1.5s linear infinite; }
    @keyframes spin { 100% { transform: rotate(360deg); } }
  \`;
  document.head.append(style);
}
