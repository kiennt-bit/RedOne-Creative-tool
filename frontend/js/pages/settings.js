// Settings page — API keys, output folder, etc.
import { el, clear, toast, setLoading, icon } from '../ui.js';
import { api } from '../api.js';

export function renderSettings(root) {
  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' } });
  root.appendChild(layout);

  // API Keys
  const apiCard = el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'API Keys'),
    el('p', { class: 'card-subtitle', style: { marginBottom: '16px' } },
      'Gemini API key dùng cho phân tích YouTube/script/image. Lấy ở https://aistudio.google.com/apikey'),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Gemini API Key'),
      el('div', { style: { display: 'flex', gap: '8px' } },
        el('input', { type: 'password', class: 'input', id: 'st-gemini', placeholder: 'AIza...' }),
        el('button', { class: 'btn', id: 'st-toggle', onclick: () => {
          const inp = root.querySelector('#st-gemini');
          inp.type = inp.type === 'password' ? 'text' : 'password';
        } }, icon('eye', 14)),
      ),
      el('div', { class: 'field-help' }, 'Đã lưu sẽ hiện dạng AIza•••XXX'),
    ),
    el('div', { style: { display: 'flex', gap: '8px' } },
      el('button', { class: 'btn btn-primary', id: 'st-save' }, icon('check'), 'Lưu'),
      el('button', { class: 'btn', id: 'st-test' }, icon('sparkles'), 'Test Gemini'),
    ),
  );
  layout.appendChild(apiCard);

  // Output folder + app info
  const infoCard = el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Hệ thống'),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Thư mục output'),
      el('input', { class: 'input', id: 'st-folder', readonly: 'true' }),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Tỉ lệ mặc định'),
      el('select', { class: 'select', id: 'st-aspect' },
        ...['16:9', '9:16', '1:1', '4:3', '3:4'].map(r => el('option', { value: r }, r)),
      ),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Chất lượng mặc định'),
      el('select', { class: 'select', id: 'st-quality' },
        el('option', { value: 'lite_lp' }, 'Veo 3.1 — Lite [Lower Priority] · Miễn phí'),
        el('option', { value: 'lite' },    'Veo 3.1 — Lite · 5 credit'),
        el('option', { value: 'fast' },    'Veo 3.1 — Fast · 10 credit'),
        el('option', { value: 'quality' }, 'Veo 3.1 — Quality · 100 credit'),
      ),
    ),
    el('div', { class: 'field-group' },
      el('label', {
        class: 'field-label',
        style: { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' },
      },
        el('label', { class: 'toggle' },
          el('input', { type: 'checkbox', id: 'st-autosave' }),
          el('span', { class: 'toggle-track' }),
        ),
        el('span', null, 'Tự lưu file đã tạo vào thư mục outputs/'),
      ),
      el('div', { class: 'field-help' },
        'Bật: video/ảnh tự lưu vĩnh viễn vào outputs/. '
        + 'Tắt: lưu tạm vào outputs/_pending/ (auto dọn dẹp sau 24h) — '
        + 'bạn chủ động chọn file muốn giữ qua nút "Lưu vào outputs" ở gallery.'),
    ),
    el('button', { class: 'btn btn-primary', id: 'st-save2' }, icon('check'), 'Lưu hệ thống'),
  );
  layout.appendChild(infoCard);

  // App info row (full width)
  const appInfo = el('div', { class: 'card', style: { gridColumn: '1 / -1' } },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Về RedOne Creative'),
      el('button', { class: 'btn btn-sm', id: 'st-check-update' },
        icon('refresh', 14), 'Kiểm tra cập nhật'),
    ),
    el('div', { id: 'st-about', class: 'field-help' }, 'Đang tải...'),
    el('div', { id: 'st-update-result', style: { marginTop: '10px' } }),
  );
  layout.appendChild(appInfo);

  // Logs (full width)
  const logsCard = el('div', { class: 'card', style: { gridColumn: '1 / -1' } },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Logs ứng dụng'),
      el('button', { class: 'btn btn-sm', id: 'st-refresh-logs' }, icon('refresh', 14), 'Refresh'),
    ),
    el('div', { class: 'log-viewer', id: 'st-logs' }, 'Đang tải logs...'),
  );
  layout.appendChild(logsCard);

  // Load
  async function load() {
    try {
      const r = await api.settings.get();
      const s = r.settings || {};
      if (s.gemini_api_key_masked) {
        root.querySelector('#st-gemini').placeholder = s.gemini_api_key_masked;
      }
      root.querySelector('#st-folder').value = r.app.output_dir || '';
      root.querySelector('#st-aspect').value = s.default_aspect || '16:9';
      root.querySelector('#st-quality').value = s.default_quality || 'fast';
      const autosave = s.auto_save_outputs === undefined ? true : !!s.auto_save_outputs;
      root.querySelector('#st-autosave').checked = autosave;
      // Fetch system info (includes GitHub repo + paths)
      let sysInfo = {};
      try { sysInfo = await api.system.info(); } catch (e) { /* ignore */ }
      const repoUrl = sysInfo.github_url || '';
      root.querySelector('#st-about').innerHTML =
        `<b>${r.app.name}</b> v${r.app.version} • Python ${r.app.python}` +
        (sysInfo.frozen ? ' • <span style="color:var(--brand)">Đóng gói EXE</span>' : ' • dev mode') +
        `<br>Output: <code>${r.app.output_dir}</code>` +
        (repoUrl ? `<br>GitHub: <a href="${repoUrl}" target="_blank">${repoUrl}</a>` : '');
      await refreshLogs();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function refreshLogs() {
    try {
      const r = await api.settings.logs(150);
      const wrap = root.querySelector('#st-logs');
      wrap.innerHTML = '';
      (r.lines || []).forEach(line => {
        const cls = /ERROR/.test(line) ? 'error' : /WARN/.test(line) ? 'warn' : /INFO/.test(line) ? 'info' : '';
        wrap.appendChild(el('div', { class: `log-line ${cls}` }, line));
      });
    } catch (e) { /* ignore */ }
  }

  async function syncStoreSettings() {
    // Re-fetch settings into the global store so every page sees changes
    // without needing F5.
    try {
      const r = await api.settings.get();
      if (window.__app?.store) {
        window.__app.store.settings = r.settings || {};
      }
    } catch (e) { /* non-fatal */ }
  }

  root.querySelector('#st-save').addEventListener('click', async () => {
    const key = root.querySelector('#st-gemini').value.trim();
    if (!key) return toast('Nhập key trước', 'warning');
    try {
      await api.settings.update({ gemini_api_key: key });
      toast('Đã lưu API key', 'success');
      root.querySelector('#st-gemini').value = '';
      await syncStoreSettings();
      await load();
    } catch (e) { toast(e.message, 'error'); }
  });
  root.querySelector('#st-test').addEventListener('click', async () => {
    const btn = root.querySelector('#st-test');
    setLoading(btn, true);
    try {
      const r = await api.settings.testGemini();
      if (r.ok) toast(`Gemini OK • ${r.model}`, 'success');
      else toast(`Test fail: ${r.error}`, 'error');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  });
  root.querySelector('#st-save2').addEventListener('click', async () => {
    try {
      await api.settings.update({
        default_aspect: root.querySelector('#st-aspect').value,
        default_quality: root.querySelector('#st-quality').value,
        auto_save_outputs: root.querySelector('#st-autosave').checked,
      });
      // Sync into in-memory store so newly-opened pages pick up the changes.
      // Pages already initialized keep their form values (intentional — user's
      // explicit choices shouldn't be clobbered by changing the default).
      await syncStoreSettings();
      toast('Đã lưu — áp dụng cho các task tạo mới', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  root.querySelector('#st-refresh-logs').addEventListener('click', refreshLogs);

  root.querySelector('#st-check-update').addEventListener('click', async () => {
    const btn = root.querySelector('#st-check-update');
    setLoading(btn, true);
    const wrap = root.querySelector('#st-update-result');
    wrap.innerHTML = '';
    try {
      const r = await api.system.checkUpdate(true);
      if (r.error) {
        wrap.appendChild(el('div', { class: 'ai-banner warning' },
          el('div', null, `Không kiểm tra được: ${r.error}`)));
      } else if (r.update_available) {
        wrap.appendChild(el('div', { class: 'ai-banner success' },
          el('div', null,
            el('div', null, `Có bản mới: v${r.latest} (đang dùng v${r.current})`),
            r.release_notes ? el('div', { style: { fontSize: '11.5px', marginTop: '4px', whiteSpace: 'pre-wrap', maxHeight: '120px', overflowY: 'auto' } }, r.release_notes) : null,
          ),
          el('a', { href: r.download_url || r.release_url, target: '_blank', class: 'btn btn-sm btn-primary' },
            icon('download', 14), 'Tải về'),
        ));
      } else {
        wrap.appendChild(el('div', { class: 'ai-banner success' },
          el('div', null, `Đã ở phiên bản mới nhất: v${r.current}`)));
      }
    } catch (e) {
      wrap.appendChild(el('div', { class: 'ai-banner error' }, el('div', null, e.message)));
    } finally {
      setLoading(btn, false);
    }
  });

  load();
}
