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
      'Gemini API key dùng cho tạo prompt (Ý tưởng/YouTube/Ảnh) + Storyboard. Lấy ở https://aistudio.google.com/apikey'),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Gemini API Keys (mỗi dòng 1 key)'),
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        el('textarea', {
          class: 'textarea', id: 'st-gemini', rows: 4,
          placeholder: 'AIza...\nAIza...\nAIza...',
          style: { webkitTextSecurity: 'disc', fontFamily: 'monospace', fontSize: '12px' },
        }),
        el('button', { class: 'btn', id: 'st-toggle', title: 'Hiện/ẩn key', onclick: () => {
          const inp = root.querySelector('#st-gemini');
          inp.style.webkitTextSecurity = inp.style.webkitTextSecurity === 'disc' ? 'none' : 'disc';
        } }, icon('eye', 14)),
      ),
      el('div', { class: 'field-help' },
        'Nhập nhiều key (mỗi dòng 1 key). Khi 1 key hết hạn mức (quota free), '
        + 'tool tự chuyển sang key kế tiếp. Hết tất cả → báo lỗi rõ ràng.'),
      el('div', { class: 'field-help', style: { color: 'var(--accent-orange)', marginTop: '4px' } },
        '⚠️ Lưu ý: mỗi key nên lấy từ một TÀI KHOẢN GOOGLE KHÁC NHAU. '
        + 'Các key cùng một tài khoản dùng chung quota → xoay vòng sẽ vô nghĩa.'),
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
        el('option', { value: 'lite_lp' }, 'Veo 3.1 Lite · Miễn phí (chậm)'),
        el('option', { value: 'lite' },    'Veo 3.1 Lite · 5 credit'),
        el('option', { value: 'fast' },    'Veo 3.1 Fast · 10 credit'),
        el('option', { value: 'quality' }, 'Veo 3.1 Quality · 100 credit'),
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
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Chế độ kết nối'),
      el('div', { class: 'field-help' },
        'Tool dùng cố định Chrome Extension Bridge: token + cookies lấy từ '
        + 'Chrome thật của bạn → Google không flag bot, dùng quota Labs Flow miễn phí. '
        + 'Cần cài extension "RedOne Auth Helper" (thư mục extension/ — Chrome > Extensions > Load unpacked).'),
      el('div', { id: 'st-bridge-status', style: { marginTop: '6px' } }),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Đợi giữa các đợt gen (giây)'),
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        el('input', {
          type: 'number', class: 'input', id: 'st-cooldown-min',
          min: '0', max: '300', step: '1', style: { width: '100px' },
          placeholder: '5',
        }),
        el('span', { style: { color: 'var(--muted)' } }, '→'),
        el('input', {
          type: 'number', class: 'input', id: 'st-cooldown-max',
          min: '0', max: '300', step: '1', style: { width: '100px' },
          placeholder: '10',
        }),
        el('span', { style: { color: 'var(--muted)' } }, 'giây'),
      ),
      el('div', { class: 'field-help' },
        'Sau mỗi đợt gen (= số luồng song song), tool đợi ngẫu nhiên trong '
        + 'khoảng này rồi mới gen tiếp đợt sau. Mặc định 5–10s — giúp giảm '
        + 'tỉ lệ Google flag 403. Để 0–0 nếu muốn gen liên tục.'),
    ),
    el('button', { class: 'btn btn-primary', id: 'st-save2' }, icon('check'), 'Lưu hệ thống'),
  );
  layout.appendChild(infoCard);

  // App info row (full width). "Tắt tool" used to live here too but moved
  // to the topbar (always-visible icon) so user doesn't have to navigate
  // here just to shut down.
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
      // Fill the textarea with the saved keys (one per line) so the list is
      // directly editable. Masked-by-default via CSS; toggle with the eye icon.
      const gkeys = Array.isArray(s.gemini_api_keys) ? s.gemini_api_keys : [];
      const gta = root.querySelector('#st-gemini');
      if (gta) gta.value = gkeys.join('\n');
      root.querySelector('#st-folder').value = r.app.output_dir || '';
      root.querySelector('#st-aspect').value = s.default_aspect || '16:9';
      root.querySelector('#st-quality').value = s.default_quality || 'lite_lp';
      const autosave = s.auto_save_outputs === undefined ? true : !!s.auto_save_outputs;
      root.querySelector('#st-autosave').checked = autosave;
      // Live extension status — poll once on load
      try {
        const br = await fetch('/sync/state').then(r => r.json());
        const stWrap = root.querySelector('#st-bridge-status');
        if (stWrap) {
          stWrap.innerHTML = '';
          if (br.extension_live) {
            stWrap.appendChild(el('div', { class: 'chip chip-green' },
              `✓ Extension đã kết nối · Chrome tab: ${br.last_tab_status}`));
          } else {
            stWrap.appendChild(el('div', { class: 'chip chip-yellow' },
              'Extension chưa kết nối — cài extension và mở Chrome có tab labs.google'));
          }
        }
      } catch (e) { /* ignore */ }
      // Cooldown range — fall back to defaults if user hasn't set yet
      const cdMin = (s.batch_cooldown_min_seconds ?? 5);
      const cdMax = (s.batch_cooldown_max_seconds ?? 10);
      root.querySelector('#st-cooldown-min').value = cdMin;
      root.querySelector('#st-cooldown-max').value = cdMax;
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
    const raw = root.querySelector('#st-gemini').value || '';
    const keys = raw.split('\n').map(k => k.trim()).filter(Boolean);
    if (!keys.length) return toast('Nhập ít nhất 1 key', 'warning');
    try {
      await api.settings.update({ gemini_api_keys: keys });
      toast(`Đã lưu ${keys.length} API key`, 'success');
      await syncStoreSettings();
      await load();   // refills the textarea from the server (trimmed/deduped)
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
      // Parse cooldown range. Empty / NaN → server default. We also
      // silently swap if user typed them backwards (max < min) to match
      // backend behavior.
      let cdMin = parseInt(root.querySelector('#st-cooldown-min').value, 10);
      let cdMax = parseInt(root.querySelector('#st-cooldown-max').value, 10);
      if (Number.isNaN(cdMin) || cdMin < 0) cdMin = 0;
      if (Number.isNaN(cdMax) || cdMax < 0) cdMax = 0;
      if (cdMax < cdMin) { const t = cdMin; cdMin = cdMax; cdMax = t; }

      const payload = {
        default_aspect: root.querySelector('#st-aspect').value,
        default_quality: root.querySelector('#st-quality').value,
        auto_save_outputs: root.querySelector('#st-autosave').checked,
        auth_mode: 'extension',   // only mode now — overwrites any legacy vertex/playwright value
        batch_cooldown_min_seconds: cdMin,
        batch_cooldown_max_seconds: cdMax,
      };
      await api.settings.update(payload);
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
