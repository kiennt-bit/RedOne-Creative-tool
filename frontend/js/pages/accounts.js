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

  function renderStats() {
    clear(stats);
    const accs = store.accounts || [];
    const active = accs.filter(a => a.enabled).length;
    const credits = accs.reduce((s, a) => s + (a.credit || 0), 0);
    const ultra = accs.filter(a => (a.tier || '').toUpperCase().includes('ULTRA')).length;
    [
      { label: 'Tổng accounts', value: accs.length, glow: 'blue' },
      { label: 'Đang bật', value: active, glow: 'green' },
      { label: 'Tổng credits', value: credits.toLocaleString('vi-VN'), glow: 'purple' },
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
              el('span', null, `${(acc.credit || 0).toLocaleString('vi-VN')} credits`),
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
      if (r.ok && r.alive) toast(`Account OK • ${r.credit || 0} credits`, 'success');
      else toast(r.message || 'Session chết', 'error');
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

  // Initial load
  renderStats();
  renderGrid();
  reload();
}
