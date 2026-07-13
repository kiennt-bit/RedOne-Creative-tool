/**
 * Video Upscale — Addon tab module.
 *
 * Renders a page where users can:
 *  - Upload new videos or select from gallery via a Popup Modal
 *  - Choose scale (x2/x3/x4) and denoise strength
 *  - Monitor progress for each batch as separate task blocks
 *  - View/download upscaled results for each clip
 */

import { api } from '/js/api.js';
import { el, icon, toast, makeLazyVideoObserver, modal, openMediaViewer } from '/js/ui.js';
import { ws } from '/js/ws.js';

let _root = null;
let _selectedPaths = []; // Array of { path, name }
let _mediaObserver = null;
let _galleryItems = [];
let _upscaleTasks = []; // Array of { id, timestamp, scale, denoise, percent, stage, message, completed, error, startTime, eta, videos: [...] }
let _activePolls = new Map(); // batchId -> intervalId

function _updateModelHelpText(model) {
  const helpEl = document.getElementById('upscale-model-help');
  if (!helpEl) return;
  
  let desc = '';
  if (model === 'realesrgan-x4plus') {
    desc = '✨ <b>Chất lượng:</b> ⭐⭐⭐⭐⭐ (5/5 - Sắc nét tối đa cho cảnh thực tế, chi tiết phức tạp).<br>' +
           '⚡ <b>Thời gian chờ:</b> Lâu nhất (khoảng 10 - 15 phút / video).<br>' +
           '💻 <b>Cấu hình yêu cầu:</b> Khá nặng. Thích hợp cho máy có GPU rời NVIDIA/AMD mạnh (GTX 1060 trở lên).';
  } else if (model === 'realesr-animevideov3') {
    desc = '✨ <b>Chất lượng:</b> ⭐⭐ (2/5 - Nhanh nhất, tối ưu tốt cho phim hoạt hình/Anime chuyển động nhanh).<br>' +
           '⚡ <b>Thời gian chờ:</b> Nhanh nhất (khoảng 1 - 3 phút / video).<br>' +
           '💻 <b>Cấu hình yêu cầu:</b> Rất nhẹ nhàng. Tương thích tốt với mọi cấu hình GPU (kể cả chip tích hợp hoặc máy văn phòng).';
  } else if (model === 'realesrgan-x4plus-anime') {
    desc = '✨ <b>Chất lượng:</b> ⭐⭐⭐⭐ (4/5 - Rất tốt, tối ưu cho phim hoạt hình/Anime nét cao).<br>' +
           '⚡ <b>Thời gian chờ:</b> Trung bình (khoảng 5 - 10 phút / video).<br>' +
           '💻 <b>Cấu hình yêu cầu:</b> Vừa phải. Hoạt động tốt trên các dòng GPU rời phổ thông (GTX 1050 / GTX 1650 trở lên).';
  } else if (model === 'realesr-general-x4v3') {
    desc = '✨ <b>Chất lượng:</b> ⭐⭐⭐ (3/5 - Trung bình khá, cân bằng tốt giữa tốc độ và độ nét cảnh thực tế).<br>' +
           '⚡ <b>Thời gian chờ:</b> Nhanh (khoảng 2 - 4 phút / video).<br>' +
           '💻 <b>Cấu hình yêu cầu:</b> Nhẹ nhàng. Thích hợp cho nhiều cấu hình máy khác nhau, tối ưu tốt cho ảnh/video thực tế cơ bản.';
  }
  
  helpEl.innerHTML = desc;
}

// Expose helper globally so other pages can send videos to the upscale queue
window.__addVideoToUpscaleQueue = (item) => {
  if (item && item.path) {
    if (!_selectedPaths.some(p => p.path === item.path)) {
      _selectedPaths.push({ path: item.path, name: item.name || item.path.split(/[/\\]/).pop() });
    }
    _updateSelectedList();
  }
};

export async function renderVideoUpscale(root) {
  _root = root;
  root.innerHTML = '';

  // Drain any pending videos sent from other pages
  if (window.__pendingUpscaleVideos && window.__pendingUpscaleVideos.length > 0) {
    window.__pendingUpscaleVideos.forEach(item => {
      if (item && item.path) {
        if (!_selectedPaths.some(p => p.path === item.path)) {
          _selectedPaths.push({ path: item.path, name: item.name || item.path.split(/[/\\]/).pop() });
        }
      }
    });
    window.__pendingUpscaleVideos = []; // Clear
  }

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

  // ── Layout Container ──
  const layout = el('div', { className: 'upscale-layout' });

  // ── LEFT COLUMN (Drag & Drop + Queue) ──
  const mediaCol = el('div', { className: 'upscale-col media-col' });
  
  // Dropzone
  const mainUploadProgress = el('div', { className: 'upload-progress', style: 'display:none; margin-top: 14px; width: 100%;' },
    el('div', { className: 'upload-bar' }, el('div', { className: 'upload-fill', id: 'main-upload-fill' })),
    el('span', { id: 'main-upload-text', className: 'field-help' }, 'Đang tải lên...')
  );

  const dropZone = el('div', {
    className: 'dropzone clickable',
    id: 'upscale-dropzone',
    onclick: (e) => {
      if (e.target.closest('.upload-progress')) return;
      openVideoSelectModal();
    }
  },
    el('div', { className: 'dropzone-icon' }, icon('upload', 28, { style: { color: 'var(--brand)' } })),
    el('div', { style: { fontWeight: '600', fontSize: '15px', marginBottom: '6px', color: 'var(--text)' } }, 'Nhấp để chọn hoặc tải video lên'),
    el('div', { className: 'field-help' }, 'Hỗ trợ tệp tin từ Thư viện RedOne hoặc tải từ Máy tính'),
    mainUploadProgress
  );

  // Drag & Drop event listeners for main page dropzone
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handleMainDropUploads(e.dataTransfer.files);
    }
  });
  
  // Action Queue Card
  const queueCard = el('div', { className: 'card queue-card' },
    el('h3', { className: 'card-title' }, 'Video đã chọn (', el('span', { id: 'queue-count' }, '0'), ')'),
    el('div', { className: 'selected-list', id: 'upscale-selected', style: { marginTop: '12px' } },
      el('div', { className: 'field-help' }, 'Chưa chọn video nào. Nhấp vào vùng phía trên để bắt đầu.')
    )
  );

  mediaCol.append(dropZone, queueCard);

  // ── RIGHT COLUMN (Settings & Controls) ──
  const settingsCol = el('div', { className: 'upscale-col settings-col' });

  // Settings Card
  const settingsCard = el('div', { className: 'card' },
    el('h3', { className: 'card-title' }, 'Cấu hình AI'),
    
    // Model option
    el('div', { className: 'field-group', style: { marginTop: '16px' } },
      el('label', { className: 'field-label' }, 'Model AI Upscale'),
      el('select', {
        className: 'select',
        id: 'upscale-model',
        onchange: (e) => _updateModelHelpText(e.target.value)
      },
        el('option', { value: 'realesr-general-x4v3', selected: true }, 'realesr-general-x4v3'),
        el('option', { value: 'realesrgan-x4plus' }, 'realesrgan-x4plus'),
        el('option', { value: 'realesr-animevideov3' }, 'realesr-animevideov3'),
        el('option', { value: 'realesrgan-x4plus-anime' }, 'realesrgan-x4plus-anime')
      ),
      el('div', {
        id: 'upscale-model-help',
        style: {
          marginTop: '8px',
          lineHeight: '1.45',
          fontSize: '11px',
          padding: '10px',
          borderRadius: '6px',
          background: 'var(--bg-2)',
          border: '1px solid var(--border-soft)',
          color: 'var(--text-muted)'
        }
      })
    ),

    // Scale option
    el('div', { className: 'field-group', style: { marginTop: '16px' } },
      el('label', { className: 'field-label' }, 'Độ phân giải đầu ra'),
      el('select', { className: 'select', id: 'upscale-resolution' },
        el('option', { value: 'FHD', selected: true }, 'FHD'),
        el('option', { value: '2K' }, '2K'),
        el('option', { value: '4K' }, '4K')
      )
    ),

    // Denoise slider
    el('div', { className: 'field-group', style: { marginTop: '16px' } },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' } },
        el('label', { className: 'field-label', style: { margin: 0 } }, 'Khử nhiễu (Denoise)'),
        el('span', { id: 'denoise-val', style: { fontSize: '12px', fontWeight: '600', color: 'var(--brand)' } }, '0.50')
      ),
      el('input', {
        type: 'range',
        className: 'range',
        id: 'upscale-denoise',
        min: '0',
        max: '1',
        step: '0.05',
        value: '0.5',
        oninput: (e) => {
          const val = document.getElementById('denoise-val');
          if (val) val.textContent = parseFloat(e.target.value).toFixed(2);
        }
      }),
      el('div', { className: 'range-marks field-help' },
        el('span', null, 'Giữ chi tiết gốc (0.0)'),
        el('span', null, 'Làm mịn mạnh (1.0)')
      )
    ),

    el('button', {
      className: 'btn btn-primary upscale-start',
      id: 'upscale-start-btn',
      disabled: true,
      style: { width: '100%', marginTop: '16px' },
      onclick: startUpscale
    }, icon('sparkles', 16), ' Bắt đầu Upscale')
  );

  settingsCol.append(settingsCard);
  
  layout.append(mediaCol, settingsCol);

  // ── BOTTOM SECTION (Tasks History) ──
  const historyCard = el('div', { className: 'card tasks-history-card', style: { gridColumn: 'span 2', marginTop: '20px' } },
    el('h3', { className: 'card-title', style: { marginBottom: '16px' } }, 'Hàng đợi'),
    el('div', { id: 'upscale-active-banner', className: 'active-banner', style: { display: 'none', marginBottom: '16px' } }),
    el('div', { id: 'upscale-tasks-container', className: 'tasks-container' },
      el('div', { className: 'field-help', style: { textAlign: 'center', padding: '20px' } }, 'Chưa có tiến trình upscale nào trong phiên làm việc này.')
    )
  );

  root.append(layout, historyCard);

  // Resume active polls if any
  _upscaleTasks.forEach(task => {
    if (!task.completed && !_activePolls.has(task.id)) {
      startPollingProgress(task.id);
    }
  });

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
  _updateSelectedList();
  _renderTasksTable();
  _updateModelHelpText('realesr-general-x4v3');
}

// ── Popup Modal (Double Tab Selector) ──
function openVideoSelectModal() {
  let activeTab = 'local'; // 'local' or 'gallery'
  let tempSelected = [..._selectedPaths];
  let lastClickedIndex = null;

  // DOM elements built dynamically for modal body
  const tabHeader = el('div', { className: 'modal-tabs' });
  const localTabBtn = el('button', { className: 'modal-tab-btn active', onclick: () => switchTab('local') }, 'Tải file từ máy');
  const galleryTabBtn = el('button', { className: 'modal-tab-btn', onclick: () => switchTab('gallery') }, 'Chọn từ Thư viện');
  tabHeader.append(localTabBtn, galleryTabBtn);

  // Local Upload Area
  const fileInput = el('input', { type: 'file', accept: 'video/*', multiple: true, style: 'display:none' });
  const localDropZone = el('div', { className: 'dropzone modal-dropzone', onclick: () => fileInput.click() },
    el('div', { className: 'dropzone-icon' }, icon('upload', 24)),
    el('div', { style: { fontWeight: '600', fontSize: '13.5px', marginBottom: '4px' } }, 'Kéo thả hoặc click để chọn video tải lên'),
    el('div', { className: 'field-help' }, 'Hỗ trợ MP4, MOV, AVI, MKV (Tối đa 1GB)'),
    fileInput
  );
  
  const uploadProgress = el('div', { className: 'upload-progress', style: 'display:none; margin-top: 14px; width: 100%;' },
    el('div', { className: 'upload-bar' }, el('div', { className: 'upload-fill', id: 'modal-upload-fill' })),
    el('span', { id: 'modal-upload-text', className: 'field-help' }, 'Đang tải lên...')
  );
  localDropZone.append(uploadProgress);

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleModalUploads(fileInput.files, (resItem) => {
      tempSelected.push(resItem);
      _updateConfirmBtn();
    });
    fileInput.value = '';
  });

  // Drag & Drop event listeners for modal dropzone
  localDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    localDropZone.classList.add('dragover');
  });
  localDropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    localDropZone.classList.remove('dragover');
  });
  localDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    localDropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      handleModalUploads(e.dataTransfer.files, (resItem) => {
        tempSelected.push(resItem);
        _updateConfirmBtn();
      });
    }
  });

  // Gallery Area (Search & Grid)
  const searchInput = el('input', { 
    class: 'input', 
    placeholder: 'Tìm kiếm video theo tên...', 
    style: { width: '100%', marginBottom: '12px' },
    oninput: (e) => filterModalGallery(e.target.value.trim().toLowerCase())
  });
  
  const galleryGrid = el('div', { className: 'media-gallery', id: 'modal-media-gallery', style: { maxHeight: '350px' } },
    el('div', { className: 'field-help' }, 'Đang tải danh sách video...')
  );

  const localTabContent = el('div', { className: 'tab-content local-content' }, localDropZone);
  const galleryTabContent = el('div', { className: 'tab-content gallery-content', style: { display: 'none' } }, searchInput, galleryGrid);

  const selectedFilesContainer = el('div', {
    id: 'modal-selected-files-container',
    style: {
      marginTop: '16px',
      padding: '12px',
      background: 'var(--bg-2)',
      borderRadius: 'var(--r-md)',
      border: '1px solid var(--border-soft)',
      display: 'none'
    }
  },
    el('div', { style: { fontWeight: '600', fontSize: '12px', marginBottom: '8px', color: 'var(--text-2)' } }, 'Các clip đã chọn:'),
    el('div', { id: 'modal-selected-files-list', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', maxHeight: '80px', overflowY: 'auto' } })
  );

  const modalBody = el('div', { className: 'modal-body-container' },
    tabHeader,
    localTabContent,
    galleryTabContent,
    selectedFilesContainer
  );

  const confirmBtn = el('button', { className: 'btn btn-primary' }, 'Xác nhận chọn (0)');

  const { close } = modal({
    title: 'Chọn nguồn video đầu vào',
    body: modalBody,
    actions: [
      { label: 'Hủy', class: 'btn-ghost', onclick: (c) => c() },
      {
        label: 'Xác nhận chọn (0)',
        class: 'btn-primary modal-confirm-btn',
        onclick: (c) => {
          _selectedPaths = tempSelected;
          _updateSelectedList();
          c();
        }
      }
    ]
  });

  // Keep actions buttons reference to update counts
  function _updateConfirmBtn() {
    const btns = document.querySelectorAll('.modal-confirm-btn');
    btns.forEach(btn => {
      btn.textContent = `Xác nhận chọn (${tempSelected.length} video)`;
    });

    const containerEl = document.getElementById('modal-selected-files-container');
    const listEl = document.getElementById('modal-selected-files-list');
    if (containerEl && listEl) {
      if (tempSelected.length > 0) {
        listEl.innerHTML = '';
        tempSelected.forEach(item => {
          const tag = el('div', {
            className: 'badge',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 8px',
              background: 'var(--bg-1)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)',
              fontSize: '11.5px'
            }
          },
            icon('movie', 12, { style: { color: 'var(--text-muted)' } }),
            el('span', { title: item.name, style: { maxWidth: '120px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, item.name),
            el('button', {
              style: { border: 'none', background: 'none', padding: '0', cursor: 'pointer', display: 'flex', alignItems: 'center' },
              onclick: (e) => {
                e.stopPropagation();
                tempSelected = tempSelected.filter(x => x.path !== item.path);
                _updateConfirmBtn();
                
                // Also need to uncheck card if gallery is active
                const card = document.querySelector(`.media-card[data-path="${item.path}"]`);
                if (card) card.classList.remove('selected');
              }
            }, icon('x', 10))
          );
          listEl.append(tag);
        });
        containerEl.style.display = 'block';
      } else {
        containerEl.style.display = 'none';
      }
    }
  }

  function switchTab(tab) {
    activeTab = tab;
    if (tab === 'local') {
      localTabBtn.classList.add('active');
      galleryTabBtn.classList.remove('active');
      localTabContent.style.display = 'block';
      galleryTabContent.style.display = 'none';
    } else {
      localTabBtn.classList.remove('active');
      galleryTabBtn.classList.add('active');
      localTabContent.style.display = 'none';
      galleryTabContent.style.display = 'block';
      loadModalGallery();
    }
  }

  async function loadModalGallery() {
    galleryGrid.innerHTML = '<div class="field-help">Đang tải danh sách video...</div>';
    try {
      const res = await api.get('/api/video-editor/my-media?type=video');
      _galleryItems = res.media || [];
      filterModalGallery('');
    } catch (e) {
      galleryGrid.innerHTML = `<div class="field-help text-danger" style="color:var(--red)">Lỗi tải danh sách: ${e.message}</div>`;
    }
  }

  function filterModalGallery(q) {
    if (_mediaObserver) {
      _mediaObserver.disconnect();
      _mediaObserver = null;
    }
    
    galleryGrid.innerHTML = '';
    let items = _galleryItems;
    if (q) {
      items = items.filter(item => (item.name || '').toLowerCase().includes(q));
    }
    
    if (items.length === 0) {
      galleryGrid.innerHTML = '<div class="field-help">Không tìm thấy video nào.</div>';
      return;
    }

    items.forEach((item, index) => {
      const isSelected = tempSelected.some(p => p.path === item.path);
      const card = el('div', { 
        className: `media-card ${isSelected ? 'selected' : ''}`,
        'data-path': item.path,
        onclick: (e) => {
          if (e.shiftKey && lastClickedIndex !== null) {
            const start = Math.min(lastClickedIndex, index);
            const end = Math.max(lastClickedIndex, index);
            
            // Check target state (toggle of current item)
            const targetSelect = !tempSelected.some(p => p.path === item.path);
            
            for (let k = start; k <= end; k++) {
              const targetItem = items[k];
              const exists = tempSelected.some(p => p.path === targetItem.path);
              if (targetSelect && !exists) {
                tempSelected.push({ path: targetItem.path, name: targetItem.name });
              } else if (!targetSelect && exists) {
                tempSelected = tempSelected.filter(p => p.path !== targetItem.path);
              }
            }
            
            // Update visual state of all cards in the grid without re-rendering
            const cards = galleryGrid.querySelectorAll('.media-card');
            cards.forEach((c, idx) => {
              const targetItem = items[idx];
              const isSel = tempSelected.some(p => p.path === targetItem.path);
              if (isSel) {
                c.classList.add('selected');
              } else {
                c.classList.remove('selected');
              }
            });
          } else {
            const idx = tempSelected.findIndex(p => p.path === item.path);
            if (idx > -1) {
              tempSelected.splice(idx, 1);
              card.classList.remove('selected');
            } else {
              tempSelected.push({ path: item.path, name: item.name });
              card.classList.add('selected');
            }
            lastClickedIndex = index;
          }
          _updateConfirmBtn();
        }
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
      galleryGrid.append(card);
    });

    _mediaObserver = makeLazyVideoObserver(galleryGrid, { rootMargin: '300px' });
    galleryGrid.querySelectorAll('video[data-src]').forEach((v) => _mediaObserver.observe(v));
  }

  // Set initial confirm label
  setTimeout(_updateConfirmBtn, 50);
}

// ── Upload Handlers inside Modal ──
async function handleModalUploads(files, onUploadedCallback) {
  const progress = document.querySelector('.upload-progress');
  const fill = document.getElementById('modal-upload-fill');
  const text = document.getElementById('modal-upload-text');
  if (!progress || !fill || !text) return;

  progress.style.display = 'block';
  fill.style.width = '0%';
  text.textContent = 'Đang chuẩn bị tải lên...';

  const filesArray = Array.from(files);
  for (let i = 0; i < filesArray.length; i++) {
    const file = filesArray[i];
    const fd = new FormData();
    fd.append('file', file);

    text.textContent = `Đang tải lên: ${file.name} (${i + 1}/${filesArray.length})`;
    try {
      fill.style.width = `${((i) / filesArray.length) * 100 + 10}%`;
      const res = await api.postForm('/api/video-editor/upload', fd);
      toast(`Đã tải lên: ${file.name}`, 'success');
      onUploadedCallback({ path: res.path, name: file.name });
    } catch (e) {
      toast(`Lỗi tải lên ${file.name}: ${e.message}`, 'error');
    }
    fill.style.width = `${((i + 1) / filesArray.length) * 100}%`;
  }
  
  setTimeout(() => { progress.style.display = 'none'; }, 1000);
}

// ── Upload Handlers for Main Page Dropzone ──
async function handleMainDropUploads(files) {
  const progress = document.querySelector('#upscale-dropzone .upload-progress');
  const fill = document.getElementById('main-upload-fill');
  const text = document.getElementById('main-upload-text');
  if (!progress || !fill || !text) return;

  progress.style.display = 'block';
  fill.style.width = '0%';
  text.textContent = 'Đang chuẩn bị tải lên...';

  const filesArray = Array.from(files);
  for (let i = 0; i < filesArray.length; i++) {
    const file = filesArray[i];
    const fd = new FormData();
    fd.append('file', file);

    text.textContent = `Đang tải lên: ${file.name} (${i + 1}/${filesArray.length})`;
    try {
      fill.style.width = `${((i) / filesArray.length) * 100 + 10}%`;
      const res = await api.postForm('/api/video-editor/upload', fd);
      toast(`Đã tải lên: ${file.name}`, 'success');
      _selectedPaths.push({ path: res.path, name: file.name });
      _updateSelectedList();
    } catch (e) {
      toast(`Lỗi tải lên ${file.name}: ${e.message}`, 'error');
    }
    fill.style.width = `${((i + 1) / filesArray.length) * 100}%`;
  }
  
  setTimeout(() => { progress.style.display = 'none'; }, 1000);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ── Update Selected List UI ──
function _updateSelectedList() {
  const listEl = document.getElementById('upscale-selected');
  const countEl = document.getElementById('queue-count');
  const btn = document.getElementById('upscale-start-btn');
  if (!listEl) return;

  countEl.textContent = _selectedPaths.length;

  if (_selectedPaths.length === 0) {
    listEl.innerHTML = '<div class="field-help">Chưa chọn video nào. Nhấp vào vùng phía trên để bắt đầu.</div>';
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
        },
      }, icon('x', 14))
    );
    listEl.append(li);
  }
  if (btn) btn.disabled = false;
}

// ── ETA & Duration Formatting ──
function _calculateETA(startTime, percent) {
  if (percent <= 2) return 'Đang tính toán...';
  const elapsed = (Date.now() - startTime) / 1000; // seconds
  const totalTime = (elapsed / percent) * 100;
  const remaining = totalTime - elapsed;
  
  if (remaining <= 0) return 'Đang xử lý bước cuối...';
  
  const m = Math.floor(remaining / 60);
  const s = Math.floor(remaining % 60);
  return m > 0 ? `${m} phút ${s} giây` : `${s} giây`;
}

// ── Helper to resolve video path to HTTP URL ──
function _getVideoUrl(path) {
  if (!path) return '';
  const cleanPath = path.replace(/\\/g, '/');
  const index = cleanPath.indexOf('/outputs/');
  if (index > -1) {
    return '/files/' + cleanPath.slice(index + 9);
  }
  if (cleanPath.startsWith('/files/')) return cleanPath;
  const name = cleanPath.split('/').pop();
  return `/files/uploads/${name}`;
}

// ── Render Tasks History Table ──
function _renderTasksTable() {
  const container = document.getElementById('upscale-tasks-container');
  if (!container) return;

  const activeTasks = _upscaleTasks.filter(t => !t.completed);
  const runningTask = activeTasks[activeTasks.length - 1]; // oldest uncompleted task is the one running
  const activeBanner = document.getElementById('upscale-active-banner');
  
  if (activeBanner) {
    if (runningTask) {
      const etaVal = _calculateETA(runningTask.startTime, runningTask.percent);
      activeBanner.style.display = 'flex';
      
      const refreshIcon = icon('refresh', 16);
      refreshIcon.classList.add('spin');
      refreshIcon.style.color = 'var(--brand)';
      
      const bannerContent = el('div', { className: 'active-banner-content', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        refreshIcon,
        el('span', null, 'Đang xử lý Lượt tạo lúc ', el('strong', null, runningTask.timestamp), ` (${runningTask.videos.length} video)`),
        el('span', { className: 'divider', style: { color: 'var(--border-strong)' } }, '|'),
        el('span', null, 'Thời gian chờ dự kiến: ', el('strong', { style: { color: 'var(--brand)' } }, etaVal)),
        activeTasks.length > 1 ? el('span', { style: { marginLeft: '12px', color: 'var(--text-muted)' } }, `(Còn ${activeTasks.length - 1} lượt trong hàng đợi)`) : null
      );
      activeBanner.innerHTML = '';
      activeBanner.append(bannerContent);
    } else {
      activeBanner.style.display = 'none';
    }
  }

  if (_upscaleTasks.length === 0) {
    container.innerHTML = '<div class="field-help" style="text-align: center; padding: 30px;">Chưa có tiến trình upscale nào trong phiên làm việc này.</div>';
    return;
  }

  const table = el('table', { className: 'upscale-table' },
    el('thead', null,
      el('tr', null,
        el('th', { style: { width: '45%' } }, 'Tên Clip'),
        el('th', { style: { width: '30%' } }, 'Độ tiến triển'),
        el('th', { style: { width: '20%' } }, 'Trạng thái'),
        el('th', { style: { width: '5%', textAlign: 'center' } }, 'Tải về')
      )
    )
  );

  const tbody = el('tbody');
  _upscaleTasks.forEach(task => {
    // Add a section header row for the batch
    const configText = `Model: ${task.model || 'realesrgan-x4plus'} | ${task.resolution || 'FHD'} | Denoise: ${parseFloat(task.denoise).toFixed(2)}`;

    // Cancel button — only shown when the batch is still running
    const isRunning = !task.completed && !task.error && task.stage !== 'cancelled';
    const cancelBtn = isRunning
      ? el('button', {
          className: 'btn btn-sm btn-ghost',
          title: 'Hủy tiến trình upscale',
          style: { color: 'var(--red)', marginLeft: '8px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '4px' },
          onclick: async (e) => {
            e.stopPropagation();
            const bid = task.id;
            if (!bid || bid.startsWith('prep_')) {
              toast('Đang chờ server phản hồi, thử lại sau', 'warning');
              return;
            }
            try {
              await api.post(`/api/content/upscale-cancel/${bid}`);
              task.completed = true;
              task.stage = 'cancelled';
              task.message = 'Đã hủy bởi người dùng';
              task.eta = 'Đã hủy';
              // Stop polling if active
              if (_activePolls.has(bid)) {
                clearInterval(_activePolls.get(bid));
                _activePolls.delete(bid);
              }
              _renderTasksTable();
              toast('Đã hủy tiến trình upscale', 'info');
            } catch (err) {
              toast(`Hủy lỗi: ${err.message || err}`, 'error');
            }
          }
        }, icon('x', 14), 'Hủy')
      : (task.stage === 'cancelled'
          ? el('span', { style: { color: 'var(--text-muted)', fontSize: '12px', marginLeft: '8px' } }, '⛔ Đã hủy')
          : null);

    const batchHeaderTr = el('tr', { className: 'batch-header-row' },
      el('td', { colspan: '4', style: { padding: '10px 12px', background: 'var(--bg-2)', borderTop: '2px solid var(--border-soft)' } },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          el('span', { style: { fontWeight: '700', color: 'var(--brand)', fontSize: '13px', display: 'flex', alignItems: 'center' } },
            `Lượt tạo lúc ${task.timestamp}`,
            cancelBtn,
          ),
          el('span', { style: { fontSize: '11.5px', color: 'var(--text-muted)', background: 'var(--bg-1)', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border-soft)' } }, configText)
        )
      )
    );
    tbody.append(batchHeaderTr);

    task.videos.forEach(v => {
      let statusText = 'Đang chờ...';
      let statusClass = 'status-waiting';
      let progressPct = v.percent || 0;
      let downloadBtn = null;

      const isWaitingInQueue = runningTask && runningTask.id !== task.id && !task.completed;

      if (v.completed) {
        statusText = 'Hoàn tất ✓';
        statusClass = 'status-done';
        progressPct = 100;

        const nameOnly = v.output ? v.output.split(/[/\\]/).pop() : v.name;
        let fileUrl = _getVideoUrl(v.output || v.path);

        downloadBtn = el('a', {
          href: fileUrl,
          download: nameOnly,
          className: 'btn btn-icon btn-ghost',
          title: 'Tải về',
          style: { padding: '4px' }
        }, icon('download', 16, { style: { color: 'var(--brand)' } }));
      } else if (v.error) {
        statusText = 'Lỗi ✕';
        statusClass = 'status-error';
        progressPct = 100;
      } else if (isWaitingInQueue) {
        statusText = 'Đang xếp hàng';
        statusClass = 'status-waiting';
        progressPct = 0;
      } else if (!task.completed && task.stage === 'upscaling' && v.percent > 0) {
        statusText = 'Đang xử lý';
        statusClass = 'status-running';
        progressPct = v.percent;
      } else if (!task.completed && task.stage === 'starting') {
        statusText = 'Đang xếp hàng';
        statusClass = 'status-waiting';
        progressPct = 0;
      }

      // Previewable video trigger element
      const trigger = el('div', {
        className: 'clip-preview-trigger',
        style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
        onclick: () => {
          const url = _getVideoUrl(v.output || v.path);
          openMediaViewer({ url, type: 'video', label: v.name });
        }
      });
      const eyeIcon = icon('eye', 14);
      eyeIcon.style.color = 'var(--brand)';
      trigger.append(eyeIcon, el('span', { title: 'Click để xem trước video', style: { textDecoration: 'underline', color: 'var(--text)' } }, v.name));

      const tr = el('tr', null,
        el('td', { className: 'td-name' }, trigger),
        el('td', null,
          el('div', { className: 'table-progress-container' },
            el('div', { className: 'table-progress-bar' },
              el('div', { className: 'table-progress-fill', style: { width: `${progressPct}%`, background: v.error ? 'var(--red)' : (v.completed ? 'var(--green)' : 'var(--brand)') } })
            ),
            el('span', { className: 'table-progress-text' }, `${Math.round(progressPct)}%`)
          )
        ),
        el('td', null, el('span', { className: `status-badge ${statusClass}` }, statusText)),
        el('td', { style: { textAlign: 'center' } }, downloadBtn || '-')
      );
      tbody.append(tr);
    });
  });

  table.append(tbody);
  container.innerHTML = '';
  container.append(table);
}

// ── Upscale Execution ──
function startPollingProgress(batchId) {
  if (_activePolls.has(batchId)) clearInterval(_activePolls.get(batchId));
  
  const intervalId = setInterval(async () => {
    try {
      const d = await api.get(`/api/content/upscale-status/${batchId}`);
      if (!d) return;

      const task = _upscaleTasks.find(t => t.id === batchId);
      if (!task) return;

      task.percent = d.percent;
      task.stage = d.stage;
      task.message = d.message;

      // Update individual video progress
      if (d.video_path) {
        const activeIdx = task.videos.findIndex(v => v.path === d.video_path);
        task.videos.forEach((v, idx) => {
          if (idx < activeIdx) {
            v.completed = true;
            v.percent = 100;
          } else if (idx === activeIdx) {
            v.percent = d.percent;
          } else {
            v.percent = 0;
            v.completed = false;
          }
        });
      }

      if (d.results && d.results.length > 0) {
        d.results.forEach(item => {
          const v = task.videos.find(x => x.path === item.input);
          if (v) {
            v.completed = true;
            v.percent = 100;
            v.output = item.output;
          }
        });
      }

      // Handle completion/error
      if (d.completed || d.stage === 'done' || d.stage === 'error') {
        clearInterval(intervalId);
        _activePolls.delete(batchId);
        task.completed = true;
        task.percent = 100;
        task.eta = 'Hoàn tất!';
        
        task.videos.forEach(v => {
          if (!v.error && !v.completed) {
            if (d.stage === 'error') {
              v.error = d.error || 'Lỗi';
            } else {
              v.completed = true;
              v.percent = 100;
            }
          }
        });

        if (d.stage === 'error') {
          task.error = d.error;
          toast(`Lượt upscale #${batchId} thất bại: ${d.error}`, 'error');
        } else {
          toast(`Lượt upscale #${batchId} hoàn tất!`, 'success');
        }
      }

      _renderTasksTable();
    } catch (e) {
      console.warn('Polling error:', e);
    }
  }, 2000);
  
  _activePolls.set(batchId, intervalId);
}

async function startUpscale() {
  if (_selectedPaths.length === 0) return;
  
  if (!ws.isAlive()) {
    toast('Mất kết nối WebSocket. Hệ thống tự động chuyển sang chế độ Polling dự phòng.', 'info');
  }

  const model = document.getElementById('upscale-model')?.value || 'realesrgan-x4plus';
  const resolution = document.getElementById('upscale-resolution').value;
  const denoise = parseFloat(document.getElementById('upscale-denoise')?.value || '0.5');
  const pathsOnly = _selectedPaths.map(p => p.path);
  
  // Set temporary batch ID for UI reactivity before server responds
  const tempBatchId = 'prep_' + Math.random().toString(36).substring(2, 6);

  const newTask = {
    id: tempBatchId,
    timestamp: new Date().toLocaleTimeString(),
    model,
    resolution,
    denoise,
    percent: 0,
    stage: 'starting',
    message: 'Đang gửi yêu cầu...',
    completed: false,
    error: null,
    startTime: Date.now(),
    eta: 'Đang tính toán...',
    videos: _selectedPaths.map(p => ({
      path: p.path,
      name: p.name,
      percent: 0,
      completed: false,
      error: null,
      output: null
    }))
  };

  _upscaleTasks.unshift(newTask);
  
  // Clear selected queue
  _selectedPaths = [];
  _updateSelectedList();
  _renderTasksTable();

  try {
    const res = await api.post('/api/content/upscale-video', {
      video_paths: pathsOnly,
      resolution,
      denoise,
      model,
    });
    
    // Update to actual batch_id
    newTask.id = res.batch_id;
    startPollingProgress(res.batch_id);
    _renderTasksTable();
  } catch (e) {
    toast(`Lỗi bắt đầu: ${e.message || e}`, 'error');
    newTask.completed = true;
    newTask.percent = 100;
    newTask.error = e.message || String(e);
    newTask.message = `Lỗi: ${e.message || e}`;
    newTask.eta = 'Lỗi!';
    _renderTasksTable();
  }
}

// ── WS Handlers ──
function onProgress(d) {
  // If WebSocket is alive, discard active polling fallback for this batch
  if (_activePolls.has(d.batch_id)) {
    clearInterval(_activePolls.get(d.batch_id));
    _activePolls.delete(d.batch_id);
  }

  const task = _upscaleTasks.find(t => t.id === d.batch_id);
  if (task) {
    task.percent = d.percent;
    task.stage = d.stage;
    task.message = d.message;

    // Update active video index client-side to keep subsequent videos at 0%
    if (d.video_path) {
      const activeIdx = task.videos.findIndex(x => x.path === d.video_path);
      task.videos.forEach((v, idx) => {
        if (idx < activeIdx) {
          v.completed = true;
          v.percent = 100;
        } else if (idx === activeIdx) {
          v.percent = d.percent;
          v.stage = d.stage;
        } else {
          v.percent = 0;
          v.completed = false;
        }
      });
    }
    _renderTasksTable();
  }
}

function onCompleted(d) {
  if (_activePolls.has(d.batch_id)) {
    clearInterval(_activePolls.get(d.batch_id));
    _activePolls.delete(d.batch_id);
  }

  const task = _upscaleTasks.find(t => t.id === d.batch_id);
  if (task) {
    const v = task.videos.find(x => x.path === d.video_path);
    if (v) {
      v.completed = true;
      v.percent = 100;
      v.output = d.output_path;
    }
    _renderTasksTable();
  }
}

function onError(d) {
  if (_activePolls.has(d.batch_id)) {
    clearInterval(_activePolls.get(d.batch_id));
    _activePolls.delete(d.batch_id);
  }

  const task = _upscaleTasks.find(t => t.id === d.batch_id);
  if (task) {
    task.completed = true;
    task.error = d.error;
    task.percent = 100;
    task.eta = 'Lỗi!';
    const v = task.videos.find(x => x.path === d.video_path);
    if (v) {
      v.error = d.error;
      v.percent = 100;
    }
    _renderTasksTable();
  }
  toast(`Upscale thất bại: ${d.error}`, 'error');
}

function onBatchDone(d) {
  if (_activePolls.has(d.batch_id)) {
    clearInterval(_activePolls.get(d.batch_id));
    _activePolls.delete(d.batch_id);
  }

  const task = _upscaleTasks.find(t => t.id === d.batch_id);
  if (task) {
    task.completed = true;
    task.percent = 100;

    if (d.cancelled) {
      task.stage = 'cancelled';
      task.message = 'Đã hủy bởi người dùng';
      task.eta = 'Đã hủy';
    } else {
      task.stage = 'done';
      task.message = 'Hoàn tất!';
      task.eta = 'Hoàn tất!';

      task.videos.forEach(v => {
        if (!v.completed && !v.error) {
          v.completed = true;
          v.percent = 100;
        }
      });
    }

    if (d.results) {
      d.results.forEach(item => {
        const v = task.videos.find(x => x.path === item.input);
        if (v) {
          v.completed = true;
          v.percent = 100;
          v.output = item.output;
        }
      });
    }
    _renderTasksTable();
  }
  if (d.cancelled) {
    toast(`Đã hủy upscale lượt #${d.batch_id}`, 'info');
  } else {
    toast(`Upscale xong lượt #${d.batch_id}.`, 'success');
  }
}

// ── Styles (Seamless Integration with RedOne Design System) ──
function _addStyles() {
  if (document.getElementById('upscale-styles-v4')) return;
  const style = document.createElement('style');
  style.id = 'upscale-styles-v4';
  style.textContent = `
    .upscale-layout {
      display: grid;
      grid-template-columns: 1fr 380px;
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

    .modal-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-soft);
      margin-bottom: 20px;
      gap: 12px;
    }
    .modal-tab-btn {
      padding: 10px 16px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      font-size: 13.5px;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .modal-tab-btn:hover {
      color: var(--text);
    }
    .modal-tab-btn.active {
      color: var(--brand);
      border-bottom-color: var(--brand);
    }

    .dropzone {
      background: var(--bg-1);
      border: 2px dashed var(--border-strong);
      border-radius: var(--r-md);
      padding: 36px 20px;
      text-align: center;
      transition: all 0.2s ease;
    }
    .dropzone.clickable {
      cursor: pointer;
    }
    .dropzone.clickable:hover {
      background: var(--bg-2);
      border-color: var(--brand);
    }
    .dropzone.dragover {
      background: var(--bg-2);
      border-color: var(--brand);
    }
    
    .modal-dropzone {
      border-color: var(--border);
      padding: 50px 20px;
    }

    .media-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 12px;
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
      height: 80px;
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
      padding: 8px;
    }
    .media-name {
      font-size: 11.5px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
      color: var(--text);
    }
    .media-meta {
      font-size: 10px;
    }

    .check-circle {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 18px;
      height: 18px;
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
      max-height: 200px;
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
      height: 6px;
      background: var(--border-strong);
      border-radius: 3px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--brand);
      transition: width 0.2s ease;
    }

    /* ── Table Styles ── */
    .upscale-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    .upscale-table th, .upscale-table td {
      padding: 12px;
      border-bottom: 1px solid var(--border-soft);
      text-align: left;
      vertical-align: middle;
    }
    .upscale-table th {
      background: var(--bg-2);
      font-weight: 600;
      color: var(--text-2);
      font-size: 13px;
      border-top: 1px solid var(--border-soft);
    }
    .upscale-table td {
      font-size: 12.5px;
      color: var(--text);
    }
    .td-name {
      display: flex;
      align-items: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .td-name span {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 320px;
      display: inline-block;
    }
    .td-batch {
      font-family: var(--font-mono);
      font-size: 11.5px;
      color: var(--text-muted);
    }
    .table-progress-container {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .table-progress-bar {
      flex: 1;
      height: 6px;
      background: var(--border-strong);
      border-radius: 3px;
      overflow: hidden;
    }
    .table-progress-fill {
      height: 100%;
      transition: width 0.2s ease;
    }
    .table-progress-text {
      font-size: 11px;
      font-weight: 600;
      min-width: 32px;
      text-align: right;
      color: var(--text-2);
    }

    /* ── Status Badges ── */
    .status-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 4px;
      display: inline-block;
      white-space: nowrap;
    }
    .status-waiting {
      color: var(--text-muted);
      background: var(--bg-3);
    }
    .status-running {
      color: var(--brand);
      background: var(--brand-tint);
    }
    .status-done {
      color: var(--green);
      background: var(--green-soft);
    }
    .status-error {
      color: var(--red);
      background: var(--red-soft);
    }

    /* ── Active Banner ── */
    .active-banner {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      background: var(--brand-tint);
      border: 1px solid var(--brand-soft);
      border-radius: var(--r-md);
      font-size: 13px;
      color: var(--text);
    }
    .divider {
      margin: 0 8px;
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
