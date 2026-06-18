// Hub admin (admin role only) — users, teams, quotas. All runtime-editable.
import { el, clear, icon, toast, modal } from '../ui.js';
import { api } from '../api.js';
import { ensureHubCss } from './team.js';

const ROLES = ['member', 'lead', 'admin'];

function pickRole(def, onchange) {
  return el('select', { class: 'hub-in', onchange: e => onchange && onchange(e.target.value) },
    ...ROLES.map(r => el('option', { value: r, selected: r === def }, r)));
}
function pickTeam(teams, def, onchange) {
  return el('select', { class: 'hub-in', onchange: e => onchange && onchange(e.target.value) },
    el('option', { value: '', selected: def == null }, '— không nhóm —'),
    ...teams.map(t => el('option', { value: String(t.id), selected: String(t.id) === String(def) }, t.name)));
}
function hubErr(e) {
  if (e && e.status === 503) return 'Hub không kết nối được.';
  return (e && e.message) || String(e);
}
function fmtT(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('vi-VN'); } catch { return iso; }
}
function confirmAct(msg, onYes, okLabel = 'Đồng ý') {
  modal({
    title: 'Xác nhận',
    body: el('p', null, msg),
    actions: [
      { label: 'Huỷ', class: 'btn-ghost' },
      { label: okLabel, class: 'btn-primary', onclick: (close) => { close(); onYes(); } },
    ],
  });
}

// One-time CSS for the grouped user list (collapsible team panels + lead badge
// + inline credit). Injected here so admin.js stays self-contained.
function ensureAdminCss() {
  if (document.getElementById('adm-css')) return;
  const s = document.createElement('style');
  s.id = 'adm-css';
  s.textContent = `
.adm-grp { border:1px solid var(--border); border-radius:10px; margin-bottom:10px; overflow:hidden; }
.adm-grp-hd { display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; background:var(--bg-2); user-select:none; }
.adm-grp-hd:hover { background:var(--bg-3); }
.adm-caret { width:14px; color:var(--text-muted); font-size:12px; }
.adm-grp-name { font-weight:700; }
.adm-grp-count { background:var(--brand-soft); color:var(--brand); border-radius:999px; padding:1px 9px; font-size:11px; font-weight:700; }
.adm-grp-lead { margin-left:auto; color:var(--text-muted); font-size:12px; }
.adm-grp-body { padding:2px 10px 8px; }
.adm-row-lead > td { background:var(--brand-soft); }
.adm-user { display:flex; flex-direction:column; gap:4px; min-width:200px; }
.adm-uemail { display:flex; align-items:center; gap:8px; font-weight:600; font-size:13px; }
.adm-badge { font-size:10px; font-weight:700; padding:1px 7px; border-radius:999px; text-transform:uppercase; letter-spacing:.03em; }
.adm-badge-lead { background:#f59e0b22; color:#b45309; border:1px solid #f59e0b55; }
.adm-badge-admin { background:#6366f122; color:#4338ca; border:1px solid #6366f155; }
.adm-credit { display:flex; align-items:center; gap:5px; white-space:nowrap; }
.adm-used { color:var(--text-muted); min-width:26px; text-align:right; }
.adm-slash { color:var(--text-faint); }
.adm-cr { width:86px; }
`;
  document.head.appendChild(s);
}

export function renderAdmin(root) {
  ensureHubCss();
  ensureAdminCss();

  const usersCard = el('div', { class: 'card', style: { marginBottom: '16px' } }, 'Đang tải…');
  const teamsCard = el('div', { class: 'card', style: { marginBottom: '16px' } }, '');
  const auditCard = el('div', { class: 'card' }, '');
  root.appendChild(usersCard);
  root.appendChild(teamsCard);
  root.appendChild(auditCard);

  let teams = [];
  const collapsed = new Set();   // collapsed group keys (team id string | 'none') — kept across re-renders

  async function load() {
    try {
      const [u, t] = await Promise.all([api.hub.users(), api.hub.teams()]);
      teams = t || [];
      renderUsers(u || []);
      renderTeams(teams);
    } catch (e) {
      clear(usersCard);
      usersCard.appendChild(el('div', { class: 'empty' }, 'Lỗi: ' + hubErr(e)));
    }
    try {
      renderAudit(await api.hub.audit(100));
    } catch (e) {
      clear(auditCard);
      auditCard.appendChild(el('div', { class: 'hub-sec' }, 'Nhật ký hoạt động'));
      auditCard.appendChild(el('div', { class: 'empty' }, 'Lỗi tải nhật ký: ' + hubErr(e)));
    }
  }

  // ── Users (grouped by team, collapsible, lead-first, inline credit) ───
  function renderUsers(users) {
    clear(usersCard);
    usersCard.appendChild(el('div', { class: 'hub-sec' }, `Người dùng (${users.length})`));

    // add-member row: email + role + team + optional initial credit
    const addEmail = el('input', { class: 'hub-in', placeholder: 'email@redone.vn', style: { maxWidth: '220px' } });
    let addRole = 'member', addTeam = null;
    const addFlow = el('input', { class: 'hub-in adm-cr', type: 'number', placeholder: '0', title: 'Hạn mức Flow (−1 = ∞, để trống = 0)' });
    const addShakker = el('input', { class: 'hub-in adm-cr', type: 'number', placeholder: '0', title: 'Hạn mức Shakker (−1 = ∞, để trống = 0)' });
    const addBtn = el('button', { class: 'btn btn-primary' }, icon('plus', 16), ' Thêm');
    addBtn.addEventListener('click', async () => {
      const email = addEmail.value.trim().toLowerCase();
      if (!email || !email.includes('@')) { toast('Email không hợp lệ', 'error'); return; }
      try {
        await api.hub.upsertUser({ email, role: addRole, team_id: addTeam });
        const fl = addFlow.value.trim() === '' ? null : parseInt(addFlow.value, 10);
        const sk = addShakker.value.trim() === '' ? null : parseInt(addShakker.value, 10);
        const q = { email };
        if (fl != null && !isNaN(fl)) q.flow_limit = fl;
        if (sk != null && !isNaN(sk)) q.shakker_limit = sk;
        if (Object.keys(q).length > 1) await api.hub.setQuota(q);
        toast('Đã thêm ' + email, 'success');
        load();
      } catch (e) { toast(hubErr(e), 'error'); }
    });
    usersCard.appendChild(el('div', { class: 'hub-filters' },
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Email'), addEmail),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Vai trò'), pickRole('member', v => addRole = v)),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Nhóm'), pickTeam(teams, null, v => addTeam = v === '' ? null : parseInt(v, 10))),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Flow'), addFlow),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Shakker'), addShakker),
      addBtn,
    ));
    usersCard.appendChild(el('div', { class: 'hub-muted', style: { margin: '2px 0 12px' } },
      'Sửa hạn mức ngay trong ô Flow/Shakker rồi bấm ✓ để lưu. −1 = không giới hạn. ↺ = đưa số đã dùng về 0.'));

    if (!users.length) { usersCard.appendChild(el('div', { class: 'empty' }, 'Chưa có người dùng.')); return; }

    // group by team
    const teamById = new Map(teams.map(t => [String(t.id), t]));
    const groups = new Map();   // key → users[]
    for (const u of users) {
      const k = u.team_id != null ? String(u.team_id) : 'none';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(u);
    }
    // order: teams (in listing order) that have members, orphan teams, then 'none' last
    const keys = [...teams.map(t => String(t.id)).filter(k => groups.has(k))];
    for (const k of groups.keys()) { if (k !== 'none' && !keys.includes(k)) keys.push(k); }
    if (groups.has('none')) keys.push('none');

    const roleRank = r => r === 'admin' ? 0 : r === 'lead' ? 1 : 2;

    for (const k of keys) {
      const team = k === 'none' ? null : teamById.get(k);
      const leadEmail = team && team.lead_email ? team.lead_email.toLowerCase() : null;
      const members = groups.get(k).slice().sort((a, b) => {
        const al = leadEmail && a.email.toLowerCase() === leadEmail ? 0 : 1;
        const bl = leadEmail && b.email.toLowerCase() === leadEmail ? 0 : 1;
        if (al !== bl) return al - bl;
        const rr = roleRank(a.role) - roleRank(b.role);
        if (rr !== 0) return rr;
        return (a.name || a.email).localeCompare(b.name || b.email);
      });

      const isCollapsed = collapsed.has(k);
      const header = el('div', { class: 'adm-grp-hd' },
        el('span', { class: 'adm-caret' }, isCollapsed ? '▸' : '▾'),
        el('span', { class: 'adm-grp-name' }, team ? team.name : '— Không nhóm —'),
        el('span', { class: 'adm-grp-count' }, String(members.length)),
        leadEmail ? el('span', { class: 'adm-grp-lead' }, 'Lead: ' + leadEmail) : null,
      );
      header.addEventListener('click', () => {
        if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
        renderUsers(users);
      });

      const body = el('div', { class: 'adm-grp-body' },
        el('table', { class: 'hub-tbl adm-tbl' },
          el('thead', null, el('tr', null,
            el('th', null, 'Người dùng'), el('th', null, 'Vai trò'), el('th', null, 'Nhóm'),
            el('th', null, 'Flow (dùng / hạn mức)'), el('th', null, 'Shakker (dùng / hạn mức)'),
            el('th', { style: { textAlign: 'center' } }, 'Hoạt động'), el('th', null, ''))),
          el('tbody', null, ...members.map(u => userRow(u, leadEmail))),
        ),
      );
      if (isCollapsed) body.style.display = 'none';
      usersCard.appendChild(el('div', { class: 'adm-grp' }, header, body));
    }
  }

  function userRow(u, leadEmail) {
    const isLead = leadEmail && u.email.toLowerCase() === leadEmail;
    const nameIn = el('input', { class: 'hub-in', value: u.name || '', placeholder: 'Tên hiển thị' });
    let role = u.role, teamId = u.team_id, active = u.active;
    const roleSel = pickRole(u.role, v => role = v);
    const teamSel = pickTeam(teams, u.team_id, v => teamId = v === '' ? null : parseInt(v, 10));
    const activeCb = el('input', { type: 'checkbox', checked: u.active ? true : false });
    activeCb.addEventListener('change', e => active = e.target.checked);

    const origFlow = u.flow_limit == null ? -1 : u.flow_limit;
    const origShakker = u.shakker_limit == null ? -1 : u.shakker_limit;
    const flowIn = el('input', { class: 'hub-in adm-cr', type: 'number', value: String(origFlow), title: 'Hạn mức Flow (−1 = ∞)' });
    const shakkerIn = el('input', { class: 'hub-in adm-cr', type: 'number', value: String(origShakker), title: 'Hạn mức Shakker (−1 = ∞)' });
    const flowCell = el('td', null, el('div', { class: 'adm-credit' },
      el('span', { class: 'adm-used', title: 'đã dùng' }, String(u.flow_used || 0)), el('span', { class: 'adm-slash' }, '/'), flowIn));
    const shakkerCell = el('td', null, el('div', { class: 'adm-credit' },
      el('span', { class: 'adm-used', title: 'đã dùng' }, String(u.shakker_used || 0)), el('span', { class: 'adm-slash' }, '/'), shakkerIn));

    const saveBtn = el('button', { class: 'btn btn-sm' }, icon('check', 14));
    saveBtn.title = 'Lưu (tên + vai trò + nhóm + hạn mức)';
    saveBtn.addEventListener('click', async () => {
      try {
        await api.hub.upsertUser({ email: u.email, name: nameIn.value, role, team_id: teamId, active });
        const fl = parseInt(flowIn.value, 10), sk = parseInt(shakkerIn.value, 10);
        const q = {};
        if (!isNaN(fl) && fl !== origFlow) q.flow_limit = fl;
        if (!isNaN(sk) && sk !== origShakker) q.shakker_limit = sk;
        if (Object.keys(q).length) { q.email = u.email; await api.hub.setQuota(q); }
        toast('Đã lưu ' + u.email, 'success');
        load();
      } catch (e) { toast(hubErr(e), 'error'); }
    });
    const resetBtn = el('button', { class: 'btn btn-sm btn-ghost' }, '↺');
    resetBtn.title = 'Reset số đã dùng về 0';
    resetBtn.addEventListener('click', () => confirmAct(`Đưa số credit đã dùng của ${u.email} về 0?`, async () => {
      try { await api.hub.setQuota({ email: u.email, reset: true }); toast('Đã reset', 'success'); load(); }
      catch (e) { toast(hubErr(e), 'error'); }
    }, 'Reset'));
    const delBtn = el('button', { class: 'btn btn-sm btn-ghost' }, icon('trash', 14));
    delBtn.title = 'Xoá';
    delBtn.addEventListener('click', () => confirmAct(`Xoá người dùng ${u.email}?`, async () => {
      try { await api.hub.delUser(u.email); toast('Đã xoá', 'success'); load(); }
      catch (e) { toast(hubErr(e), 'error'); }
    }, 'Xoá'));

    const badge = isLead ? el('span', { class: 'adm-badge adm-badge-lead' }, 'Lead')
      : u.role === 'admin' ? el('span', { class: 'adm-badge adm-badge-admin' }, 'Admin')
        : null;

    return el('tr', { class: isLead ? 'adm-row-lead' : '' },
      el('td', null, el('div', { class: 'adm-user' },
        el('div', { class: 'adm-uemail' }, u.email, badge),
        nameIn,
      )),
      el('td', null, roleSel),
      el('td', null, teamSel),
      flowCell,
      shakkerCell,
      el('td', { style: { textAlign: 'center' } }, activeCb),
      el('td', null, el('div', { style: { display: 'flex', gap: '4px' } }, saveBtn, resetBtn, delBtn)),
    );
  }

  // ── Teams ───────────────────────────────────────────────────────────
  function renderTeams(list) {
    clear(teamsCard);
    teamsCard.appendChild(el('div', { class: 'hub-sec' }, `Nhóm (${list.length})`));

    const addName = el('input', { class: 'hub-in', placeholder: 'Tên nhóm', style: { maxWidth: '220px' } });
    const addLead = el('input', { class: 'hub-in', placeholder: 'lead@redone.vn', style: { maxWidth: '240px' } });
    const addBtn = el('button', { class: 'btn btn-primary' }, icon('plus', 16), ' Tạo nhóm');
    addBtn.addEventListener('click', async () => {
      const name = addName.value.trim();
      if (!name) { toast('Nhập tên nhóm', 'error'); return; }
      try { await api.hub.upsertTeam({ name, lead_email: addLead.value.trim().toLowerCase() }); toast('Đã tạo nhóm', 'success'); load(); }
      catch (e) { toast(hubErr(e), 'error'); }
    });
    teamsCard.appendChild(el('div', { class: 'hub-filters' },
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Tên nhóm'), addName),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Lead (email)'), addLead),
      addBtn,
    ));

    if (!list.length) { teamsCard.appendChild(el('div', { class: 'empty' }, 'Chưa có nhóm.')); return; }

    const rows = list.map(t => {
      const nameIn = el('input', { class: 'hub-in', value: t.name || '' });
      const leadIn = el('input', { class: 'hub-in', value: t.lead_email || '' });
      const saveBtn = el('button', { class: 'btn btn-sm' }, icon('check', 14));
      saveBtn.title = 'Lưu';
      saveBtn.addEventListener('click', async () => {
        try { await api.hub.upsertTeam({ id: t.id, name: nameIn.value, lead_email: leadIn.value.trim().toLowerCase() }); toast('Đã lưu nhóm', 'success'); load(); }
        catch (e) { toast(hubErr(e), 'error'); }
      });
      const delBtn = el('button', { class: 'btn btn-sm btn-ghost' }, icon('trash', 14));
      delBtn.title = 'Xoá';
      delBtn.addEventListener('click', () => confirmAct(`Xoá nhóm "${t.name}"? Thành viên sẽ bị gỡ khỏi nhóm.`, async () => {
        try { await api.hub.delTeam(t.id); toast('Đã xoá nhóm', 'success'); load(); }
        catch (e) { toast(hubErr(e), 'error'); }
      }, 'Xoá'));
      return el('tr', null,
        el('td', null, nameIn),
        el('td', null, leadIn),
        el('td', { style: { textAlign: 'center' } }, String(t.member_count != null ? t.member_count : 0)),
        el('td', null, el('div', { style: { display: 'flex', gap: '6px' } }, saveBtn, delBtn)),
      );
    });
    teamsCard.appendChild(el('table', { class: 'hub-tbl' },
      el('thead', null, el('tr', null,
        el('th', null, 'Tên nhóm'), el('th', null, 'Lead (email)'),
        el('th', { style: { textAlign: 'center' } }, 'Thành viên'), el('th', null, ''))),
      el('tbody', null, ...rows),
    ));
  }

  function renderAudit(rows) {
    clear(auditCard);
    auditCard.appendChild(el('div', { class: 'hub-sec' }, 'Nhật ký hoạt động'));
    if (!rows || !rows.length) { auditCard.appendChild(el('div', { class: 'empty' }, 'Chưa có nhật ký.')); return; }
    auditCard.appendChild(el('table', { class: 'hub-tbl' },
      el('thead', null, el('tr', null,
        el('th', null, 'Thời gian'), el('th', null, 'Người'), el('th', null, 'Hành động'),
        el('th', null, 'Đối tượng'), el('th', null, 'Chi tiết'))),
      el('tbody', null, ...rows.map(r => el('tr', null,
        el('td', { class: 'hub-muted', style: { whiteSpace: 'nowrap' } }, fmtT(r.created_at)),
        el('td', null, (r.actor_email || '').split('@')[0]),
        el('td', null, r.action || ''),
        el('td', null, r.target || ''),
        el('td', { class: 'hub-muted' }, r.detail || ''),
      ))),
    ));
  }

  load();
}
