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
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    folder: '<path d="M3 6h6l2 2h10v12H3z" fill="none" stroke="currentColor" stroke-width="2"/>',
    image: '<path d="M3 5h18v14H3z M8 11l3 3 3-4 5 6H4z" fill="currentColor"/>',
    sparkles: '<path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5z M5 16l.7 2 2 .7-2 .7L5 22l-.7-2-2-.7 2-.7z M19 14l1 2.7 2.7 1-2.7 1L19 21l-1-2.3-2.7-1 2.7-1z" fill="currentColor"/>',
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
