// Accounts page — Google account management
import { el, clear, toast, setLoading, icon, modal, confirm } from '../ui.js';
import { api } from '../api.js';
import { store } from '../app.js';

export function renderAccounts(root) {
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
