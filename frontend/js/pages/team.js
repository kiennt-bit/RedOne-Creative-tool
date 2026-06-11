// Team monitoring (Hub lead/admin) — members' tasks + credit usage.
import { el, $$, clear, icon } from '../ui.js';
import { api } from '../api.js';

// Self-contained CSS so these pages don't depend on classes that may not
// exist in theme.css. Injected once, shared by team.js + admin.js.
export function ensureHubCss() {
  if (document.getElementById('hub-pages-css')) return;
  const css = `
  .hub-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;}
  .hub-card{padding:0;overflow:hidden;display:flex;flex-direction:column;}
  .hub-thumb{width:100%;aspect-ratio:16/9;background:rgba(127,127,127,.12);display:flex;align-items:center;justify-content:center;color:rgba(127,127,127,.7);}
  .hub-cb{padding:10px 12px;display:flex;flex-direction:column;gap:5px;}
  .hub-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}
  .hub-prompt{font-size:12px;opacity:.75;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
  .hub-muted{opacity:.6;font-size:12px;}
  .hub-in{width:100%;padding:7px 10px;border:1px solid var(--border,rgba(127,127,127,.3));border-radius:8px;background:transparent;color:inherit;font:inherit;}
  .hub-filters{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px;}
  .hub-fld{display:flex;flex-direction:column;gap:4px;min-width:150px;}
  .hub-sec{font-weight:600;margin-bottom:10px;}
  .hub-tbl{width:100%;border-collapse:collapse;}
  .hub-tbl th,.hub-tbl td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border,rgba(127,127,127,.18));font-size:13px;vertical-align:middle;}
  .hub-tbl th{opacity:.6;font-weight:600;font-size:12px;}
  `;
  document.head.appendChild(el('style', { id: 'hub-pages-css', html: css }));
}

function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('vi-VN'); } catch { return iso; }
}
function hubErr(e) {
  if (e && e.status === 503) return 'Hub không kết nối được — kiểm tra server Hub hoặc đăng nhập lại.';
  return 'Lỗi tải dữ liệu: ' + ((e && e.message) || e);
}
function field(label, control) {
  return el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, label), control);
}
function pick(values, labels, def, onchange) {
  return el('select', { class: 'hub-in', onchange: e => onchange(e.target.value) },
    ...values.map(v => el('option', { value: v, selected: v === def }, labels[v] != null ? labels[v] : v)));
}

export function renderTeam(root) {
  ensureHubCss();
  const state = { days: 30, member: '', type: '' };

  const usageBox = el('div', { class: 'card', style: { marginBottom: '16px' } }, 'Đang tải…');
  const tasksBox = el('div', { class: 'hub-grid' });

  const filters = el('div', { class: 'card hub-filters' },
    field('Thành viên (email)', el('input', {
      class: 'hub-in', placeholder: 'tất cả',
      oninput: e => { state.member = e.target.value.trim(); },
    })),
    field('Loại', pick(['', 'image', 'video', 'storyboard', 'shakker', 'upscale'],
      { '': 'Tất cả' }, '', v => { state.type = v; })),
    field('Khoảng', pick(['7', '30', '90', '365'],
      { '7': '7 ngày', '30': '30 ngày', '90': '90 ngày', '365': '1 năm' }, '30',
      v => { state.days = parseInt(v, 10); })),
    el('button', { class: 'btn btn-primary', onclick: load }, icon('refresh', 16), ' Tải lại'),
  );

  root.appendChild(filters);
  root.appendChild(usageBox);
  root.appendChild(el('div', { class: 'hub-sec', style: { margin: '8px 0' } }, 'Task gần đây'));
  root.appendChild(tasksBox);

  async function load() {
    usageBox.textContent = 'Đang tải…';
    clear(tasksBox);
    tasksBox.appendChild(el('div', { class: 'empty' }, 'Đang tải…'));
    try {
      const [usage, tasks] = await Promise.all([
        api.hub.teamUsage(state.days),
        api.hub.teamTasks({ days: state.days, member: state.member, type: state.type, limit: 200 }),
      ]);
      renderUsage(usage);
      renderTasks(tasks);
    } catch (e) {
      clear(usageBox);
      usageBox.appendChild(el('div', { class: 'empty' }, hubErr(e)));
      clear(tasksBox);
    }
  }

  function renderUsage(rows) {
    clear(usageBox);
    usageBox.appendChild(el('div', { class: 'hub-sec' }, 'Tiêu thụ credit theo thành viên'));
    if (!rows || !rows.length) { usageBox.appendChild(el('div', { class: 'empty' }, 'Chưa có dữ liệu.')); return; }
    usageBox.appendChild(el('table', { class: 'hub-tbl' },
      el('thead', null, el('tr', null,
        el('th', null, 'Thành viên'), el('th', null, 'Credit đã dùng'),
        el('th', null, 'Số task'), el('th', null, 'Lỗi'))),
      el('tbody', null, ...rows.map(r => el('tr', null,
        el('td', null,
          el('div', null, r.name || r.email.split('@')[0]),
          el('div', { class: 'hub-muted' }, r.email)),
        el('td', null, String(r.total_credits)),
        el('td', null, String(r.task_count)),
        el('td', null, r.error_count
          ? el('span', { style: { color: 'var(--red,#e5484d)' } }, String(r.error_count))
          : '0'),
      ))),
    ));
  }

  function renderTasks(rows) {
    clear(tasksBox);
    if (!rows || !rows.length) { tasksBox.appendChild(el('div', { class: 'empty' }, 'Không có task trong khoảng này.')); return; }
    for (const t of rows) tasksBox.appendChild(taskCard(t));
  }

  function taskCard(t) {
    const thumb = t.thumb_url
      ? el('div', {
          class: 'hub-thumb',
          style: { backgroundImage: `url("${t.thumb_url}")`, backgroundSize: 'cover', backgroundPosition: 'center', cursor: 'zoom-in' },
          title: 'Mở ảnh trong tab mới',
          onclick: () => window.open(t.thumb_url, '_blank', 'noopener'),
        })
      : el('div', { class: 'hub-thumb' }, icon('image', 22));
    const color = t.status === 'done' ? 'var(--green,#46a758)'
      : (t.status === 'error' ? 'var(--red,#e5484d)' : 'var(--yellow,#ffb224)');
    return el('div', { class: 'card hub-card' },
      thumb,
      el('div', { class: 'hub-cb' },
        el('div', { class: 'hub-row' },
          el('span', { style: { fontWeight: 600, fontSize: '13px' } }, t.name || t.email.split('@')[0]),
          el('span', { style: { color, fontSize: '12px', fontWeight: 600 } }, t.status || ''),
        ),
        el('div', { class: 'hub-muted' }, `${t.type || '—'}${t.model ? ' · ' + t.model : ''} · ${t.credit_cost || 0} credit`),
        t.prompt ? el('div', { class: 'hub-prompt', title: t.prompt }, t.prompt) : null,
        el('div', { class: 'hub-muted', style: { fontSize: '11px' } }, fmtTime(t.created_at)),
      ),
    );
  }

  load();
}
