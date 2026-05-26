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
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Auth mode'),
      el('select', { class: 'select', id: 'st-authmode' },
        el('option', { value: 'extension' }, 'Chrome Extension Bridge (Recommended — Free, ít 403)'),
        el('option', { value: 'playwright' }, 'Playwright/Cloak (Legacy — Free, hay 403)'),
        el('option', { value: 'vertex_api' }, 'Vertex AI Commercial (Paid — chuẩn enterprise, $0.04+ per call)'),
      ),
      el('div', { class: 'field-help' },
        'Extension Bridge: token + cookies tới từ Chrome thật → Google không flag bot. '
        + 'Cần cài extension "RedOne Auth Helper" (thư mục extension/ — Chrome > Extensions > Load unpacked). '
        + 'Vertex AI Commercial: bypass Labs Flow hoàn toàn, dùng Google Cloud trả phí — '
        + 'không cần Chrome, không 403, chất lượng tier paid.'),
      el('div', { id: 'st-bridge-status', style: { marginTop: '6px' } }),
    ),
    // Vertex AI config section — visible only when auth_mode = "vertex_api"
    el('div', { class: 'field-group', id: 'st-vertex-wrap', style: { display: 'none' } },
      el('div', {
        style: {
          padding: '12px', borderRadius: '8px', marginBottom: '12px',
          background: 'rgba(245,158,11,0.08)',
          border: '1px solid rgba(245,158,11,0.25)',
        },
      },
        el('div', { style: { fontWeight: 600, marginBottom: '6px' } },
          '⚡ Vertex AI Commercial mode'),
        el('div', { class: 'field-help', style: { lineHeight: '1.5' } },
          'Trả phí per call. Free trial $300 / 90 ngày cho project mới. ',
          el('br', null), null,
          'Models support: Nano Banana 2, Nano Banana Pro, Veo 3.1 Lite/Fast/Quality.',
          el('br', null), null,
          'KHÔNG support: Veo Lite [LP] (free queue), Omni Flash. ',
          el('a', {
            href: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
            target: '_blank', style: { color: 'var(--brand)' },
          }, 'Xem giá'),
        ),
      ),
      el('label', { class: 'field-label' }, 'API Key (cho image gen — Nano Banana)'),
      el('input', {
        type: 'password', class: 'input', id: 'st-vertex-apikey',
        placeholder: 'AIzaSy...',
      }),
      el('div', { class: 'field-help', style: { marginBottom: '12px' } },
        'Lấy ở Google Cloud Console → APIs & Services → Credentials → + Create credentials → API key. '
        + 'Restrict key: chỉ enable Vertex AI / Generative Language API.'),

      el('label', { class: 'field-label' }, 'Service Account JSON Path (cho video gen — Veo)'),
      el('input', {
        type: 'text', class: 'input', id: 'st-vertex-sapath',
        placeholder: 'C:\\Users\\Admin\\Documents\\redone-vertex-key.json',
      }),
      el('div', { class: 'field-help', style: { marginBottom: '12px' } },
        'Đường dẫn tới file JSON service account (Cloud Console → IAM → Service Accounts → KEYS → Add key → JSON). '
        + 'Service account cần role "Agent Platform User" + "Storage Object User".'),

      el('label', { class: 'field-label' }, 'Project ID'),
      el('input', {
        type: 'text', class: 'input', id: 'st-vertex-project',
        placeholder: 'my-project-123456',
      }),
      el('div', { class: 'field-help', style: { marginBottom: '12px' } },
        'Project ID (chuỗi text) — xem ở Google Cloud Console góc trên top bar.'),

      el('label', { class: 'field-label' }, 'Region'),
      el('select', { class: 'select', id: 'st-vertex-region' },
        el('option', { value: 'us-central1' }, 'us-central1 (Iowa — recommended)'),
        el('option', { value: 'europe-west4' }, 'europe-west4 (Netherlands)'),
        el('option', { value: 'asia-southeast1' }, 'asia-southeast1 (Singapore — gần VN nhất)'),
      ),
      el('div', { class: 'field-help' },
        'Region nào Vertex AI host model. us-central1 hỗ trợ nhiều model nhất + giá rẻ nhất.'),
    ),
    el('div', { class: 'field-group', id: 'st-backend-wrap' },
      el('label', { class: 'field-label' }, 'Trình duyệt sử dụng (chỉ khi Playwright)'),
      el('select', { class: 'select', id: 'st-backend' },
        el('option', { value: 'chrome' }, 'Google Chrome (mặc định)'),
        el('option', { value: 'cloak' }, 'CloakBrowser — Stealth Chromium (chống detect tốt hơn)'),
      ),
      el('div', { class: 'field-help', id: 'st-backend-help' },
        'Chuyển sang CloakBrowser nếu hay bị reCAPTCHA 403 / 429. Lần đầu sẽ auto-download binary ~200MB.'),
      el('div', { id: 'st-cloak-status', style: { marginTop: '6px' } }),
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
      if (s.gemini_api_key_masked) {
        root.querySelector('#st-gemini').placeholder = s.gemini_api_key_masked;
      }
      root.querySelector('#st-folder').value = r.app.output_dir || '';
      root.querySelector('#st-aspect').value = s.default_aspect || '16:9';
      root.querySelector('#st-quality').value = s.default_quality || 'fast';
      const autosave = s.auto_save_outputs === undefined ? true : !!s.auto_save_outputs;
      root.querySelector('#st-autosave').checked = autosave;
      const backend = (s.browser_backend || 'chrome').toLowerCase();
      root.querySelector('#st-backend').value = backend;
      // New: auth mode (default extension)
      const authMode = (s.auth_mode || 'extension').toLowerCase();
      root.querySelector('#st-authmode').value = authMode;
      // Show legacy browser dropdown only in playwright mode
      const wrap = root.querySelector('#st-backend-wrap');
      if (wrap) wrap.style.display = authMode === 'playwright' ? '' : 'none';
      // Show Vertex AI config only in vertex_api mode
      const vWrap = root.querySelector('#st-vertex-wrap');
      if (vWrap) vWrap.style.display = authMode === 'vertex_api' ? '' : 'none';
      // Vertex AI fields — masked key uses placeholder so user knows it's set
      if (s.vertex_api_key_masked) {
        root.querySelector('#st-vertex-apikey').placeholder = s.vertex_api_key_masked;
      }
      root.querySelector('#st-vertex-sapath').value = s.vertex_service_account_path || '';
      root.querySelector('#st-vertex-project').value = s.vertex_project_id || '';
      root.querySelector('#st-vertex-region').value = s.vertex_region || 'us-central1';

      // If private_config.py is providing the Vertex creds, lock the UI
      // fields and surface a hint so users don't think their edits are
      // being ignored.
      if (s.vertex_private_config_active) {
        for (const id of ['st-vertex-apikey', 'st-vertex-sapath',
                          'st-vertex-project', 'st-vertex-region']) {
          const elx = root.querySelector('#' + id);
          if (elx) {
            elx.disabled = true;
            elx.style.opacity = '0.6';
          }
        }
        const apiInput = root.querySelector('#st-vertex-apikey');
        if (apiInput) apiInput.placeholder = '✓ Loaded from private_config.py';
        // Add a banner in the Vertex section
        const vWrap2 = root.querySelector('#st-vertex-wrap');
        if (vWrap2 && !vWrap2.querySelector('.private-config-banner')) {
          const banner = el('div', {
            class: 'private-config-banner',
            style: {
              padding: '10px 14px', marginBottom: '12px',
              background: 'rgba(34, 197, 94, 0.1)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              borderRadius: '8px',
              fontSize: '12.5px',
              color: '#86efac',
            },
          },
            '✓ Vertex AI credentials đã được admin cấu hình sẵn trong ',
            el('code', null, 'private_config.py'),
            '. Các field dưới đây chỉ để tham khảo (không sửa được).',
          );
          vWrap2.insertBefore(banner, vWrap2.firstChild);
        }
      }

      // Live-toggle the Vertex section + Playwright section when user
      // changes the dropdown (no need to save first).
      root.querySelector('#st-authmode').addEventListener('change', (e) => {
        const m = e.target.value;
        if (wrap) wrap.style.display = m === 'playwright' ? '' : 'none';
        if (vWrap) vWrap.style.display = m === 'vertex_api' ? '' : 'none';
      });
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
      // Show Cloak install status under the dropdown
      try {
        const cs = await api.settings.cloakStatus();
        const wrap = root.querySelector('#st-cloak-status');
        wrap.innerHTML = '';
        if (cs.installed) {
          wrap.appendChild(el('div', { class: 'chip chip-green' },
            `✓ CloakBrowser v${cs.version || '?'} đã cài`));
        } else {
          wrap.appendChild(el('div', { class: 'chip chip-yellow' },
            'CloakBrowser chưa cài — sẽ báo lỗi nếu chọn'));
          wrap.appendChild(el('div', { class: 'field-help', style: { marginTop: '4px' } },
            'Cài: chạy `pip install cloakbrowser` trong terminal, rồi restart tool'));
        }
      } catch (e) { /* non-fatal */ }
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
      // Parse cooldown range. Empty / NaN → server default. We also
      // silently swap if user typed them backwards (max < min) to match
      // backend behavior.
      let cdMin = parseInt(root.querySelector('#st-cooldown-min').value, 10);
      let cdMax = parseInt(root.querySelector('#st-cooldown-max').value, 10);
      if (Number.isNaN(cdMin) || cdMin < 0) cdMin = 0;
      if (Number.isNaN(cdMax) || cdMax < 0) cdMax = 0;
      if (cdMax < cdMin) { const t = cdMin; cdMin = cdMax; cdMax = t; }

      // Vertex AI fields — only include API key if user typed a new value
      // (empty input means "keep existing key", not "clear it").
      const vertexApiKeyInput = root.querySelector('#st-vertex-apikey').value.trim();
      const payload = {
        default_aspect: root.querySelector('#st-aspect').value,
        default_quality: root.querySelector('#st-quality').value,
        auto_save_outputs: root.querySelector('#st-autosave').checked,
        browser_backend: root.querySelector('#st-backend').value,
        auth_mode: root.querySelector('#st-authmode').value,
        batch_cooldown_min_seconds: cdMin,
        batch_cooldown_max_seconds: cdMax,
        vertex_service_account_path: root.querySelector('#st-vertex-sapath').value.trim(),
        vertex_project_id: root.querySelector('#st-vertex-project').value.trim(),
        vertex_region: root.querySelector('#st-vertex-region').value,
      };
      if (vertexApiKeyInput) payload.vertex_api_key = vertexApiKeyInput;

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
