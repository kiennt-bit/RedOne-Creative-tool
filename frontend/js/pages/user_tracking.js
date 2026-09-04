// Firebase usage tracking dashboard (admin page).
// Shows per-user stats: images, videos, scripts, storyboards created + session time.
// Inspired by the G-Labs "Whitelist Management" UI.
import { el, clear, icon, toast, modal } from '../ui.js';
import { api } from '../api.js';

// ── One-time CSS injection ──────────────────────────────────────────
function ensureTrackingCss() {
  if (document.getElementById('tracking-css')) return;
  const s = document.createElement('style');
  s.id = 'tracking-css';
  s.textContent = `
/* Summary cards row */
.trk-summary { display:flex; gap:12px; margin-bottom:18px; flex-wrap:wrap; }
.trk-sum-card {
  flex:1; min-width:140px; padding:16px 18px; border-radius:12px;
  background:var(--bg-2); border:1px solid var(--border);
  display:flex; flex-direction:column; gap:4px;
}
.trk-sum-label { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); font-weight:600; }
.trk-sum-val { font-size:24px; font-weight:700; color:var(--text); }
.trk-sum-val small { font-size:13px; font-weight:500; color:var(--text-muted); }

/* Filters row */
.trk-filters { display:flex; gap:10px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
.trk-filters input { padding:7px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:13px; width:220px; }
.trk-filters select { padding:7px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:13px; }

/* Table */
.trk-tbl { width:100%; border-collapse:collapse; font-size:13px; }
.trk-tbl th { text-align:left; padding:10px 12px; border-bottom:2px solid var(--border); font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); white-space:nowrap; }
.trk-tbl td { padding:10px 12px; border-bottom:1px solid var(--border); vertical-align:middle; }
.trk-tbl tbody tr:hover { background:var(--bg-2); }
.trk-tbl .trk-num { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
.trk-tbl .trk-time { text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted); }

/* User cell */
.trk-user { display:flex; flex-direction:column; gap:2px; }
.trk-uname { font-weight:600; font-size:13px; }
.trk-uemail { font-size:11px; color:var(--text-muted); }

/* Stat badges */
.trk-stat { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:999px; font-size:11px; font-weight:700; }
.trk-stat-video { background:#6366f118; color:#6366f1; }
.trk-stat-image { background:#10b98118; color:#10b981; }
.trk-stat-script { background:#f59e0b18; color:#f59e0b; }
.trk-stat-storyboard { background:#ec489918; color:#ec4899; }

/* Detail modal */
.trk-detail-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:16px; }
.trk-detail-card { padding:12px; border-radius:10px; background:var(--bg-2); border:1px solid var(--border); text-align:center; }
.trk-detail-card .trk-sum-val { font-size:20px; }

/* Daily table (in modal) */
.trk-daily { max-height:300px; overflow-y:auto; }
.trk-daily table { width:100%; border-collapse:collapse; font-size:12px; }
.trk-daily th { padding:6px 8px; text-align:left; border-bottom:2px solid var(--border); font-weight:700; font-size:11px; text-transform:uppercase; color:var(--text-muted); position:sticky; top:0; background:var(--bg-1); }
.trk-daily td { padding:6px 8px; border-bottom:1px solid var(--border); }

/* Responsive */
@media (max-width: 768px) {
  .trk-summary { flex-direction:column; }
  .trk-tbl { font-size:12px; }
  .trk-tbl th, .trk-tbl td { padding:8px 6px; }
}

/* Role management */
.trk-role-section { margin-top:24px; padding-top:20px; border-top:2px solid var(--border); }
.trk-role-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.trk-role-header h3 { font-size:15px; font-weight:700; margin:0; }
.trk-role-form { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:14px; }
.trk-role-form input { padding:7px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:13px; width:220px; }
.trk-role-form select { padding:7px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:13px; }
.trk-role-badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
.trk-role-admin { background:#ef444418; color:#ef4444; }
.trk-role-design { background:#8b5cf618; color:#8b5cf6; }
.trk-role-seo { background:#06b6d418; color:#06b6d4; }
.trk-role-actions { display:flex; gap:6px; }
.trk-role-actions button { padding:4px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:11px; cursor:pointer; }
.trk-role-actions button:hover { background:var(--bg-3); }
.trk-role-actions .trk-del { color:#ef4444; border-color:#ef444444; }
.trk-role-actions .trk-del:hover { background:#ef444418; }
`;
  document.head.appendChild(s);
}

// ── Helpers ──────────────────────────────────────────────────────────
function fmtNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('vi-VN');
}

function fmtDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return '0 phút';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} phút`;
}

function fmtDurationLong(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return '0 phút';
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function fmtDateShort(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  } catch {
    return dateStr;
  }
}

// ── Main render ─────────────────────────────────────────────────────
export function renderUserTracking(root) {
  ensureTrackingCss();

  const wrap = el('div', { class: 'card' }, el('div', { style: { textAlign: 'center', color: 'var(--text-muted)' } },
    el('span', { class: 'spinner' }), ' Đang tải dữ liệu tracking…'));
  root.appendChild(wrap);

  let allData = [];
  let searchTerm = '';

  async function load() {
    try {
      const statusRes = await api.tracking.status();
      if (!statusRes.enabled) {
        clear(wrap);
        wrap.appendChild(el('div', { class: 'empty' },
          el('p', null, '⚠️ Firebase tracking chưa được cấu hình.'),
          el('p', { style: { fontSize: '13px', color: 'var(--text-muted)' } },
            'Set FIREBASE_PROJECT_ID + FIREBASE_TRACKING_ENABLED = True trong private_config.py, ',
            'sau đó enable Firestore API trên GCP Console.')));
        return;
      }
      allData = await api.tracking.stats();
      renderDashboard();
    } catch (e) {
      clear(wrap);
      wrap.appendChild(el('div', { class: 'empty' },
        'Lỗi tải tracking: ' + ((e && e.message) || String(e))));
    }
  }

  function renderDashboard() {
    clear(wrap);
    const filtered = searchTerm
      ? allData.filter(u =>
          (u.email || '').toLowerCase().includes(searchTerm) ||
          (u.display_name || '').toLowerCase().includes(searchTerm))
      : allData;

    // ── Summary cards ──
    const totals = {
      users: allData.length,
      videos: allData.reduce((s, u) => s + (u.total_videos || 0), 0),
      images: allData.reduce((s, u) => s + (u.total_images || 0), 0),
      scripts: allData.reduce((s, u) => s + (u.total_scripts || 0), 0),
      storyboards: allData.reduce((s, u) => s + (u.total_storyboards || 0), 0),
      time: allData.reduce((s, u) => s + (u.total_session_seconds || 0), 0),
    };

    wrap.appendChild(el('div', { class: 'trk-summary' },
      summaryCard('👥', 'Người dùng', fmtNum(totals.users)),
      summaryCard('🎬', 'Video tạo', fmtNum(totals.videos)),
      summaryCard('🖼️', 'Ảnh tạo', fmtNum(totals.images)),
      summaryCard('📝', 'Kịch bản', fmtNum(totals.scripts + totals.storyboards)),
      summaryCard('⏱️', 'Tổng thời gian', fmtDuration(totals.time)),
    ));

    // ── Filters ──
    const searchInput = el('input', {
      placeholder: '🔍 Tìm theo tên hoặc email…',
      value: searchTerm,
      oninput: e => {
        searchTerm = e.target.value.trim().toLowerCase();
        renderDashboard();
      },
    });
    const refreshBtn = el('button', { class: 'btn btn-sm', onclick: load }, '↻ Làm mới');

    wrap.appendChild(el('div', { class: 'trk-filters' },
      searchInput,
      el('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } },
        `${filtered.length} / ${allData.length} người dùng`),
      el('span', { style: { flex: '1' } }),
      refreshBtn,
    ));

    // ── User table ──
    if (!filtered.length) {
      wrap.appendChild(el('div', { class: 'empty' },
        searchTerm ? 'Không tìm thấy người dùng phù hợp.' : 'Chưa có dữ liệu tracking.'));
      return;
    }

    const thead = el('thead', null, el('tr', null,
      el('th', null, 'Người dùng'),
      el('th', { class: 'trk-num' }, 'Video'),
      el('th', { class: 'trk-num' }, 'Ảnh'),
      el('th', { class: 'trk-num' }, 'Kịch bản'),
      el('th', { class: 'trk-num' }, 'Storyboard'),
      el('th', { class: 'trk-time' }, 'Thời lượng dùng'),
      el('th', null, 'Hoạt động cuối'),
    ));

    const tbody = el('tbody', null,
      ...filtered.map(u => {
        const row = el('tr', { style: { cursor: 'pointer' }, onclick: () => showDetail(u) },
          el('td', null, el('div', { class: 'trk-user' },
            el('span', { class: 'trk-uname' }, u.display_name || u.email.split('@')[0]),
            el('span', { class: 'trk-uemail' }, u.email),
          )),
          el('td', { class: 'trk-num' },
            el('span', { class: 'trk-stat trk-stat-video' }, '🎬 ', String(u.total_videos || 0))),
          el('td', { class: 'trk-num' },
            el('span', { class: 'trk-stat trk-stat-image' }, '🖼️ ', String(u.total_images || 0))),
          el('td', { class: 'trk-num' },
            el('span', { class: 'trk-stat trk-stat-script' }, '📝 ', String(u.total_scripts || 0))),
          el('td', { class: 'trk-num' },
            el('span', { class: 'trk-stat trk-stat-storyboard' }, '🎨 ', String(u.total_storyboards || 0))),
          el('td', { class: 'trk-time' }, fmtDurationLong(u.total_session_seconds || 0)),
          el('td', { style: { fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' } },
            fmtDate(u.last_active_at)),
        );
        return row;
      }),
    );

    wrap.appendChild(el('table', { class: 'trk-tbl' }, thead, tbody));

    // ── Role Manager (below tracking table) ──
    renderRoleManager(wrap);
  }

  // ── Detail modal (click on a user row) ──
  async function showDetail(user) {
    const body = el('div', null,
      el('div', { style: { textAlign: 'center', color: 'var(--text-muted)' } },
        el('span', { class: 'spinner' }), ' Đang tải chi tiết…'));
    modal({
      title: `📊 ${user.display_name || user.email}`,
      body,
      actions: [{ label: 'Đóng', class: 'btn-ghost' }],
      width: 640,
    });

    try {
      const daily = await api.tracking.userDaily(user.email, 30);

      clear(body);

      // Aggregate cards
      body.appendChild(el('div', { class: 'trk-detail-grid' },
        detailCard('🎬 Video', user.total_videos || 0),
        detailCard('🖼️ Ảnh', user.total_images || 0),
        detailCard('📝 Kịch bản', user.total_scripts || 0),
        detailCard('🎨 Storyboard', user.total_storyboards || 0),
        detailCard('⏱️ Thời gian', fmtDurationLong(user.total_session_seconds || 0)),
      ));

      // Info row
      body.appendChild(el('div', { style: { display: 'flex', gap: '20px', marginBottom: '14px', fontSize: '12px', color: 'var(--text-muted)' } },
        el('span', null, '📧 ', user.email),
        el('span', null, '📅 Bắt đầu: ', fmtDate(user.first_seen_at)),
        el('span', null, '🕐 Cuối: ', fmtDate(user.last_active_at)),
      ));

      // Daily breakdown table
      if (daily.length) {
        body.appendChild(el('div', { style: { fontWeight: 700, marginBottom: '8px', fontSize: '13px' } },
          '📅 Chi tiết 30 ngày gần nhất'));
        const dailyDiv = el('div', { class: 'trk-daily' },
          el('table', null,
            el('thead', null, el('tr', null,
              el('th', null, 'Ngày'),
              el('th', { style: { textAlign: 'right' } }, 'Video'),
              el('th', { style: { textAlign: 'right' } }, 'Ảnh'),
              el('th', { style: { textAlign: 'right' } }, 'Kịch bản'),
              el('th', { style: { textAlign: 'right' } }, 'Storyboard'),
              el('th', { style: { textAlign: 'right' } }, 'Thời gian'),
            )),
            el('tbody', null, ...daily.map(d => el('tr', null,
              el('td', null, fmtDateShort(d.date)),
              el('td', { style: { textAlign: 'right' } }, String(d.videos || 0)),
              el('td', { style: { textAlign: 'right' } }, String(d.images || 0)),
              el('td', { style: { textAlign: 'right' } }, String(d.scripts || 0)),
              el('td', { style: { textAlign: 'right' } }, String(d.storyboards || 0)),
              el('td', { style: { textAlign: 'right', color: 'var(--text-muted)' } },
                fmtDuration(d.active_seconds || 0)),
            ))),
          ),
        );
        body.appendChild(dailyDiv);
      } else {
        body.appendChild(el('div', { class: 'empty' }, 'Chưa có dữ liệu theo ngày.'));
      }
    } catch (e) {
      clear(body);
      body.appendChild(el('div', { class: 'empty' },
        'Lỗi tải chi tiết: ' + ((e && e.message) || String(e))));
    }
  }

  function summaryCard(emoji, label, value) {
    return el('div', { class: 'trk-sum-card' },
      el('div', { class: 'trk-sum-label' }, `${emoji} ${label}`),
      el('div', { class: 'trk-sum-val' }, value),
    );
  }

  function detailCard(label, value) {
    return el('div', { class: 'trk-detail-card' },
      el('div', { class: 'trk-sum-label' }, label),
      el('div', { class: 'trk-sum-val' }, String(value)),
    );
  }

  // ── Role Manager Section ──────────────────────────────────────────
  function renderRoleManager(container) {
    const section = el('div', { class: 'trk-role-section' });
    container.appendChild(section);

    let roles = [];

    async function loadRoles() {
      try {
        const res = await api.tracking.listRoles();
        roles = res.roles || [];
        renderRoleUI();
      } catch (e) {
        section.innerHTML = '';
        section.appendChild(el('div', { class: 'empty' },
          'Loi tai danh sach role: ' + ((e && e.message) || String(e))));
      }
    }

    function renderRoleUI() {
      section.innerHTML = '';

      // Header
      section.appendChild(el('div', { class: 'trk-role-header' },
        el('h3', null, 'Quan ly nguoi dung & Role'),
      ));

      // Add form
      const emailInput = el('input', { placeholder: 'Email nguoi dung...', type: 'email' });
      const roleSelect = el('select', null,
        el('option', { value: 'design' }, 'Design'),
        el('option', { value: 'seo' }, 'SEO'),
        el('option', { value: 'admin' }, 'Admin'),
      );
      const addBtn = el('button', {
        class: 'btn btn-sm btn-primary',
        onclick: async () => {
          const email = emailInput.value.trim();
          const role = roleSelect.value;
          if (!email || !email.includes('@')) {
            toast('Nhap email hop le', 'warn');
            return;
          }
          try {
            addBtn.disabled = true;
            addBtn.textContent = 'Dang them...';
            await api.tracking.addRole(email, role);
            toast(`Da them ${email} voi role ${role.toUpperCase()}`);
            emailInput.value = '';
            await loadRoles();
          } catch (e) {
            toast('Loi: ' + ((e && e.message) || String(e)), 'err');
          } finally {
            addBtn.disabled = false;
            addBtn.textContent = '+ Them';
          }
        },
      }, '+ Them');

      section.appendChild(el('div', { class: 'trk-role-form' },
        emailInput, roleSelect, addBtn,
      ));

      // Role table
      if (!roles.length) {
        section.appendChild(el('div', { class: 'empty' },
          'Chua co nguoi dung nao. Them email o tren.'));
        return;
      }

      const thead = el('thead', null, el('tr', null,
        el('th', null, 'Email'),
        el('th', null, 'Role'),
        el('th', null, 'Nguoi them'),
        el('th', null, ''),
      ));

      const tbody = el('tbody', null,
        ...roles.map(r => {
          const roleBadge = el('span', {
            class: `trk-role-badge trk-role-${r.role || 'design'}`,
          }, (r.role || 'design').toUpperCase());

          const changeSelect = el('select', {
            style: { fontSize: '11px', padding: '3px 6px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text)' },
            onchange: async (ev) => {
              const newRole = ev.target.value;
              try {
                await api.tracking.updateRole(r.email, newRole);
                toast(`Da doi role ${r.email} thanh ${newRole.toUpperCase()}`);
                await loadRoles();
              } catch (e) {
                toast('Loi: ' + ((e && e.message) || String(e)), 'err');
              }
            },
          },
            el('option', { value: 'design', selected: r.role === 'design' }, 'Design'),
            el('option', { value: 'seo', selected: r.role === 'seo' }, 'SEO'),
            el('option', { value: 'admin', selected: r.role === 'admin' }, 'Admin'),
          );

          const delBtn = el('button', {
            class: 'trk-del',
            title: 'Xoa',
            onclick: async () => {
              if (!confirm(`Xoa ${r.email}?`)) return;
              try {
                await api.tracking.deleteRole(r.email);
                toast(`Da xoa ${r.email}`);
                await loadRoles();
              } catch (e) {
                toast('Loi: ' + ((e && e.message) || String(e)), 'err');
              }
            },
          }, 'Xoa');

          return el('tr', null,
            el('td', null, r.email),
            el('td', null, roleBadge),
            el('td', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, r.added_by || '-'),
            el('td', null, el('div', { class: 'trk-role-actions' }, changeSelect, delBtn)),
          );
        }),
      );

      section.appendChild(el('table', { class: 'trk-tbl' }, thead, tbody));
    }

    loadRoles();
  }

  load();
}
