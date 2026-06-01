// App entry — router + state + global UI wiring
//
// Cache-busting strategy:
//   The HTML <script> tag has ?b=<BUILD_ID>, which changes every server restart.
//   Combined with the server's `Cache-Control: no-store` header on /static,
//   F5 always pulls fresh JS. All sub-imports use canonical URLs (no query
//   param) so the ES module registry stores a SINGLE instance per file —
//   crucial for tasks_store.js which holds shared in-memory state.

import { api } from './api.js';
import { ws } from './ws.js';
import { $, $$, el, clear, toast } from './ui.js';
// Side-effect import: wires WS → global tasks store BEFORE page modules import it.
import './tasks_store.js';

import { renderContent } from './pages/content.js';
import { renderImage } from './pages/image.js';
import { renderShakker } from './pages/shakker.js';
import { renderLongVideo } from './pages/long_video.js';
import { renderYoutube } from './pages/youtube.js';
import { renderScript } from './pages/script.js';
import { renderImagePrompt } from './pages/image_prompt.js';
import { renderBgRemove } from './pages/bg_remove.js';
import { renderWatermark } from './pages/watermark.js';
import { renderVideoWatermark } from './pages/video_watermark.js';
import { renderUpscale } from './pages/upscale.js';
import { renderBatchResize } from './pages/batch_resize.js';
import { renderAudioMerge } from './pages/audio_merge.js';
import { renderSubtitle } from './pages/subtitle.js';
import { renderAccounts } from './pages/accounts.js';
import { renderSettings } from './pages/settings.js';
import { renderTasksManager } from './pages/tasks_manager.js';

// Build-id banner so you can verify which build is loaded
try {
  const BUST = new URL(import.meta.url).searchParams.get('b') || '?';
  console.log(`%c[RedOne] build=${BUST} loaded`, 'color:#dc2626;font-weight:600');
} catch {}

const PAGES = {
  'content':       { title: 'Tạo Video',         subtitle: 'Tạo video AI từ prompt (Text-to-Video / Image-to-Video)', render: renderContent },
  'image':         { title: 'Tạo Ảnh',           subtitle: 'Sinh ảnh AI bằng Nano Banana / Imagen qua Google Labs',  render: renderImage },
  'shakker':       { title: 'Ảnh Shakker',       subtitle: 'Sinh ảnh hàng loạt qua Shakker.ai — model + LoRA + ảnh tham chiếu', render: renderShakker },
  'long-video':    { title: 'Video Dài',         subtitle: 'Ghép N cảnh thành video dài liên tục bằng Extend API', render: renderLongVideo },
  'youtube':       { title: 'YouTube → Prompt',  subtitle: 'Phân tích YouTube / TikTok thành storyboard',            render: renderYoutube },
  'script':        { title: 'Ý Tưởng → Video',   subtitle: 'Từ kịch bản tiếng Việt sang storyboard chuẩn Veo 3',     render: renderScript },
  'image-prompt':  { title: 'Ảnh → Prompt',      subtitle: 'Phân tích ảnh và sinh prompt cho video',                 render: renderImagePrompt },
  'bg-remove':     { title: 'Tách Nền',          subtitle: 'Xóa background ảnh (rembg / Gemini)',                    render: renderBgRemove },
  'watermark':     { title: 'Xóa Logo / Watermark', subtitle: 'Xóa watermark khỏi ảnh (vẽ vùng + inpaint OpenCV)',  render: renderWatermark },
  'upscale':       { title: 'Upscale Ảnh',       subtitle: 'Phóng to ảnh giữ nét',                                   render: renderUpscale },
  'batch-resize':  { title: 'Resize Hàng Loạt',  subtitle: 'Đổi kích thước nhiều ảnh theo preset',                   render: renderBatchResize },
  'audio-merge':   { title: 'Ghép Audio',        subtitle: 'Ghép âm thanh vào video bằng FFmpeg',                    render: renderAudioMerge },
  'subtitle':      { title: 'Tạo Phụ Đề',        subtitle: 'Sinh phụ đề SRT từ video bằng Whisper',                  render: renderSubtitle },
  'video-watermark': { title: 'Xóa Watermark Video', subtitle: 'Xóa logo Veo / watermark khỏi nhiều video một lúc', render: renderVideoWatermark },
  'tasks':         { title: 'Quản lý Task',      subtitle: 'Theo dõi tiến độ + hàng đợi tất cả tác vụ',              render: renderTasksManager },
  'accounts':      { title: 'Tài Khoản',         subtitle: 'Quản lý Google account & credits',                       render: renderAccounts },
  'settings':      { title: 'Cài Đặt',           subtitle: 'API keys, thư mục, tùy chọn',                            render: renderSettings },
};

export const store = {
  accounts: [],
  settings: {},
  app: { name: 'RedOne Creative', version: '1.0.0' },
  totalCredits: 0,
};

export function navigate(pageId, opts = {}) {
  const page = PAGES[pageId];
  if (!page) return;
  // Optional deep-link to a specific task — pages that show task gallery
  // (content, image, long-video) consume this on mount, then clear it.
  // Used by Tasks Manager's "eye" button so clicking an older task takes
  // the user to the page WITH that task loaded, not the latest one.
  if (opts.taskId != null) {
    window.__app._pendingTaskId = opts.taskId;
  }
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === pageId));
  $('#page-title').textContent = page.title;
  $('#page-subtitle').textContent = page.subtitle;
  const container = $('#page-container');
  clear(container);
  container.classList.add('fade-in');
  setTimeout(() => container.classList.remove('fade-in'), 350);
  try {
    page.render(container);
  } catch (e) {
    console.error('Page render error:', e);
    container.appendChild(el('div', { class: 'card' }, `Lỗi render trang: ${e.message}`));
  }
  history.replaceState(null, '', `#${pageId}`);
}

async function refreshAccounts() {
  try {
    const data = await api.accounts.list();
    store.accounts = data.accounts || [];
    const enabledCount = store.accounts.filter(a => a.enabled).length;
    const total = store.accounts.reduce((sum, a) => sum + (a.credit || 0), 0);
    store.totalCredits = total;
    $('#topbar-account-count').textContent = enabledCount;
    $('#topbar-credits').textContent = total.toLocaleString('vi-VN');
  } catch (e) {
    console.warn('Failed to load accounts:', e.message);
  }
}

async function loadSettings() {
  try {
    const data = await api.settings.get();
    store.settings = data.settings || {};
    store.app = data.app || store.app;
    $('#app-version').textContent = store.app.version;
  } catch (e) { console.warn(e); }
}

/**
 * Auto-scan all accounts on tool login: refresh Flow credit + session status
 * so the user doesn't have to click "Check" on each account manually.
 *
 * Fire-and-forget — never blocks the UI. The backend broadcasts
 * `account_updated` per account, which the accounts page + topbar consume
 * live; we also re-run refreshAccounts() at the end to roll up the totals.
 *
 * Guards:
 *  - Skip in playwright mode: check-all there spawns a browser per account,
 *    a heavy/surprising side-effect to trigger automatically on every open.
 *  - Skip when there are no accounts (e.g. Vertex / fresh machines) — nothing
 *    to scan, and Vertex bills per-call with no credit counter anyway.
 *
 * Runs after a short delay so that, in extension mode, the Chrome extension
 * has a moment to connect before we ask it to fetch credits.
 */
function autoScanAccounts() {
  try {
    const mode = (store.settings && store.settings.auth_mode) || '';
    if (mode === 'playwright') return;
    const accounts = store.accounts || [];
    if (!accounts.length) return;
    setTimeout(() => {
      api.accounts.checkAll()
        .then(() => refreshAccounts())
        .catch((e) => console.warn('Auto-scan accounts failed:', e && e.message));
    }, 3500);
  } catch (e) {
    console.warn('autoScanAccounts error:', e);
  }
}

function setupSidebar() {
  $$('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });
}

function setupTheme() {
  const KEY = 'redone_theme';
  const label = $('#theme-toggle-label');
  const btn = $('#theme-toggle');
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(KEY, theme);
    if (label) label.textContent = theme === 'dark' ? 'Dark Mode' : 'Light Mode';
  }
  const current = localStorage.getItem(KEY) || 'light';
  apply(current);
  if (btn) {
    btn.addEventListener('click', () => {
      const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      apply(t);
    });
  }
}

// Shutdown button (topbar). Confirms before killing the backend so an
// accidental click doesn't trash an in-flight task.
function setupAuthUI() {
  // Inject a tiny "logged in as X — logout" chip into the topbar actions
  // row so users can see who they are + sign out. Skipped silently if
  // there's no user info (offline boot, OAuth not configured, etc).
  const user = window.__app && window.__app.user;
  if (!user || !user.email) return;
  const actions = $('.topbar-actions') || $('.topbar-right');
  if (!actions) return;
  if ($('#auth-chip')) return;   // already injected

  const chip = document.createElement('div');
  chip.id = 'auth-chip';
  chip.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:4px 8px 4px 4px;' +
    'background:rgba(255,255,255,0.04);border:1px solid var(--border);' +
    'border-radius:18px;font-size:11.5px;color:var(--text-muted);' +
    'cursor:pointer;transition:background 0.15s;margin-right:6px;';
  chip.title = `Đăng nhập: ${user.email}\nClick để đăng xuất`;
  chip.onmouseover = () => chip.style.background = 'rgba(255,255,255,0.08)';
  chip.onmouseout = () => chip.style.background = 'rgba(255,255,255,0.04)';

  if (user.picture) {
    const img = document.createElement('img');
    img.src = user.picture;
    img.style.cssText = 'width:22px;height:22px;border-radius:50%;';
    chip.appendChild(img);
  }
  const label = document.createElement('span');
  // Show just the local part of the email to save space, full email in tooltip
  label.textContent = (user.email || '').split('@')[0];
  chip.appendChild(label);

  chip.addEventListener('click', async () => {
    const { confirm } = await import('./ui.js');
    if (!await confirm(
      `Đăng xuất khỏi RedOne Creative?\nTài khoản: ${user.email}`,
      'Xác nhận đăng xuất',
    )) return;
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch (e) { /* ignore */ }
    window.location.replace('/login.html');
  });

  // Insert before the theme toggle / shutdown buttons so it appears
  // on the left side of the action cluster.
  actions.insertBefore(chip, actions.firstChild);
}


function setupShutdown() {
  const btn = $('#shutdown-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const { confirm } = await import('./ui.js');
    if (!await confirm(
      'Tắt tool sẽ dừng backend Python + giải phóng port 8000. '
      + 'Các task đang chạy sẽ bị huỷ. Tiếp tục?',
      'Xác nhận tắt tool',
    )) return;
    try {
      await api.system.shutdown();
      toast('Đang tắt tool — trang sẽ trở thành "không kết nối được"', 'info');
      // Backend dies in ~0.5s. Replace the entire page with a clear
      // "tool is gone" message so the user doesn't sit waiting for the
      // usual loading spinner.
      setTimeout(() => {
        document.body.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;'
          + 'height:100vh;font-family:sans-serif;color:#666;text-align:center;'
          + 'padding:20px;background:#fff">'
          + '<div><h2 style="color:#dc2626;margin-bottom:12px">'
          + 'RedOne Creative đã tắt</h2>'
          + '<p>Có thể đóng tab này. Để mở lại tool, double-click '
          + '<code>RedOne Creative.exe</code> hoặc chạy <code>python launch.py</code>.</p>'
          + '</div></div>';
      }, 1500);
    } catch (e) {
      toast(e.message || 'Tắt tool lỗi', 'error');
    }
  });
}

function showSessionDeadBanner(d) {
  const banner = $('#session-banner');
  if (!banner) return;
  banner.classList.remove('hidden');
  banner.innerHTML = '';
  banner.appendChild(el('div', { style: { flex: 1 } },
    el('strong', null, '⚠ Session hết hạn: '),
    el('span', { class: 'mono', style: { background: 'rgba(255,255,255,0.18)', padding: '2px 8px', borderRadius: '99px', margin: '0 4px' } }, d.email || `account #${d.account_id}`),
    ' — ',
    (d.reason || 'cần login lại để tiếp tục'),
  ));
  banner.appendChild(el('button', {
    class: 'btn',
    onclick: async () => {
      window.__app.navigate('accounts');
      banner.classList.add('hidden');
    },
  }, 'Mở tab Tài Khoản'));
  banner.appendChild(el('button', {
    class: 'btn btn-close',
    onclick: () => banner.classList.add('hidden'),
  }, '✕'));
}

function setupWS() {
  ws.start();
  ws.on('_connected', () => {
    $('#server-dot').className = 'dot dot-green';
    $('#server-status').textContent = 'Đã kết nối';
  });
  ws.on('_disconnected', () => {
    $('#server-dot').className = 'dot dot-red';
    $('#server-status').textContent = 'Mất kết nối';
  });
  ws.on('account_updated', refreshAccounts);
  ws.on('account_added', refreshAccounts);
  ws.on('account_deleted', refreshAccounts);
  ws.on('account_session_dead', (d) => {
    refreshAccounts();
    showSessionDeadBanner(d || {});
    toast(`Session ${d?.email || ''} hết hạn — login lại trong tab Tài Khoản`, 'error', 10000);
  });
}

async function checkForUpdate() {
  try {
    const r = await api.system.checkUpdate();
    if (!r || !r.update_available) return;

    // Suppress same banner the user already dismissed for this exact version
    const dismissed = localStorage.getItem('redone_dismissed_update');
    if (dismissed === r.latest) return;

    const banner = $('#update-banner');
    if (!banner) return;
    banner.classList.remove('hidden');
    banner.innerHTML = '';

    const text = el('div', { class: 'update-text' },
      '🎉 Có bản cập nhật mới ',
      el('span', { class: 'update-version' }, `v${r.latest}`),
      ` — bạn đang dùng v${r.current}`,
    );

    // EXE bundle: in-app installer. Dev mode: just point to GitHub.
    const canAutoInstall = !!(r.can_auto_install && r.download_url);
    const actionBtn = canAutoInstall
      ? el('button', {
          class: 'btn',
          onclick: () => openUpdateModal(r),
        }, 'Tải xuống & cài đặt')
      : el('a', {
          class: 'btn',
          href: r.download_url || r.release_url
            || `https://github.com/${r.github_repo || ''}/releases`,
          target: '_blank', rel: 'noopener',
        }, 'Mở GitHub Release');

    const closeBtn = el('button', {
      class: 'btn btn-close',
      title: 'Bỏ qua phiên bản này',
      onclick: () => {
        localStorage.setItem('redone_dismissed_update', r.latest);
        banner.classList.add('hidden');
      },
    }, '✕');

    banner.appendChild(text);
    banner.appendChild(actionBtn);
    banner.appendChild(closeBtn);
  } catch (e) {
    // Silent — update check is non-critical
    console.warn('Update check failed:', e.message);
  }
}


// ── In-app updater modal ─────────────────────────────────────────
// Opens when user clicks the banner's "Tải xuống & cài đặt" button.
// One modal handles: start → progress → ready-to-install → restart.
// Listens to WS "update_progress" events broadcast by the backend updater.

let _updateModalState = null;   // {root, bar, label, stage, version, action}
let _updateUnsub = null;

function openUpdateModal(info) {
  // If already open, just show it
  if (_updateModalState) {
    _updateModalState.root.classList.remove('hidden');
    return;
  }

  const root = el('div', { class: 'modal-backdrop', style: { display: 'flex' } });
  const card = el('div', { class: 'modal', style: { maxWidth: '560px' } });
  root.appendChild(card);
  document.body.appendChild(root);

  card.appendChild(el('h3', { class: 'modal-title' },
    `Cập nhật RedOne Creative v${info.latest}`));

  // Release notes preview
  if (info.release_notes) {
    card.appendChild(el('div', {
      class: 'field-help',
      style: {
        maxHeight: '160px', overflowY: 'auto',
        background: 'var(--bg-2)', padding: '10px',
        borderRadius: 'var(--r-md)', whiteSpace: 'pre-wrap',
        marginBottom: '14px', fontSize: '12px',
      },
    }, info.release_notes));
  }

  // Status line + progress bar
  const label = el('div', { class: 'field-label' }, 'Sẵn sàng tải xuống');
  const sizeMB = info.asset_size
    ? `(${(info.asset_size / 1024 / 1024).toFixed(1)} MB)`
    : '';
  const sub = el('div', { class: 'field-help' },
    `Sẽ tải ${info.asset_name || 'release.zip'} ${sizeMB} từ GitHub. `
    + `Dữ liệu của bạn (data/, outputs/) sẽ KHÔNG bị xóa.`);
  const barWrap = el('div', {
    style: {
      marginTop: '12px', height: '10px', background: 'var(--bg-2)',
      borderRadius: '5px', overflow: 'hidden',
    },
  });
  const bar = el('div', {
    style: {
      height: '100%', width: '0%', background: 'var(--brand)',
      transition: 'width 0.3s',
    },
  });
  barWrap.appendChild(bar);

  card.appendChild(label);
  card.appendChild(sub);
  card.appendChild(barWrap);

  // Action button — starts as "Tải xuống", morphs to "Cài đặt & restart"
  // or "Đóng" depending on stage.
  const actionBtn = el('button', { class: 'btn btn-primary' }, 'Tải xuống');
  const closeBtn = el('button', { class: 'btn btn-ghost' }, 'Đóng');
  const actionsRow = el('div', {
    style: { display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' },
  }, closeBtn, actionBtn);
  card.appendChild(actionsRow);

  _updateModalState = { root, bar, label, sub, stage: 'idle',
    version: info.latest, action: actionBtn, info };

  // Wire WS subscription (lazy import avoids circular dep)
  import('./ws.js').then(({ ws }) => {
    if (_updateUnsub) { _updateUnsub(); _updateUnsub = null; }
    _updateUnsub = ws.on('update_progress', (state) => {
      if (!_updateModalState) return;
      applyUpdateState(state);
    });
  });

  // Fetch latest state in case download was already running (e.g. user
  // reloaded the page mid-download)
  api.system.updateState().then(s => {
    if (s && s.stage !== 'idle') applyUpdateState(s);
  }).catch(() => {});

  actionBtn.addEventListener('click', async () => {
    const st = _updateModalState;
    if (!st) return;
    if (st.stage === 'idle' || st.stage === 'error') {
      // Start download
      actionBtn.disabled = true;
      st.label.textContent = 'Đang gửi yêu cầu…';
      try {
        await api.system.startUpdate();
        // WS events will drive the bar from here
      } catch (e) {
        st.label.textContent = `Lỗi: ${e.message}`;
        actionBtn.disabled = false;
      }
    } else if (st.stage === 'ready') {
      // Install + restart
      actionBtn.disabled = true;
      actionBtn.textContent = 'Đang khởi động lại…';
      st.label.textContent = 'Đang cài đặt — app sẽ tự mở lại trong vài giây';
      try {
        await api.system.applyUpdate();
        // Backend will die. Show a "lost connection" hint after a beat.
        setTimeout(() => {
          st.sub.innerHTML = '';
          st.sub.appendChild(el('div', {
            style: { color: 'var(--brand)' },
          }, '✓ Đã chạy installer. Tool đang khởi động lại — đợi 5-10s rồi mở lại trình duyệt nếu cần.'));
        }, 1500);
      } catch (e) {
        st.label.textContent = `Lỗi: ${e.message}`;
        actionBtn.disabled = false;
        actionBtn.textContent = 'Thử lại';
      }
    }
  });

  closeBtn.addEventListener('click', () => {
    // Allow closing only when not actively downloading — avoids accidental
    // mid-download dismissals. The job continues in backend regardless,
    // so closing the modal isn't destructive.
    closeUpdateModal();
  });
}

function applyUpdateState(state) {
  if (!_updateModalState) return;
  const st = _updateModalState;
  st.stage = state.stage;
  const pct = state.percent || 0;
  st.bar.style.width = `${pct}%`;
  st.label.textContent = state.message || state.stage;

  if (state.stage === 'downloading') {
    const mbDone = (state.downloaded / 1024 / 1024).toFixed(1);
    const mbTotal = state.total ? (state.total / 1024 / 1024).toFixed(1) : '?';
    st.label.textContent = `Đang tải ${mbDone} / ${mbTotal} MB (${pct.toFixed(0)}%)`;
    st.action.disabled = true;
    st.action.textContent = 'Đang tải…';
  } else if (state.stage === 'extracting') {
    st.bar.style.background = 'var(--accent-orange)';
    st.action.disabled = true;
    st.action.textContent = 'Đang giải nén…';
  } else if (state.stage === 'ready') {
    st.bar.style.background = 'var(--green)';
    st.action.disabled = false;
    st.action.textContent = 'Cài đặt & khởi động lại';
  } else if (state.stage === 'installing') {
    st.bar.style.background = 'var(--brand)';
    st.action.disabled = true;
    st.action.textContent = 'Đang cài…';
  } else if (state.stage === 'error') {
    st.bar.style.background = 'var(--red)';
    st.action.disabled = false;
    st.action.textContent = 'Thử lại';
  }
}

function closeUpdateModal() {
  if (!_updateModalState) return;
  _updateModalState.root.remove();
  _updateModalState = null;
  if (_updateUnsub) { _updateUnsub(); _updateUnsub = null; }
}

async function init() {
  // Auth gate — before anything else. If not logged in, bounce to
  // /login.html instead of rendering the empty app shell. The backend
  // also enforces this server-side, but doing it client-side too means
  // the UI never flashes "loading" then "redirect".
  try {
    const r = await fetch('/auth/me');
    const data = await r.json();
    if (data && data.oauth_configured !== false && !data.logged_in) {
      window.location.replace('/login.html');
      return;
    }
    if (data && data.email) {
      // Stash the logged-in user on the global app object so other
      // pages (e.g. Settings) can read it without re-fetching.
      window.__app = window.__app || {};
      window.__app.user = data;
    }
  } catch (e) {
    // Backend offline — let init continue; downstream API calls will
    // surface the connection error themselves.
    console.warn('Auth probe failed:', e);
  }

  setupTheme();
  setupShutdown();
  setupAuthUI();
  setupSidebar();
  setupWS();

  // First-run setup wizard. Blocks the rest of init() until the user
  // completes (or the backend reports everything is already in place).
  // Skipping this would let the watermark video page render with missing
  // deps, leading to confusing error toasts later.
  try {
    const { maybeRunSetupWizard } = await import('./setup_wizard.js');
    await maybeRunSetupWizard();
  } catch (e) {
    console.warn('Setup wizard failed:', e);
    // Non-blocking: if the wizard itself errors out, let the app boot
    // and the user can still try to use OpenCV features.
  }

  await Promise.all([refreshAccounts(), loadSettings()]);

  // Auto-scan accounts (Flow credit + session) once per tool open. Runs after
  // settings + accounts are loaded so it can honour the auth_mode guard.
  autoScanAccounts();

  const initialPage = (location.hash || '#content').slice(1);
  navigate(PAGES[initialPage] ? initialPage : 'content');

  // Non-blocking update check
  checkForUpdate();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.__app = { store, navigate, refreshAccounts };
