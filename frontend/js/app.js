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
import { renderLongVideo } from './pages/long_video.js';
import { renderYoutube } from './pages/youtube.js';
import { renderScript } from './pages/script.js';
import { renderImagePrompt } from './pages/image_prompt.js';
import { renderBgRemove } from './pages/bg_remove.js';
import { renderWatermark } from './pages/watermark.js';
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
  'long-video':    { title: 'Video Dài',         subtitle: 'Ghép N cảnh thành video dài liên tục bằng Extend API', render: renderLongVideo },
  'youtube':       { title: 'YouTube → Prompt',  subtitle: 'Phân tích YouTube / TikTok thành storyboard',            render: renderYoutube },
  'script':        { title: 'Ý Tưởng → Video',   subtitle: 'Từ kịch bản tiếng Việt sang storyboard chuẩn Veo 3',     render: renderScript },
  'image-prompt':  { title: 'Ảnh → Prompt',      subtitle: 'Phân tích ảnh và sinh prompt cho video',                 render: renderImagePrompt },
  'bg-remove':     { title: 'Tách Nền',          subtitle: 'Xóa background ảnh (rembg / Gemini)',                    render: renderBgRemove },
  'watermark':     { title: 'Xóa Logo / Watermark', subtitle: 'Xóa logo Veo / watermark khỏi ảnh / video',           render: renderWatermark },
  'upscale':       { title: 'Upscale Ảnh',       subtitle: 'Phóng to ảnh giữ nét',                                   render: renderUpscale },
  'batch-resize':  { title: 'Resize Hàng Loạt',  subtitle: 'Đổi kích thước nhiều ảnh theo preset',                   render: renderBatchResize },
  'audio-merge':   { title: 'Ghép Audio',        subtitle: 'Ghép âm thanh vào video bằng FFmpeg',                    render: renderAudioMerge },
  'subtitle':      { title: 'Tạo Phụ Đề',        subtitle: 'Sinh phụ đề SRT từ video bằng Whisper',                  render: renderSubtitle },
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

export function navigate(pageId) {
  const page = PAGES[pageId];
  if (!page) return;
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
    const dlBtn = el('a', {
      class: 'btn',
      href: r.download_url || r.release_url || `https://github.com/${r.github_repo || ''}/releases`,
      target: '_blank',
      rel: 'noopener',
    }, 'Tải bản mới');
    const closeBtn = el('button', {
      class: 'btn btn-close',
      title: 'Bỏ qua phiên bản này',
      onclick: () => {
        localStorage.setItem('redone_dismissed_update', r.latest);
        banner.classList.add('hidden');
      },
    }, '✕');

    banner.appendChild(text);
    banner.appendChild(dlBtn);
    banner.appendChild(closeBtn);
  } catch (e) {
    // Silent — update check is non-critical
    console.warn('Update check failed:', e.message);
  }
}

async function init() {
  setupTheme();
  setupSidebar();
  setupWS();
  await Promise.all([refreshAccounts(), loadSettings()]);

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
