// Accounts page — Google account management
import { el, clear, toast, setLoading, icon, modal, confirm } from '../ui.js';
import { api } from '../api.js';
import { store } from '../app.js';

// Shared team account (Hub). Managers (admin/lead) can enter the credentials
// + see status & balance; members see only the account name + connection
// status (never the password). Hidden entirely on standalone (no-Hub) builds.
async function renderSharedAccount(box) {
  const hub = (window.__app && window.__app.hub) || {};
  clear(box);
  if (!hub.enabled) { box.style.display = 'none'; return; }
  box.style.display = '';
  const role = hub.role || 'member';
  const isManager = role === 'admin' || role === 'lead';

  box.appendChild(el('h3', { style: { margin: '0 0 10px', fontSize: '16px' } }, 'Tài khoản chung (nhóm)'));

  const statusEl = el('div', { class: 'account-meta', style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginBottom: isManager ? '14px' : '0' } }, 'Đang tải trạng thái…');
  box.appendChild(statusEl);

  const chip = (label, ok, okTxt, badTxt) =>
    el('span', { class: 'chip ' + (ok ? 'chip-green' : 'chip-yellow') }, `${label}: ${ok ? okTxt : badTxt}`);

  async function loadStatus() {
    try {
      const s = await api.hub.sharedAccountStatus();
      clear(statusEl);
      statusEl.appendChild(el('span', { class: 'account-email' }, s.email || '(chưa cấu hình)'));
      statusEl.appendChild(chip('Flow', s.flow_connected, 'đã đăng nhập', s.has_google ? 'chưa đăng nhập' : 'chưa cấu hình'));
      statusEl.appendChild(chip('Shakker', s.shakker_connected, 'sẵn sàng', s.has_shakker ? 'chưa kết nối' : 'chưa cấu hình'));
    } catch (e) { statusEl.textContent = 'Không tải được trạng thái: ' + (e.message || e); }
  }
  loadStatus();

  if (!isManager) return;  // members: status only, no form

  let teamId;
  let teamSel = null;
  if (role === 'admin') {
    try {
      const teams = await api.hub.teams();
      if (teams && teams.length) {
        teamId = teams[0].id;
        teamSel = el('select', { class: 'input', style: { maxWidth: '200px' },
          onchange: e => { teamId = parseInt(e.target.value, 10); loadForm(); } },
          ...teams.map(t => el('option', { value: String(t.id) }, t.name)));
      }
    } catch (_) { /* admin without teams → manage own team */ }
  }

  const emailIn = el('input', { class: 'input', placeholder: 'shared@gmail.com', autocomplete: 'off' });
  const pwIn = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const tokenIn = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const balEl = el('div', { class: 'field-help', style: { marginTop: '8px' } }, '');
  const saveBtn = el('button', { class: 'btn btn-primary', onclick: save }, icon('check', 16), ' Lưu tài khoản chung');
  const fld = (label, ctrl) => el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '170px', flex: '1' } },
    el('label', { class: 'field-label' }, label), ctrl);

  box.appendChild(el('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' } },
    ...(teamSel ? [fld('Nhóm', teamSel)] : []),
    fld('Google email', emailIn),
    fld('Google mật khẩu', pwIn),
    fld('Shakker token (tự động)', tokenIn),
    el('div', { style: { display: 'flex', alignItems: 'flex-end' } }, saveBtn),
  ));
  box.appendChild(balEl);

  async function loadForm() {
    try {
      const c = await api.hub.getTeamCredentials(teamId);
      emailIn.value = c.google_email || '';
      pwIn.value = ''; tokenIn.value = '';
      pwIn.placeholder = c.google_password_set ? '•••• đã đặt — trống = giữ' : 'chưa đặt';
      tokenIn.placeholder = c.shakker_token_set ? '•••• đã đặt — trống = giữ' : 'chưa đặt';
    } catch (e) { toast(e.message || 'Lỗi tải tài khoản chung', 'error'); }
    try {
      const b = await api.hub.sharedBalance();
      const fc = (b && b.flow_credits != null) ? b.flow_credits : '—';
      const sp = (b && b.shakker_power != null) ? b.shakker_power : '—';
      balEl.textContent = `Số dư thật (đọc trên máy này): Flow ${fc} · Shakker ${sp}`;
    } catch (_) { balEl.textContent = ''; }
  }
  async function save() {
    saveBtn.disabled = true;
    try {
      const payload = { google_email: emailIn.value.trim() };
      if (teamId) payload.team_id = teamId;
      if (pwIn.value) payload.google_password = pwIn.value;
      if (tokenIn.value) payload.shakker_token = tokenIn.value;
      await api.hub.setTeamCredentials(payload);
      toast('Đã lưu tài khoản chung (mật khẩu được mã hóa)', 'success');
      pwIn.value = ''; tokenIn.value = '';
      loadForm(); loadStatus();
    } catch (e) { toast(e.message || 'Lưu thất bại', 'error'); }
    finally { saveBtn.disabled = false; }
  }
  loadForm();
}

export function renderAccounts(root) {
  // Shared team account (Hub) — managers edit, members see status only.
  const sharedBox = el('div', { class: 'card', style: { marginBottom: '20px' } });
  root.appendChild(sharedBox);
  renderSharedAccount(sharedBox);

  // Stats
  const stats = el('div', { class: 'stats-grid' });
  root.appendChild(stats);

  // Toolbar
  root.appendChild(el('div', { style: { display: 'flex', gap: '8px', marginBottom: '20px' } },
    el('button', { class: 'btn btn-primary', onclick: addAccount }, icon('plus'), 'Thêm account'),
    el('button', { class: 'btn', onclick: checkAll }, icon('refresh'), 'Check tất cả'),
  ));

  // Grid container
  const grid = el('div', { class: 'account-grid' });
  root.appendChild(grid);

  // ── Shakker accounts section ──
  root.appendChild(el('div', {
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexWrap: 'wrap', gap: '8px', margin: '28px 0 12px',
      borderTop: '1px solid var(--border)', paddingTop: '20px',
    },
  },
    el('div', null,
      el('h3', { style: { margin: 0, fontSize: '16px' } }, 'Tài khoản Shakker'),
      el('div', { class: 'field-help', style: { margin: '2px 0 0' } },
        'Tự thêm khi đăng nhập shakker.ai trong Chrome (qua extension). '
        + 'Khi báo "Hết phiên" → mở lại shakker.ai để extension đồng bộ token mới.'),
    ),
    el('div', { style: { display: 'flex', gap: '8px' } },
      el('button', { class: 'btn btn-sm btn-ghost',
        onclick: () => window.open('https://www.shakker.ai/', '_blank') },
        icon('upload', 14), 'Mở shakker.ai'),
      el('button', { class: 'btn btn-sm', onclick: () => checkAllShakker() },
        icon('refresh', 14), 'Check Shakker'),
    ),
  ));
  const shakkerGrid = el('div', { class: 'account-grid' });
  root.appendChild(shakkerGrid);

  function renderStats() {
    clear(stats);
    const accs = store.accounts || [];
    const active = accs.filter(a => a.enabled).length;
    const credits = accs.reduce((s, a) => s + (a.credit || 0), 0);
    const ultra = accs.filter(a => (a.tier || '').toUpperCase().includes('ULTRA')).length;
    [
      { label: 'Tổng accounts', value: accs.length, glow: 'blue' },
      { label: 'Đang bật', value: active, glow: 'green' },
      { label: 'Tổng Tín dụng Flow', value: credits.toLocaleString('vi-VN'), glow: 'purple' },
      { label: 'Tier ULTRA', value: ultra, glow: 'orange' },
    ].forEach(s => {
      stats.appendChild(el('div', { class: `stat-card glow-${s.glow}` },
        el('div', { class: 'stat-label' }, s.label),
        el('div', { class: 'stat-value' }, String(s.value)),
      ));
    });
  }

  function renderGrid() {
    clear(grid);
    const accs = store.accounts || [];
    if (accs.length === 0) {
      grid.appendChild(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } },
        el('div', { class: 'empty-icon' }, icon('upload', 32)),
        el('div', null, 'Chưa có account nào. Bấm "Thêm account" để bắt đầu.'),
      ));
      return;
    }
    accs.forEach(acc => {
      const tier = (acc.tier || 'FREE').toUpperCase();
      const tierChip = tier.includes('ULTRA') || tier.includes('PRO')
        ? el('span', { class: 'chip chip-ultra' }, '⚡ ' + tier)
        : el('span', { class: 'chip' }, tier);

      const card = el('div', { class: 'account-card' },
        el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
          el('div', { class: 'account-avatar' }, (acc.email || '?')[0].toUpperCase()),
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('div', { class: 'account-email' }, acc.email),
            el('div', { class: 'account-meta' },
              el('span', null, `${(acc.credit || 0).toLocaleString('vi-VN')} Tín dụng Flow`),
              el('span', { style: { margin: '0 6px' } }, '•'),
              tierChip,
            ),
          ),
          el('label', { class: 'toggle' },
            el('input', { type: 'checkbox', ...(acc.enabled ? { checked: 'true' } : {}),
              onchange: () => api.accounts.toggle(acc.id).then(() => { reload(); }) }),
            el('span', { class: 'toggle-track' }),
          ),
        ),
        el('div', { class: 'account-actions' },
          el('button', { class: 'btn btn-sm btn-ghost',
            onclick: () => uploadCookie(acc) },
            icon('upload', 14), 'Cookie'),
          el('button', { class: 'btn btn-sm btn-ghost',
            onclick: () => checkOne(acc.id) },
            icon('refresh', 14), 'Check'),
          el('button', { class: 'btn btn-sm btn-ghost',
            onclick: () => loginOne(acc.id) },
            icon('eye', 14), 'Login'),
          el('button', { class: 'btn btn-sm btn-danger',
            onclick: () => deleteOne(acc) },
            icon('trash', 14)),
        ),
      );
      grid.appendChild(card);
    });
  }

  async function reload() {
    try {
      const r = await api.accounts.list();
      store.accounts = r.accounts || [];
      await window.__app.refreshAccounts();
      renderStats();
      renderGrid();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function addAccount() {
    const input = el('input', { class: 'input', placeholder: 'email@gmail.com', autofocus: 'true' });
    modal({
      title: 'Thêm Google account',
      body: el('div', null,
        el('p', { class: 'field-help', style: { marginBottom: '12px' } },
          'Nhập email để tạo entry. Sau đó upload cookies (export bằng Cookie-Editor) hoặc bấm Login để mở Chrome.'),
        input,
      ),
      actions: [
        { label: 'Hủy', class: 'btn-ghost' },
        { label: 'Thêm', class: 'btn-primary', onclick: async (close) => {
          const email = input.value.trim();
          if (!email) return;
          try {
            await api.accounts.add(email);
            close();
            await reload();
            toast(`Đã thêm ${email}`, 'success');
          } catch (e) { toast(e.message, 'error'); }
        } },
      ],
    });
  }

  async function uploadCookie(acc) {
    const fi = document.createElement('input');
    fi.type = 'file'; fi.accept = '.json';
    fi.onchange = async () => {
      const f = fi.files[0]; if (!f) return;
      try {
        await api.accounts.uploadCookie(acc.id, f);
        toast('Đã upload cookies', 'success');
        await reload();
      } catch (e) { toast(e.message, 'error'); }
    };
    fi.click();
  }

  async function checkOne(id) {
    try {
      toast('Đang check session...', 'info');
      const r = await api.accounts.check(id);
      if (!r.ok) {
        toast(r.message || 'Check thất bại', 'error');
      } else if (!r.alive) {
        toast(r.message || 'Session chết — login lại', 'error');
      } else if (r.credit_fetch_ok && typeof r.credit === 'number') {
        // Successful credit read — including genuine 0
        toast(`Account OK • ${r.credit.toLocaleString('vi-VN')} Tín dụng Flow`, 'success');
      } else {
        // Session alive but credit detection failed (Google changed UI,
        // page didn't fully load, etc.). DB credit untouched — UI keeps
        // showing the previously-known value.
        toast(
          `Account OK • Không đọc được credit (${r.credit_fetch_error || 'unknown'}) — `
          + `credit cũ giữ nguyên`,
          'warning',
        );
      }
      await reload();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function checkAll() {
    try {
      toast('Đang check tất cả accounts...', 'info');
      await api.accounts.checkAll();
      await reload();
      toast('Check xong', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function loginOne(id) {
    // Check auth_mode first — in extension mode the legacy Cloak login
    // flow is useless (cookies end up in Cloak profile, but bridge reads
    // from real Chrome). Tell user the right flow instead.
    let authMode = 'extension';
    try {
      const s = await api.settings.get();
      authMode = (s.settings?.auth_mode || 'extension').toLowerCase();
    } catch (_) { /* default to extension */ }

    if (authMode === 'extension') {
      const proceed = await confirm(
        'Bạn đang dùng Auth mode = Extension Bridge.\n\n' +
        'KHÔNG cần bấm Login trong tool — Cloak browser bật ra sẽ KHÔNG giúp gì ' +
        '(extension chỉ thấy được Chrome thật của bạn).\n\n' +
        'Workflow đúng:\n' +
        '1) Mở Chrome THẬT (chrome.exe — chỗ đã cài extension "RedOne Auth Helper")\n' +
        '2) Mở tab mới: https://labs.google/fx/tools/flow\n' +
        '3) Bấm Sign in → chọn account Google muốn dùng\n' +
        '4) Đợi tab load xong → quay lại RedOne UI → gen task\n\n' +
        'Muốn t mở giúp tab labs.google không?',
        'Extension Bridge — không cần Login button',
      );
      if (proceed) {
        // Best we can do from web UI — opens labs.google in user's default
        // browser. If their default is Chrome (with ext) → perfect.
        window.open('https://labs.google/fx/tools/flow', '_blank');
        toast('Đã mở labs.google. Login Google trong tab đó.', 'info', 8000);
      }
      return;
    }

    // Legacy Playwright/Cloak login flow
    if (!await confirm(
      'Sẽ mở 1 cửa sổ Chrome thật để bạn đăng nhập Google.\n\n' +
      '⚠️ BƯỚC QUAN TRỌNG sau khi nhập mật khẩu:\n' +
      '1) Chrome sẽ tự về https://labs.google/fx/tools/video-fx\n' +
      '2) Nếu vẫn ở landing page, bấm vào "Try Flow" / "Create with Flow"\n' +
      '3) Khi đã vào được app Flow → cookies tự lưu, Chrome tự tắt\n\n' +
      'Timeout: 5 phút.\n\nTiếp tục?', 'Đăng nhập Google',
    )) return;
    try {
      toast('Đang mở Chrome (mất ~5 giây)...', 'info', 6000);
      const r = await api.accounts.login(id);
      if (r.ok) toast(r.message || 'Login thành công', 'success', 6000);
      else toast(r.message || 'Login thất bại / hết hạn', 'error', 8000);
      await reload();
    } catch (e) { toast(`Lỗi: ${e.message}`, 'error', 8000); }
  }

  async function deleteOne(acc) {
    if (!await confirm(`Xóa account ${acc.email}?`, 'Xác nhận')) return;
    try {
      await api.accounts.del(acc.id);
      toast('Đã xóa', 'success');
      await reload();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ── Shakker account management ──
  function renderShakkerGrid(accts) {
    clear(shakkerGrid);
    if (!accts.length) {
      shakkerGrid.appendChild(el('div', { class: 'empty', style: { gridColumn: '1 / -1' } },
        el('div', { class: 'empty-icon' }, icon('image', 32)),
        el('div', null, 'Chưa có tài khoản Shakker. Mở shakker.ai trong Chrome (đã cài extension) và đăng nhập — tài khoản sẽ tự xuất hiện.'),
      ));
      return;
    }
    accts.forEach(a => {
      const enabled = !!a.enabled;
      const statusMap = {
        OK: ['chip-green', 'Hoạt động'],
        TOKEN_EXPIRED: ['chip-red', 'Hết phiên'],
        ERROR: ['chip-yellow', a.status_msg || 'Lỗi'],
      };
      const [chipCls, chipTxt] = statusMap[a.status]
        || (a.has_token ? ['chip-yellow', 'Chưa kiểm tra'] : ['chip-red', 'Chưa có token']);
      const card = el('div', { class: 'account-card', style: enabled ? {} : { opacity: '0.55' } },
        el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
          el('div', { class: 'account-avatar' }, (a.email || 'S')[0].toUpperCase()),
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('div', { class: 'account-email' }, a.email || '(tài khoản Shakker)'),
            el('div', { class: 'account-meta' },
              el('span', null, `${(a.usable_power || 0).toLocaleString('vi-VN')} power`),
              el('span', { style: { margin: '0 6px' } }, '•'),
              el('span', { class: `chip ${chipCls}` }, chipTxt),
            ),
          ),
          el('label', { class: 'toggle' },
            el('input', {
              type: 'checkbox', ...(enabled ? { checked: 'true' } : {}),
              onchange: () => api.shakkerAccounts.toggle(a.id).then(loadShakker).catch(e => toast(e.message, 'error')),
            }),
            el('span', { class: 'toggle-track' }),
          ),
        ),
        el('div', { class: 'account-meta', style: { marginTop: '8px' } },
          `${a.tier || 'FREE'} · đã dùng ${(a.used_power || 0).toLocaleString('vi-VN')}`
          + (a.last_check_at ? ` · ${String(a.last_check_at).replace('T', ' ')}` : '')),
        el('div', { class: 'account-actions' },
          el('button', { class: 'btn btn-sm btn-ghost', onclick: () => checkOneShakker(a.id) },
            icon('refresh', 14), 'Check'),
          el('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteShakker(a) },
            icon('trash', 14)),
        ),
      );
      shakkerGrid.appendChild(card);
    });
  }

  async function loadShakker() {
    try {
      const r = await api.shakkerAccounts.list();
      renderShakkerGrid(r.accounts || []);
      if (window.__app && window.__app.refreshShakkerPower) window.__app.refreshShakkerPower();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function checkOneShakker(id) {
    try {
      toast('Đang kiểm tra Shakker...', 'info');
      await api.shakkerAccounts.check(id);
      await loadShakker();
      toast('Đã kiểm tra', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function checkAllShakker() {
    try {
      toast('Đang kiểm tra tất cả Shakker...', 'info');
      await api.shakkerAccounts.checkAll();
      await loadShakker();
      toast('Xong', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function deleteShakker(a) {
    if (!await confirm(`Xóa tài khoản Shakker "${a.email || a.id}"?`, 'Xác nhận')) return;
    try {
      await api.shakkerAccounts.del(a.id);
      toast('Đã xóa', 'success');
      await loadShakker();
    } catch (e) { toast(e.message, 'error'); }
  }

  // Initial load
  renderStats();
  renderGrid();
  reload();
  loadShakker();
}
