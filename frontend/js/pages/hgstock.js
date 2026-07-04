// HG Stock upload page — select files, choose project, add tags, upload.
// Permission-gated: only users with hgstock_upload permission can access.
import { el, clear, icon, toast, modal } from '../ui.js';
import { api } from '../api.js';

// ── State ────────────────────────────────────────────────────────────
let selectedFiles = new Set();
let currentProject = '';
let tags = [];
let presets = [];
let allFiles = [];
let hasPermission = false;
let uploadTaskId = null;
let pollTimer = null;

// ── CSS injection ────────────────────────────────────────────────────
function ensureCss() {
  if (document.getElementById('hgs-css')) return;
  const s = document.createElement('style');
  s.id = 'hgs-css';
  s.textContent = `
.hgs-gate { text-align:center; padding:60px 20px; color:var(--text-muted); }
.hgs-gate svg { width:64px; height:64px; margin-bottom:16px; opacity:.3; }
.hgs-steps { display:flex; gap:24px; margin-bottom:24px; }
.hgs-step { flex:1; min-width:0; }
.hgs-step-title { font-weight:700; font-size:14px; margin-bottom:10px; display:flex; align-items:center; gap:8px; }
.hgs-step-num { background:var(--brand); color:#fff; border-radius:50%; width:24px; height:24px; display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
.hgs-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px,1fr)); gap:10px; max-height:340px; overflow-y:auto; padding:4px; }
.hgs-card { border:2px solid var(--border); border-radius:10px; padding:8px; cursor:pointer; transition:all .15s; text-align:center; position:relative; }
.hgs-card:hover { border-color:var(--brand-soft); background:var(--bg-2); }
.hgs-card.selected { border-color:var(--brand); background:var(--brand-soft); }
.hgs-card .hgs-check { position:absolute; top:6px; right:6px; width:20px; height:20px; border-radius:50%; background:var(--brand); color:#fff; display:none; align-items:center; justify-content:center; font-size:12px; }
.hgs-card.selected .hgs-check { display:flex; }
.hgs-card .hgs-thumb { width:100%; height:80px; object-fit:cover; border-radius:6px; background:var(--bg-3); }
.hgs-card .hgs-name { font-size:11px; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hgs-card .hgs-meta { font-size:10px; color:var(--text-muted); }
.hgs-filter { display:flex; gap:8px; margin-bottom:12px; }
.hgs-filter button { padding:4px 14px; border-radius:99px; border:1px solid var(--border); background:var(--bg-2); cursor:pointer; font-size:12px; color:var(--text); }
.hgs-filter button.active { background:var(--brand); color:#fff; border-color:var(--brand); }
.hgs-projects { display:grid; grid-template-columns:repeat(auto-fill, minmax(130px,1fr)); gap:8px; }
.hgs-proj { border:2px solid var(--border); border-radius:10px; padding:10px 12px; cursor:pointer; font-size:13px; font-weight:600; transition:all .15s; display:flex; align-items:center; gap:8px; }
.hgs-proj:hover { border-color:var(--brand-soft); }
.hgs-proj.selected { border-color:var(--brand); background:var(--brand-soft); }
.hgs-proj .hgs-dot { width:12px; height:12px; border-radius:50%; flex-shrink:0; }
.hgs-custom-proj { margin-top:10px; display:flex; gap:8px; }
.hgs-custom-proj input { flex:1; padding:8px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:13px; }
.hgs-tags { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; min-height:36px; }
.hgs-tag { background:var(--brand-soft); color:var(--brand); padding:4px 10px; border-radius:99px; font-size:12px; font-weight:600; display:flex; align-items:center; gap:4px; }
.hgs-tag .hgs-tag-x { cursor:pointer; opacity:.6; font-weight:700; }
.hgs-tag .hgs-tag-x:hover { opacity:1; }
.hgs-tag-input { display:flex; gap:8px; margin-top:10px; }
.hgs-tag-input input { flex:1; padding:8px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:13px; }
.hgs-summary { background:var(--bg-2); border-radius:10px; padding:16px; margin-top:16px; display:flex; justify-content:space-between; align-items:center; }
.hgs-summary-info { font-size:13px; color:var(--text-muted); }
.hgs-summary-info strong { color:var(--text); }
.hgs-btn { padding:10px 28px; border-radius:10px; border:none; background:var(--brand); color:#fff; font-weight:700; font-size:14px; cursor:pointer; transition:all .15s; }
.hgs-btn:hover { filter:brightness(1.1); }
.hgs-btn:disabled { opacity:.5; cursor:not-allowed; }
.hgs-progress { margin-top:16px; }
.hgs-progress-bar { height:8px; background:var(--bg-3); border-radius:99px; overflow:hidden; }
.hgs-progress-fill { height:100%; background:var(--brand); border-radius:99px; transition:width .3s; }
.hgs-progress-text { font-size:12px; color:var(--text-muted); margin-top:4px; }
.hgs-results { margin-top:16px; }
.hgs-result-item { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border); font-size:13px; }
.hgs-result-ok { color:var(--green); }
.hgs-result-err { color:var(--red); }
.hgs-auto-tag { background:var(--bg-3); color:var(--text-muted); font-style:italic; }
  `;
  document.head.appendChild(s);
}

// ── Project colors ───────────────────────────────────────────────────
const PROJECT_COLORS = [
  '#c5e1a5','#b3e5fc','#f8bbd0','#ffe0b2','#d1c4e9','#b2dfdb',
  '#fff9c4','#c8e6c9','#ffccbc','#e1bee7','#cfd8dc','#d7ccc8',
];

// ── Render ───────────────────────────────────────────────────────────
export async function renderHGStock(container) {
  ensureCss();
  clear(container);

  // Check permission
  let status;
  try {
    status = await api.get('/api/hgstock/status');
  } catch {
    status = { configured: false, has_permission: false };
  }

  hasPermission = status.has_permission;

  if (!status.configured) {
    container.appendChild(el('div', { class: 'hgs-gate card' },
      icon('alert-circle', 64),
      el('h3', null, 'HG Stock chưa được cấu hình'),
      el('p', null, 'Liên hệ admin để thiết lập kết nối HG Stock API.')));
    return;
  }

  if (!hasPermission) {
    container.appendChild(el('div', { class: 'hgs-gate card' },
      icon('lock', 64),
      el('h3', null, 'Tính năng bị khóa'),
      el('p', null, 'Upload HG Stock chỉ dành cho thành viên phòng Sáng tạo được admin cấp quyền.'),
      el('p', { style: { fontSize: '12px' } }, 'Liên hệ admin trong tab Quản trị để được mở khóa.')));
    return;
  }

  // Load data
  try {
    const [filesRes, projRes] = await Promise.all([
      api.get('/api/hgstock/output-files'),
      api.get('/api/hgstock/projects'),
    ]);
    allFiles = filesRes.files || [];
    presets = projRes.presets || [];
  } catch (e) {
    toast('Lỗi tải dữ liệu: ' + e.message, 'error');
    return;
  }

  // Reset state
  selectedFiles.clear();
  currentProject = '';
  tags = [];
  uploadTaskId = null;

  // Build UI
  const stepsRow = el('div', { class: 'hgs-steps' });

  // Step 1: Select files
  const step1 = buildStep1();
  // Step 2: Choose project
  const step2 = buildStep2();
  // Step 3: Tags + Upload
  const step3 = buildStep3();

  stepsRow.append(step1, step2);
  container.append(stepsRow, step3);

  // Show nav button
  const navBtn = document.getElementById('nav-hgstock');
  if (navBtn) navBtn.style.display = '';
}

// ── Step 1: File selector ────────────────────────────────────────────
function buildStep1() {
  const wrap = el('div', { class: 'hgs-step card' });
  wrap.appendChild(el('div', { class: 'hgs-step-title' },
    el('span', { class: 'hgs-step-num' }, '1'),
    'Chọn file'));

  // Filter
  const filterBar = el('div', { class: 'hgs-filter' });
  const filters = ['all', 'image', 'video', 'audio'];
  const filterLabels = { all: 'Tất cả', image: 'Ảnh', video: 'Video', audio: 'Audio' };
  let activeFilter = 'all';

  const grid = el('div', { class: 'hgs-grid' });

  function renderGrid() {
    clear(grid);
    const filtered = activeFilter === 'all'
      ? allFiles
      : allFiles.filter(f => f.media_label === activeFilter);

    if (!filtered.length) {
      grid.appendChild(el('div', { style: { gridColumn: '1/-1', textAlign: 'center', padding: '30px', color: 'var(--text-muted)' } },
        'Không có file nào. Tạo ảnh/video trước rồi quay lại.'));
      return;
    }

    for (const f of filtered) {
      const card = el('div', {
        class: `hgs-card ${selectedFiles.has(f.path) ? 'selected' : ''}`,
        onclick: () => {
          if (selectedFiles.has(f.path)) selectedFiles.delete(f.path);
          else selectedFiles.add(f.path);
          card.classList.toggle('selected');
          updateSummary();
        },
      },
        el('div', { class: 'hgs-check' }, '✓'),
        el('div', {
          class: 'hgs-thumb',
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '24px', color: 'var(--text-muted)',
          },
        }, f.media_type === 0 ? '🖼️' : f.media_type === 2 ? '🎬' : '🎵'),
        el('div', { class: 'hgs-name', title: f.name }, f.name),
        el('div', { class: 'hgs-meta' }, `${(f.size / 1024 / 1024).toFixed(1)} MB · ${f.ext}`),
      );
      grid.appendChild(card);
    }
  }

  for (const fk of filters) {
    const btn = el('button', {
      class: fk === activeFilter ? 'active' : '',
      onclick: () => {
        activeFilter = fk;
        filterBar.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderGrid();
      },
    }, filterLabels[fk] + ` (${fk === 'all' ? allFiles.length : allFiles.filter(f => f.media_label === fk).length})`);
    filterBar.appendChild(btn);
  }

  wrap.append(filterBar, grid);
  renderGrid();
  return wrap;
}

// ── Step 2: Project selector ─────────────────────────────────────────
function buildStep2() {
  const wrap = el('div', { class: 'hgs-step card' });
  wrap.appendChild(el('div', { class: 'hgs-step-title' },
    el('span', { class: 'hgs-step-num' }, '2'),
    'Chọn dự án'));

  const projGrid = el('div', { class: 'hgs-projects' });

  for (let i = 0; i < presets.length; i++) {
    const name = presets[i];
    const color = PROJECT_COLORS[i % PROJECT_COLORS.length];
    const item = el('div', {
      class: 'hgs-proj',
      onclick: () => {
        currentProject = name;
        projGrid.querySelectorAll('.hgs-proj').forEach(p => p.classList.remove('selected'));
        item.classList.add('selected');
        customInput.value = '';
        updateSummary();
      },
    },
      el('div', { class: 'hgs-dot', style: { background: color } }),
      name,
    );
    projGrid.appendChild(item);
  }

  const customInput = el('input', {
    type: 'text',
    placeholder: 'Hoặc nhập tên dự án khác...',
    oninput: (e) => {
      currentProject = e.target.value.trim();
      projGrid.querySelectorAll('.hgs-proj').forEach(p => p.classList.remove('selected'));
      updateSummary();
    },
  });

  wrap.append(projGrid, el('div', { class: 'hgs-custom-proj' }, customInput));
  return wrap;
}

// ── Step 3: Tags + Upload ────────────────────────────────────────────
let summaryEl = null;
let progressEl = null;
let resultsEl = null;
let uploadBtn = null;

function buildStep3() {
  const wrap = el('div', { class: 'card' });
  wrap.appendChild(el('div', { class: 'hgs-step-title' },
    el('span', { class: 'hgs-step-num' }, '3'),
    'Gắn tag & Upload'));

  // Tag input
  const tagList = el('div', { class: 'hgs-tags' });
  const tagInput = el('input', {
    type: 'text',
    placeholder: 'Nhập tag rồi Enter (ví dụ: lofi, chill, relax)',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = tagInput.value.trim().replace(/^#/, '');
        if (val && !tags.includes(val)) {
          tags.push(val);
          renderTags();
          updateSummary();
        }
        tagInput.value = '';
      }
    },
  });

  function renderTags() {
    clear(tagList);
    // Auto-tag notice
    if (currentProject) {
      const autoTag = el('span', { class: 'hgs-tag hgs-auto-tag' },
        `#${currentProject}`, ' (tự động)');
      tagList.appendChild(autoTag);
    }
    for (const t of tags) {
      const pill = el('span', { class: 'hgs-tag' },
        `#${t}`,
        el('span', { class: 'hgs-tag-x', onclick: () => {
          tags = tags.filter(x => x !== t);
          renderTags();
          updateSummary();
        } }, '×'));
      tagList.appendChild(pill);
    }
  }

  // Summary bar
  summaryEl = el('div', { class: 'hgs-summary', style: { display: 'none' } });
  uploadBtn = el('button', { class: 'hgs-btn', disabled: true, onclick: doUpload },
    'Upload lên HG Stock');
  progressEl = el('div', { class: 'hgs-progress', style: { display: 'none' } });
  resultsEl = el('div', { class: 'hgs-results', style: { display: 'none' } });

  wrap.append(
    tagList,
    el('div', { class: 'hgs-tag-input' }, tagInput),
    summaryEl, progressEl, resultsEl,
  );

  // Make renderTags available for project change
  window.__hgsRenderTags = renderTags;

  return wrap;
}

function updateSummary() {
  if (!summaryEl) return;
  const n = selectedFiles.size;
  const hasProject = !!currentProject;
  const ready = n > 0 && hasProject;

  // Re-render auto-tag when project changes
  if (window.__hgsRenderTags) window.__hgsRenderTags();

  summaryEl.style.display = ready ? '' : 'none';
  if (ready) {
    clear(summaryEl);
    const allTagsPreview = [currentProject, ...tags].filter(Boolean);
    summaryEl.append(
      el('div', { class: 'hgs-summary-info' },
        el('strong', null, `${n} file`), ` × `,
        el('strong', null, currentProject),
        ` × `,
        el('strong', null, `${allTagsPreview.length} tag(s)`)),
      uploadBtn,
    );
    uploadBtn.disabled = false;
  }
}

// ── Upload action ────────────────────────────────────────────────────
async function doUpload() {
  if (!selectedFiles.size || !currentProject) return;

  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Đang upload...';
  progressEl.style.display = '';
  resultsEl.style.display = 'none';
  clear(progressEl);
  clear(resultsEl);

  // Progress bar
  const bar = el('div', { class: 'hgs-progress-bar' },
    el('div', { class: 'hgs-progress-fill', style: { width: '0%' } }));
  const pText = el('div', { class: 'hgs-progress-text' }, 'Đang chuẩn bị...');
  progressEl.append(bar, pText);

  try {
    const res = await api.post('/api/hgstock/upload', {
      files: Array.from(selectedFiles),
      project: currentProject,
      tags,
      folder_id: '',
    });

    uploadTaskId = res.task_id;
    pText.textContent = `Task ${uploadTaskId}: đang upload ${res.total_files} file(s)...`;

    // Poll progress
    pollTimer = setInterval(async () => {
      try {
        const prog = await api.get(`/api/hgstock/upload-progress/${uploadTaskId}`);
        const pct = prog.total > 0 ? ((prog.completed / prog.total) * 100) : 0;
        bar.firstChild.style.width = `${pct}%`;
        pText.textContent = prog.current_file
          ? `${prog.completed}/${prog.total}: ${prog.current_file} (${prog.current_step})`
          : `${prog.completed}/${prog.total} hoàn tất`;

        if (prog.status === 'done' || prog.status === 'partial') {
          clearInterval(pollTimer);
          pollTimer = null;
          bar.firstChild.style.width = '100%';
          showResults(prog);
          uploadBtn.textContent = 'Upload lên HG Stock';
          uploadBtn.disabled = false;
        }
      } catch { /* ignore poll errors */ }
    }, 1500);

  } catch (e) {
    toast('Upload thất bại: ' + (e.message || e), 'error');
    uploadBtn.textContent = 'Upload lên HG Stock';
    uploadBtn.disabled = false;
    progressEl.style.display = 'none';
  }
}

function showResults(prog) {
  resultsEl.style.display = '';
  clear(resultsEl);

  if (prog.results && prog.results.length) {
    for (const r of prog.results) {
      resultsEl.appendChild(el('div', { class: 'hgs-result-item' },
        el('span', { class: 'hgs-result-ok' }, '✓'),
        el('span', null, r.file),
        r.url ? el('a', { href: r.url, target: '_blank', style: { marginLeft: 'auto', fontSize: '12px' } }, 'Xem trên HG Stock') : '',
      ));
    }
  }

  if (prog.errors && prog.errors.length) {
    for (const e of prog.errors) {
      resultsEl.appendChild(el('div', { class: 'hgs-result-item' },
        el('span', { class: 'hgs-result-err' }, '✗'),
        el('span', null, `${e.file}: ${e.error}`),
      ));
    }
  }

  const statusMsg = prog.status === 'done'
    ? 'Upload hoàn tất!'
    : `Upload hoàn tất với ${prog.errors.length} lỗi.`;
  toast(statusMsg, prog.status === 'done' ? 'success' : 'warning');
}

// ── Show/hide nav button based on permission ─────────────────────────
// Called on app init to check HG Stock permission and show sidebar button.
export async function checkHGStockNav() {
  try {
    const status = await api.get('/api/hgstock/status');
    const navBtn = document.getElementById('nav-hgstock');
    if (navBtn && status.has_permission) {
      navBtn.style.display = '';
    }
  } catch { /* ignore — feature not available */ }
}
