// Firebase usage tracking dashboard (admin page).
// Shows per-user stats: images, videos, scripts, storyboards created + session time.
// Clearly divided by role: Admin, SEO, Design with instant local caching & sync.
import { el, clear, icon, toast, modal, confirm } from '../ui.js';
import { api } from '../api.js';

// ── Role metadata configuration ──────────────────────────────────────
const ROLE_CONFIG = {
  admin: {
    key: 'admin',
    label: 'Admin',
    icon: '👑',
    badgeClass: 'trk-role-admin',
    title: 'Quản trị viên (Admin)',
    desc: 'Toàn quyền cấu hình, phân quyền & theo dõi hệ thống',
  },
  seo: {
    key: 'seo',
    label: 'SEO',
    icon: '🔍',
    badgeClass: 'trk-role-seo',
    title: 'Đội ngũ SEO',
    desc: 'Tạo kịch bản, viết bài & tối ưu nội dung',
  },
  design: {
    key: 'design',
    label: 'Design',
    icon: '🎨',
    badgeClass: 'trk-role-design',
    title: 'Đội ngũ Design',
    desc: 'Sáng tạo hình ảnh, video & storyboard',
  },
};

function getRoleMeta(roleKey) {
  const k = (roleKey || 'design').toLowerCase();
  return ROLE_CONFIG[k] || ROLE_CONFIG.design;
}

function createRoleBadge(roleKey) {
  const meta = getRoleMeta(roleKey);
  return el('span', { class: `trk-role-badge ${meta.badgeClass}` }, `${meta.icon} ${meta.label}`);
}

// ── One-time CSS injection ──────────────────────────────────────────
function ensureTrackingCss() {
  if (document.getElementById('tracking-css')) return;
  const s = document.createElement('style');
  s.id = 'tracking-css';
  s.textContent = `
/* Summary cards row */
.trk-summary { display:flex; gap:12px; margin-bottom:18px; flex-wrap:wrap; }
.trk-sum-card {
  flex:1; min-width:145px; padding:16px 18px; border-radius:12px;
  background:var(--bg-2); border:1px solid var(--border);
  display:flex; flex-direction:column; gap:4px;
}
.trk-sum-label { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); font-weight:600; }
.trk-sum-val { font-size:24px; font-weight:700; color:var(--text); }
.trk-sum-val small { font-size:13px; font-weight:500; color:var(--text-muted); }
.trk-sum-sub { display:flex; gap:6px; margin-top:4px; flex-wrap:wrap; }

/* Filters row */
.trk-filters { display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
.trk-filters input { padding:7px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:13px; width:240px; }

/* Role filter tabs */
.trk-role-tabs { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
.trk-role-tab {
  padding:6px 14px; border-radius:8px; border:1px solid var(--border);
  background:var(--bg-2); color:var(--text-muted); font-size:12px; font-weight:600;
  cursor:pointer; display:inline-flex; align-items:center; gap:6px; transition:all 0.15s ease;
}
.trk-role-tab:hover { background:var(--bg-3); color:var(--text); }
.trk-role-tab.active { background:var(--brand); color:#fff; border-color:var(--brand); }
.trk-role-tab .trk-badge-count {
  background:rgba(255,255,255,0.22); padding:1px 6px; border-radius:999px; font-size:11px; font-weight:700;
}
.trk-role-tab:not(.active) .trk-badge-count {
  background:var(--bg-3); color:var(--text-muted);
}

/* Table */
.trk-tbl { width:100%; border-collapse:collapse; font-size:13px; }
.trk-tbl th { text-align:left; padding:10px 12px; border-bottom:2px solid var(--border); font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); white-space:nowrap; }
.trk-tbl td { padding:10px 12px; border-bottom:1px solid var(--border); vertical-align:middle; }
.trk-tbl tbody tr.trk-user-row:hover { background:var(--bg-2); cursor:pointer; }
.trk-tbl .trk-num { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
.trk-tbl .trk-time { text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted); }

/* Group section header */
.trk-group-hdr td {
  background:var(--bg-3) !important; padding:10px 14px !important; font-weight:700; font-size:12px;
  letter-spacing:0.03em; color:var(--text); border-top:2px solid var(--border);
  border-bottom:1px solid var(--border);
}
.trk-group-hdr:first-child td { border-top:none; }
.trk-group-title { display:flex; align-items:center; justify-content:space-between; }
.trk-group-empty td { text-align:center; color:var(--text-muted); font-size:12px; padding:12px !important; font-style:italic; }

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
.trk-stat-upscale { background:#06b6d418; color:#06b6d4; }

/* Role badge colors */
.trk-role-badge { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:999px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
.trk-role-admin { background:#ef444418; color:#ef4444; border:1px solid #ef444433; }
.trk-role-design { background:#8b5cf618; color:#8b5cf6; border:1px solid #8b5cf633; }
.trk-role-seo { background:#06b6d418; color:#06b6d4; border:1px solid #06b6d433; }

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

/* Role management section */
.trk-role-section { margin-top:28px; padding-top:22px; border-top:2px solid var(--border); }
.trk-role-header { display:flex; flex-direction:column; gap:4px; margin-bottom:14px; }
.trk-role-header h3 { font-size:16px; font-weight:700; margin:0; display:flex; align-items:center; gap:8px; }
.trk-role-header p { font-size:12px; color:var(--text-muted); margin:0; }
.trk-role-form { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
.trk-role-form input { padding:8px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:13px; width:260px; }
.trk-role-form select { padding:8px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg-2); color:var(--text); font-size:13px; }
.trk-role-actions { display:flex; gap:6px; align-items:center; }
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
  let activeRole = 'all'; // 'all' | 'admin' | 'seo' | 'design'

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

  function createUserRow(u) {
    const upscaledTitle = `Topaz Proteus: ${u.total_upscaled_topaz || 0} | NCNN: ${u.total_upscaled_realesrgan || 0}`;
    return el('tr', { class: 'trk-user-row', onclick: () => showDetail(u) },
      el('td', null, el('div', { class: 'trk-user' },
        el('span', { class: 'trk-uname' }, u.display_name || u.email.split('@')[0]),
        el('span', { class: 'trk-uemail' }, u.email),
      )),
      el('td', null, createRoleBadge(u.role)),
      el('td', { class: 'trk-num' },
        el('span', { class: 'trk-stat trk-stat-video' }, '🎬 ', String(u.total_videos || 0))),
      el('td', { class: 'trk-num' },
        el('span', { class: 'trk-stat trk-stat-upscale', title: upscaledTitle }, '⚡ ', String(u.total_upscaled_videos || 0))),
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
  }

  function renderDashboard() {
    clear(wrap);

    // Filter by search
    let filtered = allData;
    if (searchTerm) {
      filtered = filtered.filter(u =>
        (u.email || '').toLowerCase().includes(searchTerm) ||
        (u.display_name || '').toLowerCase().includes(searchTerm));
    }
    // Filter by active role tab (if not 'all')
    if (activeRole !== 'all') {
      filtered = filtered.filter(u => (u.role || 'design') === activeRole);
    }

    // Role counts from allData
    const adminCount = allData.filter(u => u.role === 'admin').length;
    const seoCount = allData.filter(u => u.role === 'seo').length;
    const designCount = allData.filter(u => (u.role || 'design') === 'design').length;

    // ── Summary cards ──
    const totals = {
      users: allData.length,
      videos: allData.reduce((s, u) => s + (u.total_videos || 0), 0),
      upscaled: allData.reduce((s, u) => s + (u.total_upscaled_videos || 0), 0),
      images: allData.reduce((s, u) => s + (u.total_images || 0), 0),
      scripts: allData.reduce((s, u) => s + (u.total_scripts || 0), 0),
      storyboards: allData.reduce((s, u) => s + (u.total_storyboards || 0), 0),
      time: allData.reduce((s, u) => s + (u.total_session_seconds || 0), 0),
    };

    const userCard = el('div', { class: 'trk-sum-card' },
      el('div', { class: 'trk-sum-label' }, '👥 Người dùng'),
      el('div', { class: 'trk-sum-val' }, fmtNum(totals.users)),
      el('div', { class: 'trk-sum-sub' },
        el('span', { class: 'trk-role-badge trk-role-admin', style: { fontSize: '10px', padding: '1px 7px' } }, `👑 ${adminCount}`),
        el('span', { class: 'trk-role-badge trk-role-seo', style: { fontSize: '10px', padding: '1px 7px' } }, `🔍 ${seoCount}`),
        el('span', { class: 'trk-role-badge trk-role-design', style: { fontSize: '10px', padding: '1px 7px' } }, `🎨 ${designCount}`),
      ),
    );

    wrap.appendChild(el('div', { class: 'trk-summary' },
      userCard,
      summaryCard('🎬', 'Video tạo', fmtNum(totals.videos)),
      summaryCard('⚡', 'Upscale Video', fmtNum(totals.upscaled)),
      summaryCard('🖼️', 'Ảnh tạo', fmtNum(totals.images)),
      summaryCard('📝', 'Kịch bản & Storyboard', fmtNum(totals.scripts + totals.storyboards)),
      summaryCard('⏱️', 'Tổng thời gian', fmtDuration(totals.time)),
    ));

    // ── Filters & Search ──
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

    // ── Role Filter Tabs ──
    function roleTabBtn(roleKey, label, count) {
      const isActive = activeRole === roleKey;
      return el('button', {
        class: `trk-role-tab ${isActive ? 'active' : ''}`,
        onclick: () => {
          activeRole = roleKey;
          renderDashboard();
        },
      },
        label,
        el('span', { class: 'trk-badge-count' }, String(count)),
      );
    }

    wrap.appendChild(el('div', { class: 'trk-role-tabs' },
      roleTabBtn('all', '👥 Tất cả', allData.length),
      roleTabBtn('admin', '👑 Admin', adminCount),
      roleTabBtn('seo', '🔍 SEO', seoCount),
      roleTabBtn('design', '🎨 Design', designCount),
    ));

    // ── User table ──
    if (!allData.length) {
      wrap.appendChild(el('div', { class: 'empty' }, 'Chưa có dữ liệu tracking nào.'));
      renderRoleManager(wrap);
      return;
    }

    const thead = el('thead', null, el('tr', null,
      el('th', null, 'Người dùng'),
      el('th', null, 'Vai trò'),
      el('th', { class: 'trk-num' }, 'Video'),
      el('th', { class: 'trk-num' }, 'Upscale'),
      el('th', { class: 'trk-num' }, 'Ảnh'),
      el('th', { class: 'trk-num' }, 'Kịch bản'),
      el('th', { class: 'trk-num' }, 'Storyboard'),
      el('th', { class: 'trk-time' }, 'Thời lượng dùng'),
      el('th', null, 'Hoạt động cuối'),
    ));

    const tbody = el('tbody');

    if (activeRole === 'all') {
      // Clear division into Admin, SEO, and Design sections
      const sections = [
        { key: 'admin', meta: ROLE_CONFIG.admin },
        { key: 'seo', meta: ROLE_CONFIG.seo },
        { key: 'design', meta: ROLE_CONFIG.design },
      ];

      for (const sec of sections) {
        const usersInSec = filtered.filter(u => (u.role || 'design') === sec.key);
        // Section Header Row
        tbody.appendChild(el('tr', { class: 'trk-group-hdr' },
          el('td', { colspan: 9 },
            el('div', { class: 'trk-group-title' },
              el('span', null, `${sec.meta.icon} ${sec.meta.title}`),
              el('span', { class: `trk-role-badge ${sec.meta.badgeClass}`, style: { fontSize: '11px' } },
                `${usersInSec.length} thành viên`),
            ),
          ),
        ));

        if (usersInSec.length === 0) {
          tbody.appendChild(el('tr', { class: 'trk-group-empty' },
            el('td', { colspan: 9 },
              searchTerm
                ? `Không có người dùng ${sec.meta.label} nào khớp với từ khóa tìm kiếm.`
                : `Chưa có người dùng nào được phân quyền ${sec.meta.label}.`),
          ));
        } else {
          for (const u of usersInSec) {
            tbody.appendChild(createUserRow(u));
          }
        }
      }
    } else {
      // Filtered by a single role tab
      const roleMeta = getRoleMeta(activeRole);
      if (filtered.length === 0) {
        tbody.appendChild(el('tr', { class: 'trk-group-empty' },
          el('td', { colspan: 9 },
            searchTerm
              ? `Không tìm thấy người dùng ${roleMeta.label} nào phù hợp.`
              : `Chưa có người dùng nào thuộc nhóm ${roleMeta.label}.`),
        ));
      } else {
        for (const u of filtered) {
          tbody.appendChild(createUserRow(u));
        }
      }
    }

    wrap.appendChild(el('table', { class: 'trk-tbl' }, thead, tbody));

    // ── Role Manager Section (below tracking table) ──
    renderRoleManager(wrap);
  }

  // ── Detail modal (click on a user row) ──
  async function showDetail(user) {
    const roleMeta = getRoleMeta(user.role);
    const body = el('div', null,
      el('div', { style: { textAlign: 'center', color: 'var(--text-muted)' } },
        el('span', { class: 'spinner' }), ' Đang tải chi tiết…'));
    modal({
      title: `📊 ${user.display_name || user.email} [${roleMeta.icon} ${roleMeta.label}]`,
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
        detailCard('⚡ Upscale', user.total_upscaled_videos || 0),
        detailCard('🖼️ Ảnh', user.total_images || 0),
        detailCard('📝 Kịch bản', user.total_scripts || 0),
        detailCard('🎨 Storyboard', user.total_storyboards || 0),
        detailCard('⏱️ Thời gian', fmtDurationLong(user.total_session_seconds || 0)),
      ));

      // Info row
      const infoRow = el('div', { style: { display: 'flex', gap: '20px', marginBottom: '14px', fontSize: '12px', color: 'var(--text-muted)', flexWrap: 'wrap', alignItems: 'center' } },
        el('span', null, '📧 ', user.email),
        el('span', null, '👑 Vai trò: ', createRoleBadge(user.role)),
        el('span', null, '📅 Bắt đầu: ', fmtDate(user.first_seen_at)),
        el('span', null, '🕐 Hoạt động cuối: ', fmtDate(user.last_active_at)),
      );
      if (user.last_upscale && user.last_upscale.at) {
        const upInfo = `${user.last_upscale.model || 'Topaz'} (${user.last_upscale.resolution || 'FHD'}) lúc ${fmtDate(user.last_upscale.at)}` +
          (user.last_upscale.video_name ? ` — ${user.last_upscale.video_name}` : '');
        infoRow.appendChild(el('span', { style: { color: '#06b6d4', fontWeight: 600 } }, '⚡ Upscale cuối: ', upInfo));
      }
      body.appendChild(infoRow);

      // Daily breakdown table
      if (daily.length) {
        body.appendChild(el('div', { style: { fontWeight: 700, marginBottom: '8px', fontSize: '13px' } },
          '📅 Chi tiết 30 ngày gần nhất'));
        const dailyDiv = el('div', { class: 'trk-daily' },
          el('table', null,
            el('thead', null, el('tr', null,
              el('th', null, 'Ngày'),
              el('th', { style: { textAlign: 'right' } }, 'Video'),
              el('th', { style: { textAlign: 'right' } }, 'Upscale'),
              el('th', { style: { textAlign: 'right' } }, 'Ảnh'),
              el('th', { style: { textAlign: 'right' } }, 'Kịch bản'),
              el('th', { style: { textAlign: 'right' } }, 'Storyboard'),
              el('th', { style: { textAlign: 'right' } }, 'Thời gian'),
            )),
            el('tbody', null, ...daily.map(d => el('tr', null,
              el('td', null, fmtDateShort(d.date)),
              el('td', { style: { textAlign: 'right' } }, String(d.videos || 0)),
              el('td', { style: { textAlign: 'right', fontWeight: d.upscaled_videos ? '700' : 'normal', color: d.upscaled_videos ? '#06b6d4' : 'inherit' } },
                d.upscaled_videos ? `⚡ ${d.upscaled_videos}` : '0'),
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
          'Lỗi tải danh sách phân quyền: ' + ((e && e.message) || String(e))));
      }
    }

    function renderRoleUI() {
      section.innerHTML = '';

      // Header
      section.appendChild(el('div', { class: 'trk-role-header' },
        el('h3', null, '👑 Quản lý người dùng & Phân quyền (Role)'),
        el('p', null, 'Chỉ định vai trò Admin, SEO hoặc Design cho từng tài khoản email. Dữ liệu được lưu trữ tức thì và tự động đồng bộ.'),
      ));

      // Add form
      const emailInput = el('input', { placeholder: 'Email người dùng (vd: user@redone.vn)...', type: 'email' });
      const roleSelect = el('select', null,
        el('option', { value: 'design' }, '🎨 Design (Thiết kế)'),
        el('option', { value: 'seo' }, '🔍 SEO (Nội dung / SEO)'),
        el('option', { value: 'admin' }, '👑 Admin (Quản trị viên)'),
      );
      const addBtn = el('button', {
        class: 'btn btn-sm btn-primary',
        onclick: async () => {
          const email = emailInput.value.trim().toLowerCase();
          const role = roleSelect.value;
          if (!email || !email.includes('@')) {
            toast('Vui lòng nhập địa chỉ email hợp lệ', 'warning');
            return;
          }
          try {
            addBtn.disabled = true;
            addBtn.textContent = 'Đang thêm…';
            await api.tracking.addRole(email, role);
            toast(`Đã cấp quyền ${getRoleMeta(role).label} cho ${email}`, 'success');
            emailInput.value = '';
            // Refresh both role manager and main stats table
            await Promise.all([loadRoles(), load()]);
          } catch (e) {
            toast('Lỗi thêm phân quyền: ' + ((e && e.message) || String(e)), 'error');
          } finally {
            addBtn.disabled = false;
            addBtn.textContent = '+ Thêm quyền';
          }
        },
      }, '+ Thêm quyền');

      section.appendChild(el('div', { class: 'trk-role-form' },
        emailInput, roleSelect, addBtn,
      ));

      // Role table
      if (!roles.length) {
        section.appendChild(el('div', { class: 'empty' },
          'Chưa có người dùng nào được phân quyền riêng. Thêm email ở phía trên.'));
        return;
      }

      const thead = el('thead', null, el('tr', null,
        el('th', null, 'Email'),
        el('th', null, 'Vai trò'),
        el('th', null, 'Người thêm'),
        el('th', null, 'Thời gian tạo'),
        el('th', { style: { textAlign: 'right' } }, 'Thao tác'),
      ));

      const tbody = el('tbody', null,
        ...roles.map(r => {
          const roleBadge = createRoleBadge(r.role);

          const changeSelect = el('select', {
            style: { fontSize: '11px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text)' },
            onchange: async (ev) => {
              const newRole = ev.target.value;
              try {
                await api.tracking.updateRole(r.email, newRole);
                toast(`Đã chuyển vai trò ${r.email} sang ${getRoleMeta(newRole).label}`, 'success');
                await Promise.all([loadRoles(), load()]);
              } catch (e) {
                toast('Lỗi đổi vai trò: ' + ((e && e.message) || String(e)), 'error');
              }
            },
          },
            el('option', { value: 'design', selected: r.role === 'design' }, '🎨 Design'),
            el('option', { value: 'seo', selected: r.role === 'seo' }, '🔍 SEO'),
            el('option', { value: 'admin', selected: r.role === 'admin' }, '👑 Admin'),
          );

          const delBtn = el('button', {
            class: 'trk-del',
            title: 'Xóa quyền',
            onclick: async () => {
              const ok = await confirm(`Bạn có chắc chắn muốn xóa phân quyền của tài khoản ${r.email}?`, 'Xác nhận xóa quyền');
              if (!ok) return;
              try {
                await api.tracking.deleteRole(r.email);
                toast(`Đã xóa quyền của ${r.email}`, 'success');
                await Promise.all([loadRoles(), load()]);
              } catch (e) {
                toast('Lỗi xóa quyền: ' + ((e && e.message) || String(e)), 'error');
              }
            },
          }, '🗑️ Xóa');

          return el('tr', null,
            el('td', { style: { fontWeight: 600 } }, r.email),
            el('td', null, roleBadge),
            el('td', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, r.added_by || 'Hệ thống'),
            el('td', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, fmtDate(r.added_at)),
            el('td', { style: { textAlign: 'right' } }, el('div', { class: 'trk-role-actions', style: { justifyContent: 'flex-end' } }, changeSelect, delBtn)),
          );
        }),
      );

      section.appendChild(el('table', { class: 'trk-tbl' }, thead, tbody));
    }

    loadRoles();
  }

  load();
}
