// Tasks Manager — table of all jobs (running + queued + completed) with
// progress, type, time. Live-updates via WebSocket.
import { el, clear, toast, setLoading, icon, confirm } from '../ui.js';
import { api } from '../api.js';
import { ws } from '../ws.js';

const KIND_LABEL = {
  image: 'Tạo Ảnh',
  content: 'Tạo Video',
  t2v: 'Tạo Video',
  i2v: 'Tạo Video (I2V)',
  long_video: 'Video Dài',
};
const KIND_NAV = {
  image: 'image',
  content: 'content',
  t2v: 'content',
  i2v: 'content',
  long_video: 'long-video',
};
const STATUS_CHIP = {
  PENDING:   { cls: 'chip-yellow', label: 'Đang chờ' },
  RUNNING:   { cls: 'chip-blue',   label: 'Đang chạy' },
  COMPLETED: { cls: 'chip-green',  label: 'Hoàn tất' },
  ERROR:     { cls: 'chip-red',    label: 'Lỗi' },
  CANCELLED: { cls: '',            label: 'Đã hủy' },
  PAUSED:    { cls: 'chip-yellow', label: 'Tạm dừng' },
};

export function renderTasksManager(root) {
  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('refresh', 22)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Quản lý Task'),
      el('p', null, 'Theo dõi tất cả task — chạy tuần tự 1 task / lúc theo thứ tự thời gian'),
    ),
  ));

  // Stat overview
  const stats = el('div', { class: 'stats-grid' });
  root.appendChild(stats);

  // Toolbar
  root.appendChild(el('div', { style: { display: 'flex', gap: '8px', marginBottom: '16px' } },
    el('button', { class: 'btn', id: 'tm-refresh' }, icon('refresh'), 'Làm mới'),
    el('div', { style: { flex: 1 } }),
    el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px' } },
      el('input', { type: 'checkbox', id: 'tm-active-only' }),
      'Chỉ hiện đang hoạt động',
    ),
  ));

  // Table card
  const tableCard = el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Danh sách task'),
      el('div', { class: 'card-subtitle', id: 'tm-count' }, '—'),
    ),
    el('div', { id: 'tm-table-wrap', style: { overflowX: 'auto' } }),
  );
  root.appendChild(tableCard);

  // State
  let allTasks = [];

  async function reload() {
    try {
      const r = await api.tasks.list(200);
      allTasks = r.tasks || [];
      render();
    } catch (e) { toast(e.message, 'error'); }
  }

  function render() {
    const activeOnly = root.querySelector('#tm-active-only')?.checked;
    const tasks = activeOnly
      ? allTasks.filter(t => ['PENDING', 'RUNNING', 'PAUSED'].includes(t.status))
      : allTasks;
    root.querySelector('#tm-count').textContent = `${tasks.length} task`;
    renderStats(allTasks);
    renderTable(tasks);
  }

  function renderStats(tasks) {
    clear(stats);
    const running = tasks.filter(t => t.status === 'RUNNING').length;
    const queued = tasks.filter(t => t.status === 'PENDING' && t.queue_position > 0).length;
    const done = tasks.filter(t => t.status === 'COMPLETED').length;
    const err = tasks.filter(t => t.status === 'ERROR').length;
    [
      { label: 'Đang chạy', value: running, glow: 'blue' },
      { label: 'Đang chờ', value: queued, glow: 'orange' },
      { label: 'Hoàn tất', value: done, glow: 'green' },
      { label: 'Lỗi', value: err, glow: 'purple' },
    ].forEach(s => {
      stats.appendChild(el('div', { class: `stat-card glow-${s.glow}` },
        el('div', { class: 'stat-label' }, s.label),
        el('div', { class: 'stat-value' }, String(s.value)),
      ));
    });
  }

  function renderTable(tasks) {
    const wrap = root.querySelector('#tm-table-wrap');
    clear(wrap);

    if (tasks.length === 0) {
      wrap.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('refresh', 32)),
        el('div', null, 'Chưa có task nào'),
      ));
      return;
    }

    const table = el('table', { class: 'table' });
    table.appendChild(el('thead', null, el('tr', null,
      el('th', null, '#'),
      el('th', null, 'Tên'),
      el('th', null, 'Loại'),
      el('th', null, 'Trạng thái'),
      el('th', null, 'Tiến độ'),
      el('th', null, 'Tạo lúc'),
      el('th', { style: { textAlign: 'right' } }, ''),
    )));
    const tbody = el('tbody');
    tasks.forEach((t) => tbody.appendChild(renderRow(t)));
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function renderRow(t) {
    const kindLabel = KIND_LABEL[t.mode] || t.mode || '—';
    const navTarget = KIND_NAV[t.mode];
    const stat = STATUS_CHIP[t.status] || { cls: '', label: t.status };

    // Position badge for queued
    let posBadge = null;
    if (t.queue_position > 0) {
      posBadge = el('span', { class: 'chip chip-yellow', style: { marginLeft: '6px' } },
        `Hàng đợi #${t.queue_position}`);
    }

    // Progress bar
    const pct = t.progress_percent || 0;
    const progressBar = el('div', { style: { minWidth: '140px' } },
      el('div', { class: 'progress' },
        el('div', { class: 'progress-bar', style: { width: `${pct}%` } }),
      ),
      el('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' } },
        `${t.done_count || 0}/${t.total_count || 0} ${t.error_count ? `· ${t.error_count} lỗi` : ''}`),
    );

    return el('tr', null,
      el('td', { class: 'mono', style: { color: 'var(--text-muted)' } }, `#${t.id}`),
      el('td', null,
        el('div', { style: { fontWeight: 600 } }, t.name || '(không tên)'),
        el('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } },
          `${t.quality || '—'} · ${t.aspect_ratio || '—'}`),
      ),
      el('td', null, kindLabel),
      el('td', null,
        el('span', { class: `chip ${stat.cls}` }, stat.label),
        posBadge,
      ),
      el('td', null, progressBar),
      el('td', { style: { fontSize: '11.5px', color: 'var(--text-muted)' } },
        fmtTime(t.created_at)),
      el('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
        el('button', {
          class: 'btn btn-sm btn-ghost',
          title: 'Mở thư mục chứa file của task',
          onclick: () => openTaskFolder(t.id),
        }, icon('folder', 14)),
        navTarget
          ? el('button', { class: 'btn btn-sm btn-ghost', title: 'Xem trên trang',
              onclick: () => window.__app.navigate(navTarget) },
              icon('eye', 14))
          : null,
        ['ERROR', 'CANCELLED'].includes(t.status)
          ? el('button', { class: 'btn btn-sm btn-primary', title: 'Thử lại task',
              onclick: () => retryTask(t.id) },
              icon('refresh', 14))
          : null,
        ['PENDING', 'RUNNING'].includes(t.status)
          ? el('button', { class: 'btn btn-sm btn-danger', title: 'Hủy',
              onclick: () => cancelTask(t.id) },
              icon('stop', 14))
          : null,
      ),
    );
  }

  function fmtTime(s) {
    if (!s) return '—';
    try {
      const d = new Date(typeof s === 'string' && s.includes(' ') ? s.replace(' ', 'T') + 'Z' : s);
      if (isNaN(d.getTime())) return s;
      const now = new Date();
      const diff = (now - d) / 1000;
      if (diff < 60) return 'vừa xong';
      if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
      if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
      return d.toLocaleString('vi-VN');
    } catch { return String(s); }
  }

  async function cancelTask(id) {
    if (!await confirm('Hủy task này?', 'Xác nhận')) return;
    try {
      await api.tasks.cancel(id);
      toast('Đã hủy', 'info');
      await reload();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function openTaskFolder(id) {
    try {
      const r = await api.tasks.openFolder(id);
      toast(`Đã mở: ${r.path}`, 'success', 5000);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function retryTask(id) {
    try {
      const r = await api.tasks.retry(id);
      toast(`Đã enqueue lại task #${id} (vị trí ${r.queue_position})`, 'success');
      await reload();
    } catch (e) { toast(e.message, 'error'); }
  }

  // Wire toolbar
  root.querySelector('#tm-refresh').addEventListener('click', reload);
  root.querySelector('#tm-active-only').addEventListener('change', render);

  // Live updates via WebSocket
  const offs = [];
  const events = [
    'task_started', 'task_completed', 'task_error', 'task_cancelled',
    'task_progress', 'item_completed', 'item_error', 'queue_updated',
  ];
  for (const ev of events) {
    offs.push(ws.on(ev, () => {
      // Debounce reload calls
      clearTimeout(window._tmReloadTimer);
      window._tmReloadTimer = setTimeout(reload, 250);
    }));
  }

  const obs = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      offs.forEach(o => o());
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Initial load
  reload();
}
