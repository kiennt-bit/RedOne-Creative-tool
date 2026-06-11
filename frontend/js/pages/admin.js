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
function fmtLim(used, limit) {
  const u = used || 0;
  return limit == null ? `${u}/∞` : `${u}/${limit}`;   // limit null = không giới hạn
}
function confirmDelete(msg, onYes) {
  modal({
    title: 'Xác nhận xoá',
    body: el('p', null, msg),
    actions: [
      { label: 'Huỷ', class: 'btn-ghost' },
      { label: 'Xoá', class: 'btn-primary', onclick: (close) => { close(); onYes(); } },
    ],
  });
}

export function renderAdmin(root) {
  ensureHubCss();

  const usersCard = el('div', { class: 'card', style: { marginBottom: '16px' } }, 'Đang tải…');
  const teamsCard = el('div', { class: 'card', style: { marginBottom: '16px' } }, '');
  const quotaCard = el('div', { class: 'card' }, '');
  root.appendChild(usersCard);
  root.appendChild(teamsCard);
  root.appendChild(quotaCard);

  let teams = [];

  async function load() {
    try {
      const [u, t] = await Promise.all([api.hub.users(), api.hub.teams()]);
      teams = t || [];
      renderUsers(u || []);
      renderTeams(teams);
      renderQuota();
    } catch (e) {
      clear(usersCard);
      usersCard.appendChild(el('div', { class: 'empty' }, 'Lỗi: ' + hubErr(e)));
    }
  }

  // ── Users ───────────────────────────────────────────────────────────
  function renderUsers(users) {
    clear(usersCard);
    usersCard.appendChild(el('div', { class: 'hub-sec' }, `Người dùng (${users.length})`));

    // add-user row
    const addEmail = el('input', { class: 'hub-in', placeholder: 'email@redone.vn', style: { maxWidth: '260px' } });
    let addRole = 'member';
    const addBtn = el('button', { class: 'btn btn-primary' }, icon('plus', 16), ' Thêm');
    addBtn.addEventListener('click', async () => {
      const email = addEmail.value.trim().toLowerCase();
      if (!email || !email.includes('@')) { toast('Email không hợp lệ', 'error'); return; }
      try { await api.hub.upsertUser({ email, role: addRole }); toast('Đã thêm ' + email, 'success'); load(); }
      catch (e) { toast(hubErr(e), 'error'); }
    });
    usersCard.appendChild(el('div', { class: 'hub-filters' },
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Email'), addEmail),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Vai trò'), pickRole('member', v => addRole = v)),
      addBtn,
    ));

    if (!users.length) { usersCard.appendChild(el('div', { class: 'empty' }, 'Chưa có người dùng.')); return; }

    const rows = users.map(u => {
      const nameIn = el('input', { class: 'hub-in', value: u.name || '' });
      let role = u.role, teamId = u.team_id;
      let active = u.active;
      const roleSel = pickRole(u.role, v => role = v);
      const teamSel = pickTeam(teams, u.team_id, v => teamId = v === '' ? null : parseInt(v, 10));
      const activeCb = el('input', { type: 'checkbox', checked: u.active ? true : false });
      activeCb.addEventListener('change', e => active = e.target.checked);
      const saveBtn = el('button', { class: 'btn btn-sm' }, icon('check', 14));
      saveBtn.title = 'Lưu';
      saveBtn.addEventListener('click', async () => {
        try {
          await api.hub.upsertUser({ email: u.email, name: nameIn.value, role, team_id: teamId, active });
          toast('Đã lưu ' + u.email, 'success');
        } catch (e) { toast(hubErr(e), 'error'); }
      });
      const delBtn = el('button', { class: 'btn btn-sm btn-ghost' }, icon('trash', 14));
      delBtn.title = 'Xoá';
      delBtn.addEventListener('click', () => confirmDelete(`Xoá người dùng ${u.email}?`, async () => {
        try { await api.hub.delUser(u.email); toast('Đã xoá', 'success'); load(); }
        catch (e) { toast(hubErr(e), 'error'); }
      }));
      return el('tr', null,
        el('td', null, el('div', { style: { fontWeight: 600 } }, u.email)),
        el('td', null, nameIn),
        el('td', null, roleSel),
        el('td', null, teamSel),
        el('td', { class: 'hub-muted', title: 'đã dùng / hạn mức Flow' }, fmtLim(u.flow_used, u.flow_limit)),
        el('td', { class: 'hub-muted', title: 'đã dùng / hạn mức Shakker' }, fmtLim(u.shakker_used, u.shakker_limit)),
        el('td', { style: { textAlign: 'center' } }, activeCb),
        el('td', null, el('div', { style: { display: 'flex', gap: '6px' } }, saveBtn, delBtn)),
      );
    });
    usersCard.appendChild(el('table', { class: 'hub-tbl' },
      el('thead', null, el('tr', null,
        el('th', null, 'Email'), el('th', null, 'Tên'), el('th', null, 'Vai trò'),
        el('th', null, 'Nhóm'), el('th', null, 'Flow'), el('th', null, 'Shakker'),
        el('th', { style: { textAlign: 'center' } }, 'Hoạt động'), el('th', null, ''))),
      el('tbody', null, ...rows),
    ));
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
      delBtn.addEventListener('click', () => confirmDelete(`Xoá nhóm "${t.name}"? Thành viên sẽ bị gỡ khỏi nhóm.`, async () => {
        try { await api.hub.delTeam(t.id); toast('Đã xoá nhóm', 'success'); load(); }
        catch (e) { toast(hubErr(e), 'error'); }
      }));
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

  // ── Quota ───────────────────────────────────────────────────────────
  function renderQuota() {
    clear(quotaCard);
    quotaCard.appendChild(el('div', { class: 'hub-sec' }, 'Hạn mức credit'));
    quotaCard.appendChild(el('div', { class: 'hub-muted', style: { marginBottom: '10px' } },
      'Đặt hạn mức theo chu kỳ cho từng người. Để −1 = không giới hạn. "Reset" đưa số đã dùng về 0.'));

    const qEmail = el('input', { class: 'hub-in', placeholder: 'email@redone.vn', style: { maxWidth: '240px' } });
    let qPeriod = 'monthly';
    const qFlow = el('input', { class: 'hub-in', type: 'number', value: '0', style: { maxWidth: '110px' } });
    const qShakker = el('input', { class: 'hub-in', type: 'number', value: '0', style: { maxWidth: '110px' } });
    const qReset = el('input', { type: 'checkbox' });
    const setBtn = el('button', { class: 'btn btn-primary' }, 'Đặt hạn mức');
    setBtn.addEventListener('click', async () => {
      const email = qEmail.value.trim().toLowerCase();
      if (!email.includes('@')) { toast('Email không hợp lệ', 'error'); return; }
      try {
        await api.hub.setQuota({
          email, period: qPeriod,
          flow_limit: parseInt(qFlow.value, 10),
          shakker_limit: parseInt(qShakker.value, 10),
          reset: qReset.checked,
        });
        toast(`Đã đặt hạn mức cho ${email}`, 'success');
        load();
      } catch (e) { toast(hubErr(e), 'error'); }
    });
    quotaCard.appendChild(el('div', { class: 'hub-filters' },
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Email'), qEmail),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Chu kỳ'),
        el('select', { class: 'hub-in', onchange: e => qPeriod = e.target.value },
          ...[['monthly', 'Hàng tháng'], ['weekly', 'Hàng tuần'], ['daily', 'Hàng ngày'], ['none', 'Không reset']]
            .map(([v, l]) => el('option', { value: v, selected: v === 'monthly' }, l)))),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Flow (−1=∞)'), qFlow),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Shakker (−1=∞)'), qShakker),
      el('label', { class: 'hub-fld', style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } }, qReset, 'Reset đã dùng'),
      setBtn,
    ));

    // grant / adjust
    quotaCard.appendChild(el('div', { class: 'hub-sec', style: { marginTop: '14px' } }, 'Điều chỉnh credit'));
    const gEmail = el('input', { class: 'hub-in', placeholder: 'email@redone.vn', style: { maxWidth: '240px' } });
    let gPool = 'flow';
    const gDelta = el('input', { class: 'hub-in', type: 'number', value: '0', style: { maxWidth: '110px' }, title: '+ cấp thêm / − giảm hạn mức' });
    const gReason = el('input', { class: 'hub-in', placeholder: 'lý do', style: { maxWidth: '180px' } });
    const gBtn = el('button', { class: 'btn' }, 'Điều chỉnh');
    gBtn.addEventListener('click', async () => {
      const email = gEmail.value.trim().toLowerCase();
      const delta = parseInt(gDelta.value, 10);
      if (!email.includes('@') || !delta) { toast('Nhập email + số ≠ 0', 'error'); return; }
      try {
        const r = await api.hub.grant({ email, pool: gPool, delta, reason: gReason.value || 'điều chỉnh thủ công' });
        toast(`Đã điều chỉnh ${gPool} cho ${email} → hạn mức ${r && r.limit != null ? r.limit : '?'}`, 'success');
        gDelta.value = '0';
        load();
      } catch (e) { toast(hubErr(e), 'error'); }
    });
    quotaCard.appendChild(el('div', { class: 'hub-filters' },
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Email'), gEmail),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Hũ'),
        el('select', { class: 'hub-in', onchange: e => gPool = e.target.value },
          el('option', { value: 'flow', selected: true }, 'Flow'),
          el('option', { value: 'shakker' }, 'Shakker'))),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Delta (+/−)'), gDelta),
      el('div', { class: 'hub-fld' }, el('label', { class: 'field-label' }, 'Lý do'), gReason),
      gBtn,
    ));
  }

  load();
}
