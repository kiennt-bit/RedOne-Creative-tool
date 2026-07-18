// UI helpers: toasts, modals, DOM utilities

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class' || k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (v === false || v == null) continue;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  }
  return node;
}

export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

// Wire drag-and-drop file upload onto a dropzone element so users can drop
// image/video/audio files instead of only click-to-select.
//   - `dz`     : the element that accepts drops (usually a `.dropzone`)
//   - `input`  : the hidden <input type=file>; on drop its files are set and a
//                `change` event fired, reusing the page's existing handler.
//   - `onFiles`: optional — when given, called with the dropped FileList
//                instead of the input flow (for custom targets/lists).
// `.dropzone` elements get their native `.dragover` highlight; other targets
// get a temporary dashed outline so the drop area is always visible.
export function wireDropzone(dz, input, onFiles) {
  if (!dz) return;
  const isDz = dz.classList && dz.classList.contains('dropzone');
  const on = (e) => {
    e.preventDefault(); e.stopPropagation();
    dz.classList.add('dragover');
    if (!isDz) { dz.style.outline = '2px dashed var(--brand)'; dz.style.outlineOffset = '2px'; }
  };
  const off = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    dz.classList.remove('dragover');
    if (!isDz) { dz.style.outline = ''; dz.style.outlineOffset = ''; }
  };
  dz.addEventListener('dragenter', on);
  dz.addEventListener('dragover', on);
  dz.addEventListener('dragleave', off);
  dz.addEventListener('drop', (e) => {
    off(e);
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    if (onFiles) onFiles(files);
    else if (input) { input.files = files; input.dispatchEvent(new Event('change', { bubbles: true })); }
  });
}

// Toasts
export function toast(message, type = 'info', duration = 4000) {
  const stack = $('#toast-stack');
  if (!stack) return null;
  const icon = {
    success: '✓', error: '✕', info: 'i', warning: '!',
  }[type] || 'i';
  const t = el('div', { class: `toast ${type}` },
    el('div', { class: 'chip-icon', style: {
      width: '24px', height: '24px',
      background: type === 'success' ? 'var(--green)'
               : type === 'error' ? 'var(--red)'
               : type === 'warning' ? 'var(--yellow)'
               : 'var(--accent)',
      color: 'white', fontWeight: 700,
    } }, icon),
    el('span', null, message),
  );
  stack.appendChild(t);
  function fadeAndRemove() {
    t.style.transition = 'opacity 0.3s, transform 0.3s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(40px)';
    setTimeout(() => t.remove(), 300);
  }
  // duration <= 0 → sticky toast; caller must dismiss via the returned handle.
  // Useful for "Đang xử lý..." messages that finish on an async response.
  if (duration > 0) setTimeout(fadeAndRemove, duration);
  return { remove: fadeAndRemove, el: t };
}

// Modal
export function modal({ title, body, actions }) {
  const root = $('#modal-root');
  clear(root);
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => {
    if (e.target === backdrop) close();
  }});
  function close() {
    backdrop.style.opacity = '0';
    setTimeout(() => clear(root), 200);
  }
  const m = el('div', { class: 'modal' },
    title ? el('h3', { class: 'modal-title' }, title) : null,
    typeof body === 'string'
      ? el('div', { class: 'modal-body', html: body })
      : el('div', { class: 'modal-body' }, body),
    actions ? el('div', { class: 'modal-actions' },
      ...actions.map(a => el('button', {
        class: `btn ${a.class || ''}`,
        onclick: () => { if (a.onclick) a.onclick(close); else close(); }
      }, a.label))
    ) : null,
  );
  backdrop.appendChild(m);
  root.appendChild(backdrop);
  return { close };
}

export function confirm(message, title = 'Xác nhận') {
  return new Promise(resolve => {
    modal({
      title,
      body: message,
      actions: [
        { label: 'Hủy', class: 'btn-ghost', onclick: (c) => { c(); resolve(false); } },
        { label: 'OK', class: 'btn-primary', onclick: (c) => { c(); resolve(true); } },
      ],
    });
  });
}

// Spinner button
export function setLoading(btn, isLoading, originalText) {
  if (!btn) return;
  if (isLoading) {
    if (!btn.dataset.original) btn.dataset.original = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span><span>Đang xử lý...</span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.original || originalText || btn.innerHTML;
    delete btn.dataset.original;
    btn.disabled = false;
  }
}

// Format bytes
export function formatBytes(b) {
  if (!b) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Build a small JPEG data-URL thumbnail from an image File. Used for ALL
 * reference-image previews so uploading many high-res photos doesn't lag the
 * UI (a raw object-URL renders the full-res image into a tiny <img>, eating
 * memory/CPU). The original File is still uploaded at full quality elsewhere —
 * only the on-screen preview is downscaled. Falls back to a plain object URL
 * on any error.
 */
export function makeThumbnail(file, maxSide = 320, quality = 0.8) {
  return new Promise((resolve) => {
    let url;
    try {
      url = URL.createObjectURL(file);
    } catch (_) { return resolve(''); }
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (_) {
        resolve(url);   // keep the object URL (don't revoke — still in use)
      }
    };
    img.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) {} resolve(url); };
    img.src = url;
  });
}

/**
 * Lazy-load <video> elements as they scroll into view, so a gallery with 100+
 * videos doesn't fire 100 metadata fetches at once (the main >100-item lag
 * cause). Build each card's <video preload="none"> with a `data-src` (NOT
 * `src`); call observer.observe(videoEl) for each. On intersection we set
 * preload='metadata' + src so the FIRST FRAME shows (preview preserved) only
 * for videos near the viewport; off-screen ones stay cheap placeholders.
 *
 * Caller owns the lifecycle: create ONE observer per gallery, disconnect()
 * the previous one before each full rebuild + on unmount (avoids leaking
 * observers across re-renders).
 */
export function makeLazyVideoObserver(root, { rootMargin = '300px' } = {}) {
  return new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const v = e.target;
      if (v.dataset.src && !v.getAttribute('src')) {
        v.preload = 'metadata';
        v.setAttribute('src', v.dataset.src);
      }
      obs.unobserve(v);
    }
  }, { root: root || null, rootMargin });
}

// Icon helper (returns SVG element)
export function icon(name, size = 16) {
  const paths = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
    stop: '<rect x="6" y="6" width="12" height="12" fill="currentColor"/>',
    pause: '<path d="M6 4h4v16H6z M14 4h4v16h-4z" fill="currentColor"/>',
    download: '<path d="M5 20h14v-2H5v2z M12 4v10l4-4 1 1-5 5-5-5 1-1 4 4V4z" fill="currentColor"/>',
    upload: '<path d="M5 20h14v-2H5v2z M12 4l-5 5 1 1 4-4v10h0V6l4 4 1-1z" fill="currentColor"/>',
    refresh: '<path d="M12 4v3l4-4-4-4v3a8 8 0 00-8 8h2a6 6 0 016-6z M20 12a8 8 0 01-8 8v-3l-4 4 4 4v-3a10 10 0 0010-10z" fill="currentColor"/>',
    trash: '<path d="M6 7v13h12V7H6z M9 4h6v2H9z" fill="none" stroke="currentColor" stroke-width="2"/>',
    plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16v4z M14 4l4 4" stroke="currentColor" stroke-width="2" fill="none"/>',
    copy: '<path d="M8 4h10v14h-2V6H8z M4 8h10v12H4z" fill="none" stroke="currentColor" stroke-width="2"/>',
    check: '<path d="M5 12l5 5L20 7" stroke="currentColor" stroke-width="2" fill="none"/>',
    x: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2"/>',
    chevron: '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    folder: '<path d="M3 6h6l2 2h10v12H3z" fill="none" stroke="currentColor" stroke-width="2"/>',
    image: '<path d="M3 5h18v14H3z M8 11l3 3 3-4 5 6H4z" fill="currentColor"/>',
    sparkles: '<path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5z M5 16l.7 2 2 .7-2 .7L5 22l-.7-2-2-.7 2-.7z M19 14l1 2.7 2.7 1-2.7 1L19 21l-1-2.3-2.7-1 2.7-1z" fill="currentColor"/>',
    apps: '<path d="M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z" fill="none" stroke="currentColor" stroke-width="2"/>',
    movie: '<path d="M3 6h18v12H3z M3 10h18 M7 6v4 M12 6v4 M17 6v4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    package: '<path d="M12 3l8 4v10l-8 4-8-4V7z M4 7l8 4 8-4 M12 11v10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    wand: '<path d="M4 20l9-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M15 3L16.1 5.9 19 7 16.1 8.1 15 11 13.9 8.1 11 7 13.9 5.9z" fill="currentColor"/>',
  };
  const wrapper = document.createElement('span');
  wrapper.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${paths[name] || paths.play}</svg>`;
  return wrapper.firstChild;
}

// ── Flow-account guard ───────────────────────────────────────────────
// Chặn việc gen bằng Google Flow khi chưa có tài khoản Flow khả dụng, bằng một
// popup hướng dẫn rõ ràng — thay cho lỗi "Không có account khả dụng" chỉ hiện
// SAU khi task đã chạy. Async: nếu cache báo không có account thì fetch lại 1
// lần trước khi chặn (tránh chặn nhầm khi account vừa được sync). Trả về true
// nếu được phép tạo, false nếu bị chặn (đã hiện popup). KHÔNG dùng cho Shakker
// (Shakker có tài khoản riêng).
export async function ensureFlowAccountOrWarn() {
  const read = () =>
    (window.__app && window.__app.store && window.__app.store.accounts) || [];
  if (read().some(a => a.enabled)) return true;   // fast path: cache nói OK
  // Cache báo không có → fetch tươi 1 lần trước khi chặn.
  try {
    if (window.__app && window.__app.refreshAccounts) await window.__app.refreshAccounts();
  } catch (e) { /* dùng cache */ }
  if (read().some(a => a.enabled)) return true;

  const hasAny = read().length > 0;
  modal({
    title: 'Chưa có tài khoản Google Flow',
    body: el('div', null,
      el('p', { style: { margin: '0 0 10px' } },
        hasAny
          ? 'Tài khoản Google Flow đang bị tắt hoặc đã hết phiên đăng nhập. '
            + 'Hãy đăng nhập lại trước khi tạo.'
          : 'Bạn chưa có tài khoản Google Flow nào. Cần đăng nhập Google Flow để tạo ảnh / video.'),
      el('p', { style: { margin: '0', color: 'var(--text-muted)', fontSize: '12.5px' } },
        'Vào tab "Tài Khoản" → mở labs.google trong Chrome → đăng nhập Google. '
        + '(Cần cài Extension "RedOne Auth Helper" nếu chưa có.)'),
    ),
    actions: [
      { label: 'Mở tab Tài Khoản', class: 'btn-primary',
        onclick: (close) => {
          close();
          if (window.__app && window.__app.navigate) window.__app.navigate('accounts');
        } },
      { label: 'Đóng' },
    ],
  });
  return false;
}

// Banner nhắc nhập Gemini API key — gọi ở đầu render của các tab cần Gemini
// (YouTube / Ý Tưởng / Ảnh → Prompt, Storyboard). Trả về phần tử banner nếu CHƯA
// có key (caller tự appendChild), hoặc null nếu đã có. Không chặn thao tác — chỉ
// nhắc + nút lấy/nhập key. Tự biến mất khi đã nhập key (trang re-render khi quay lại).
export function geminiKeyNotice() {
  const keys = (window.__app && window.__app.store && window.__app.store.settings
    && window.__app.store.settings.gemini_api_keys) || [];
  if (Array.isArray(keys) && keys.length > 0) return null;
  return el('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      background: 'var(--brand-tint)', border: '1px solid var(--brand)',
      borderRadius: 'var(--r-md)', padding: '12px 16px', marginBottom: '16px',
    },
  },
    el('div', { style: { flex: '1', minWidth: '220px', fontSize: '13.5px', lineHeight: '1.5' } },
      el('b', { style: { color: 'var(--brand)' } }, '⚠ Cần Gemini API key (miễn phí) '),
      el('span', null, '— tính năng này dùng AI Gemini để viết prompt. Hãy nhập key để dùng được.'),
    ),
    el('button', {
      class: 'btn btn-sm btn-primary',
      onclick: () => window.open('https://aistudio.google.com/apikey', '_blank', 'noopener'),
    }, 'Lấy key tại AI Studio'),
    el('button', {
      class: 'btn btn-sm',
      onclick: () => { if (window.__app && window.__app.navigate) window.__app.navigate('settings'); },
    }, 'Nhập key trong Cài đặt'),
  );
}

// ── Media lightbox ───────────────────────────────────────────────────
// Xem ảnh/video ngay trong app (nền mờ đằng sau) thay vì mở tab Chrome mới /
// play inline. type: 'image' | 'video'. label hiện ở thanh dưới + nút Tải về /
// Đóng. Đóng bằng: bấm nền, nút Đóng, hoặc phím Esc.
//
// Gallery mode: truyền thêm `items` (mảng {url, type?, label?, downloadUrl?}) +
// `currentIndex` để bật Next/Prev (nút + phím ← →).  Backward-compatible: gọi
// chỉ với {url, type, label} vẫn hoạt động bình thường (single-item, ẩn nút).
export function openMediaViewer({ url, type = 'image', label = '', downloadUrl = '', items = null, currentIndex = 0 }) {
  const gallery = items && items.length > 0
    ? items
    : [{ url, type, label, downloadUrl }];
  let idx = (items && items.length > 0) ? currentIndex : 0;
  if (idx < 0 || idx >= gallery.length) idx = 0;

  if (!gallery[idx]?.url) return null;
  const old = document.getElementById('media-viewer');
  if (old) old.remove();

  // ── Media container (swap nội dung khi navigate) ─────────────────
  const mediaWrap = el('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
  });
  mediaWrap.addEventListener('click', (e) => e.stopPropagation());

  // ── Nav buttons — fixed to viewport sides, vertically centered ───
  const _navStyle = (side) => ({
    position: 'fixed', top: '50%', [side]: '20px',
    transform: 'translateY(-50%)', zIndex: '2010',
    width: '48px', height: '48px', borderRadius: '50%', border: 'none',
    background: 'rgba(0,0,0,0.5)', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', backdropFilter: 'blur(8px)',
    boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
    transition: 'background 0.2s, box-shadow 0.2s',
  });

  const prevBtn = el('button', {
    'aria-label': 'Previous', title: 'Trước (←)',
    style: _navStyle('left'),
  }, icon('chevron-left', 24));

  const nextBtn = el('button', {
    'aria-label': 'Next', title: 'Tiếp (→)',
    style: _navStyle('right'),
  }, icon('chevron-right', 24));

  [prevBtn, nextBtn].forEach((b) => {
    b.addEventListener('mouseenter', () => {
      b.style.background = 'rgba(255,255,255,0.2)';
      b.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5)';
    });
    b.addEventListener('mouseleave', () => {
      b.style.background = 'rgba(0,0,0,0.5)';
      b.style.boxShadow = '0 2px 12px rgba(0,0,0,0.4)';
    });
    b.addEventListener('click', (e) => e.stopPropagation());
  });

  // ── Counter + Caption bar ─────────────────────────────────────────
  const counterEl = el('span', {
    style: { fontSize: '12px', color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums',
             flexShrink: '0', whiteSpace: 'nowrap' },
  });

  const labelEl = el('span', {
    style: { flex: '1', minWidth: '0', fontSize: '13px', fontWeight: '600',
             overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  });

  const dlLink = el('a', {
    class: 'btn btn-sm', download: '',
    style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: '0' },
  }, icon('download', 14), 'Tải về');

  const closeBtn = el('button', {
    class: 'btn btn-sm',
    style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: '0' },
  }, icon('x', 14), 'Đóng');

  const caption = el('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '12px',
      maxWidth: '94vw', padding: '8px 14px', color: '#fff',
      background: 'rgba(0,0,0,0.62)', borderRadius: 'var(--r-md)',
    },
  }, counterEl, labelEl, dlLink, closeBtn);
  caption.addEventListener('click', (e) => e.stopPropagation());

  // ── Render current item ──────────────────────────────────────────
  function renderItem() {
    const it = gallery[idx];
    const t = it.type || 'image';
    const dl = it.downloadUrl || it.url;

    mediaWrap.innerHTML = '';
    const media = t === 'video'
      ? el('video', { src: it.url, controls: true, autoplay: true, loop: true,
          style: { display: 'block', maxWidth: '94vw', maxHeight: '82vh',
                   borderRadius: 'var(--r-md)', background: '#000', boxShadow: 'var(--sh-lg)' } })
      : el('img', { src: it.url, alt: it.label || 'preview',
          style: { display: 'block', maxWidth: '94vw', maxHeight: '82vh',
                   borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-lg)' } });
    mediaWrap.appendChild(media);

    labelEl.textContent = it.label || '';
    dlLink.href = dl;

    const multi = gallery.length > 1;
    counterEl.textContent = multi ? `${idx + 1} / ${gallery.length}` : '';
    counterEl.style.display = multi ? '' : 'none';
    prevBtn.style.display = multi ? '' : 'none';
    nextBtn.style.display = multi ? '' : 'none';
    prevBtn.style.opacity = idx > 0 ? '1' : '0.3';
    nextBtn.style.opacity = idx < gallery.length - 1 ? '1' : '0.3';
    prevBtn.style.pointerEvents = idx > 0 ? 'auto' : 'none';
    nextBtn.style.pointerEvents = idx < gallery.length - 1 ? 'auto' : 'none';
  }

  function goPrev() { if (idx > 0) { idx--; renderItem(); } }
  function goNext() { if (idx < gallery.length - 1) { idx++; renderItem(); } }

  prevBtn.addEventListener('click', goPrev);
  nextBtn.addEventListener('click', goNext);

  // ── Backdrop ─────────────────────────────────────────────────────
  const backdrop = el('div', {
    id: 'media-viewer',
    style: {
      position: 'fixed', inset: '0', zIndex: '2000',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '12px', padding: '24px',
      background: 'rgba(8,8,12,0.82)', backdropFilter: 'blur(4px)',
      animation: 'fadeIn 0.18s ease both',
    },
  }, mediaWrap, caption, prevBtn, nextBtn);

  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') goPrev();
    else if (e.key === 'ArrowRight') goNext();
  }
  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  renderItem();
  document.body.appendChild(backdrop);
  return { close };
}

// Before/after comparison viewer — overlays the upscaled image on top of the
// original and reveals the original by dragging a vertical divider. Used for
// Shakker upscale + Flow 2K/4K so the user can judge the gain, with a download
// option in the caption. Both images must share the same aspect ratio.
export function openCompareViewer({
  beforeUrl,
  afterUrl,
  beforeLabel = 'Ảnh gốc',
  afterLabel = 'Đã upscale',
  downloadUrl = '',
  downloadName = '',
  title = '',
}) {
  if (!beforeUrl || !afterUrl) return null;
  const old = document.getElementById('compare-viewer');
  if (old) old.remove();

  let pct = 50;

  // after = base layer (full); before = clipped overlay on the left.
  const afterImg = el('img', {
    src: afterUrl, alt: afterLabel, draggable: false,
    style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
             objectFit: 'contain', display: 'block', userSelect: 'none', pointerEvents: 'none' },
  });
  const beforeImg = el('img', {
    src: beforeUrl, alt: beforeLabel, draggable: false,
    style: { position: 'absolute', top: 0, left: 0, height: '100%', maxWidth: 'none',
             objectFit: 'contain', display: 'block', userSelect: 'none', pointerEvents: 'none' },
  });
  const beforeClip = el('div', {
    style: { position: 'absolute', top: 0, left: 0, height: '100%', width: pct + '%',
             overflow: 'hidden' },
  }, beforeImg);

  const line = el('div', {
    style: { position: 'absolute', top: 0, bottom: 0, left: pct + '%', width: '2px',
             transform: 'translateX(-1px)', background: 'rgba(255,255,255,0.92)',
             boxShadow: '0 0 10px rgba(0,0,0,0.6)', zIndex: 3, pointerEvents: 'none' },
  });

  const handleIcon = document.createElement('span');
  handleIcon.style.cssText = 'display:flex;color:#fff';
  handleIcon.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M9 7l-5 5 5 5"/><path d="M15 7l5 5-5 5"/></svg>';
  const handle = el('div', {
    style: { position: 'absolute', top: '50%', left: pct + '%', transform: 'translate(-50%,-50%)',
             width: '46px', height: '46px', borderRadius: '50%', background: 'rgba(37,99,235,0.92)',
             border: '3px solid #fff', boxShadow: '0 3px 14px rgba(0,0,0,0.55)',
             display: 'flex', alignItems: 'center', justifyContent: 'center',
             cursor: 'ew-resize', zIndex: 4 },
  }, handleIcon);

  const labelChip = (txt, side) => el('div', {
    style: { position: 'absolute', top: '12px', [side]: '12px', padding: '4px 11px',
             borderRadius: '999px', fontSize: '12px', fontWeight: 700, color: '#fff',
             background: 'rgba(0,0,0,0.6)', letterSpacing: '0.3px', zIndex: 4,
             pointerEvents: 'none', transition: 'opacity 0.15s' },
  }, txt);
  const beforeChip = labelChip(beforeLabel, 'left');
  const afterChip = labelChip(afterLabel, 'right');

  // Loading / error overlay — large upscaled images can take a moment, and a
  // silent failure would otherwise just show a blank pane.
  const statusEl = el('div', {
    style: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
             zIndex: 5, maxWidth: '80%', padding: '10px 16px', borderRadius: 'var(--r-md)',
             color: '#fff', background: 'rgba(0,0,0,0.62)', fontSize: '13px', fontWeight: 600,
             textAlign: 'center', pointerEvents: 'none' },
  }, 'Đang tải ảnh…');

  const box = el('div', {
    style: { position: 'relative', overflow: 'hidden', borderRadius: 'var(--r-md)',
             boxShadow: 'var(--sh-lg)', background: '#0c0c10', cursor: 'ew-resize',
             touchAction: 'none', maxWidth: '94vw', maxHeight: '78vh', width: '60vw', height: '40vh' },
  }, afterImg, beforeClip, line, handle, beforeChip, afterChip, statusEl);

  function setPct(p) {
    pct = Math.max(0, Math.min(100, p));
    beforeClip.style.width = pct + '%';
    line.style.left = pct + '%';
    handle.style.left = pct + '%';
    beforeChip.style.opacity = pct < 12 ? '0' : '1';
    afterChip.style.opacity = pct > 88 ? '0' : '1';
  }

  function fit() {
    const natW = afterImg.naturalWidth || beforeImg.naturalWidth;
    const natH = afterImg.naturalHeight || beforeImg.naturalHeight;
    if (!natW || !natH) return;
    const maxW = window.innerWidth * 0.94;
    const maxH = window.innerHeight * 0.78;
    let W = maxW, H = W * natH / natW;
    if (H > maxH) { H = maxH; W = H * natW / natH; }
    W = Math.round(W); H = Math.round(H);
    box.style.width = W + 'px';
    box.style.height = H + 'px';
    beforeImg.style.width = W + 'px';
    beforeImg.style.height = H + 'px';
  }
  let afterLoaded = false;
  function onAfterLoad() { afterLoaded = true; statusEl.style.display = 'none'; fit(); }
  function onImgError(which) {
    statusEl.style.display = '';
    statusEl.style.background = 'rgba(120,22,22,0.9)';
    statusEl.textContent = which === 'after'
      ? 'Không tải được ảnh đã upscale — bấm "Tải ảnh upscale" bên dưới.'
      : 'Không tải được ảnh gốc.';
  }
  afterImg.addEventListener('load', onAfterLoad);
  afterImg.addEventListener('error', () => onImgError('after'));
  beforeImg.addEventListener('load', fit);
  beforeImg.addEventListener('error', () => onImgError('before'));
  // Cached images may already be complete before listeners attach → load never
  // fires; reconcile manually.
  if (afterImg.complete && afterImg.naturalWidth) onAfterLoad();
  else if (afterImg.complete && !afterImg.naturalWidth) onImgError('after');
  if (beforeImg.complete && beforeImg.naturalWidth) fit();

  let dragging = false;
  function pctFromEvent(e) {
    const r = box.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    return ((cx - r.left) / r.width) * 100;
  }
  function onMove(e) { if (dragging) { setPct(pctFromEvent(e)); e.preventDefault(); } }
  function onUp() { dragging = false; }
  box.addEventListener('pointerdown', (e) => { dragging = true; setPct(pctFromEvent(e)); });
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);

  const dl = downloadUrl || afterUrl;
  const closeBtn = el('button', {
    class: 'btn btn-sm', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: '0' },
  }, icon('x', 14), 'Đóng');
  const dlBtn = el('a', {
    class: 'btn btn-sm btn-primary', href: dl, download: downloadName || '',
    style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: '0' },
  }, icon('download', 14), 'Tải ảnh upscale');
  const caption = el('div', {
    style: { display: 'flex', alignItems: 'center', gap: '12px', maxWidth: '94vw',
             padding: '8px 14px', color: '#fff', background: 'rgba(0,0,0,0.62)', borderRadius: 'var(--r-md)' },
  },
    el('span', {
      style: { flex: '1', minWidth: '0', fontSize: '13px', fontWeight: '600',
               overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, title || 'Kéo thanh ở giữa để so sánh trước / sau'),
    dlBtn, closeBtn,
  );
  caption.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('click', (e) => e.stopPropagation());

  const backdrop = el('div', {
    id: 'compare-viewer',
    style: { position: 'fixed', inset: '0', zIndex: '2000', display: 'flex', flexDirection: 'column',
             alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '24px',
             background: 'rgba(8,8,12,0.85)', backdropFilter: 'blur(4px)', animation: 'fadeIn 0.18s ease both' },
  }, box, caption);

  function close() {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    window.removeEventListener('resize', fit);
    backdrop.remove();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', fit);

  document.body.appendChild(backdrop);
  fit();
  setPct(50);
  return { close };
}
