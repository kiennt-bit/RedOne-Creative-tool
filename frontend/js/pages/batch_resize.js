// Batch resize page
import { el, clear, toast, setLoading, icon, formatBytes, wireDropzone } from '../ui.js';
import { api } from '../api.js';

// Module-level state → file list + results survive SPA tab navigation
// (File objects stay valid in memory; only a full F5 clears them).
const state = { files: [], presets: {}, results: null };

export function renderBatchResize(root) {

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Resize Hàng Loạt'),
      el('p', null, 'Đổi kích thước nhiều ảnh & video theo preset platform hoặc tùy chỉnh'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '380px 1fr', gap: '20px' } });
  root.appendChild(layout);

  layout.appendChild(el('div', { class: 'card' },
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Preset platform'),
      el('select', { class: 'select', id: 'br-preset' },
        el('option', { value: '' }, '— Tùy chỉnh —'),
      ),
    ),
    el('div', { class: 'form-row' },
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Width'),
        el('input', { type: 'number', class: 'input', id: 'br-w', value: 1920, min: 1 }),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Height'),
        el('input', { type: 'number', class: 'input', id: 'br-h', value: 1080, min: 1 }),
      ),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Chế độ'),
      el('select', { class: 'select', id: 'br-mode' },
        el('option', { value: 'fit', selected: 'true' }, 'Fit (letterbox, giữ tỉ lệ)'),
        el('option', { value: 'cover' }, 'Cover (crop, giữ tỉ lệ)'),
        el('option', { value: 'stretch' }, 'Stretch (méo)'),
      ),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Màu nền (fit mode)'),
      el('input', { type: 'color', class: 'color-input', id: 'br-bg', value: '#000000' }),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Định dạng (ảnh)'),
      el('select', { class: 'select', id: 'br-fmt' },
        el('option', { value: 'png', selected: 'true' }, 'PNG'),
        el('option', { value: 'jpg' }, 'JPEG'),
        el('option', { value: 'webp' }, 'WebP'),
      ),
      el('div', { class: 'field-help' }, 'Video luôn xuất MP4 (H.264).'),
    ),
    el('button', { class: 'btn btn-primary', style: { width: '100%', marginTop: '12px' }, id: 'br-go' },
      icon('sparkles'), 'Resize',
    ),
  ));

  const right = el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Files'),
      el('button', { class: 'btn btn-sm btn-primary', id: 'br-add' },
        icon('plus', 14), 'Thêm files',
      ),
    ),
    el('input', { type: 'file', accept: 'image/*,video/*', multiple: 'true', id: 'br-files', style: { display: 'none' } }),
    el('div', { class: 'file-list', id: 'br-list' },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 32)),
        el('div', null, 'Chưa có file'),
      ),
    ),
    el('div', { id: 'br-result' }),
  );
  layout.appendChild(right);

  // Load presets
  api.media.resizePresets().then(d => {
    state.presets = d.presets || {};
    const sel = root.querySelector('#br-preset');
    Object.entries(state.presets).forEach(([k, [w, h]]) => {
      sel.appendChild(el('option', { value: k }, `${k.replace(/_/g, ' ')} — ${w}×${h}`));
    });
  });
  root.querySelector('#br-preset').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v || !state.presets[v]) return;
    const [w, h] = state.presets[v];
    root.querySelector('#br-w').value = w;
    root.querySelector('#br-h').value = h;
  });

  root.querySelector('#br-add').addEventListener('click', () => root.querySelector('#br-files').click());
  root.querySelector('#br-files').addEventListener('change', (e) => {
    for (const f of e.target.files) state.files.push(f);
    renderList();
  });
  // Kéo-thả ảnh/video vào danh sách (ngoài nút "Thêm files")
  wireDropzone(root.querySelector('#br-list'), null, (files) => {
    for (const f of files) if (/^(image|video)\//.test(f.type)) state.files.push(f);
    renderList();
  });

  function renderList() {
    const list = root.querySelector('#br-list');
    clear(list);
    if (state.files.length === 0) {
      list.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 32)),
        el('div', null, 'Chưa có file'),
      ));
      return;
    }
    state.files.forEach((f, i) => {
      const isVid = (f.type || '').startsWith('video');
      list.appendChild(el('div', { class: 'file-row' },
        el('div', { class: 'file-icon' }, icon(isVid ? 'movie' : 'image', 16)),
        el('div', { class: 'file-name' }, f.name),
        el('div', { class: 'file-size' }, formatBytes(f.size)),
        el('button', { class: 'btn btn-icon btn-ghost', onclick: () => {
          state.files.splice(i, 1); renderList();
        } }, icon('trash', 14)),
      ));
    });
  }

  root.querySelector('#br-go').addEventListener('click', async () => {
    if (state.files.length === 0) return toast('Cần ít nhất 1 file', 'warning');
    const btn = root.querySelector('#br-go');
    setLoading(btn, true);
    try {
      const fd = new FormData();
      state.files.forEach(f => fd.append('files', f));
      fd.append('width', root.querySelector('#br-w').value);
      fd.append('height', root.querySelector('#br-h').value);
      fd.append('mode', root.querySelector('#br-mode').value);
      fd.append('bg_color', root.querySelector('#br-bg').value);
      fd.append('fmt', root.querySelector('#br-fmt').value);
      const r = await api.media.batchResize(fd);
      state.results = r.results || [];
      renderResult(state.results);
      toast(`Resize xong ${state.results.filter(x => !x.error).length} file`, 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  });

  function renderResult(results) {
    const out = root.querySelector('#br-result');
    clear(out);
    const list = results || [];
    const okCount = list.filter(r => !r.error).length;

    out.appendChild(el('div', {
      class: 'card-header',
      style: { marginTop: '16px', alignItems: 'baseline' },
    },
      el('h4', { style: { margin: 0 } }, 'Kết quả'),
      el('span', { style: { fontSize: '12px', color: 'var(--text-muted)' } },
        `${okCount}/${list.length} file`),
    ));

    const grid = el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: '12px', marginTop: '12px',
      },
    });

    // Shared media box: same 16:9 frame for image + video so the grid stays
    // even. object-fit: contain never crops; a dark backdrop hides letterbox.
    const mediaStyle = {
      width: '100%', aspectRatio: '16 / 9', objectFit: 'contain',
      background: '#000', borderRadius: '8px', display: 'block',
    };
    // One-line label that truncates with an ellipsis; full name on hover.
    const nameStyle = {
      flex: 1, minWidth: 0, fontSize: '11px', color: 'var(--text)',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    };

    list.forEach(res => {
      if (res.error) {
        grid.appendChild(el('div', {
          class: 'card',
          style: { padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' },
        },
          el('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--red)' } }, 'Lỗi'),
          el('div', { title: res.name, style: { fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, res.name),
          el('div', { style: { fontSize: '11px', color: 'var(--text-muted)', wordBreak: 'break-word' } }, res.error),
        ));
        return;
      }
      const isVideo = res.type === 'video';
      const media = isVideo
        ? el('video', { src: res.url, controls: 'true', preload: 'metadata', style: mediaStyle })
        : el('img', { src: res.url, style: mediaStyle });
      grid.appendChild(el('div', {
        class: 'card',
        style: { padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' },
      },
        media,
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          icon(isVideo ? 'movie' : 'image', 14, { style: { color: 'var(--text-muted)', flexShrink: 0 } }),
          el('div', { title: res.name, style: nameStyle }, res.name),
        ),
        el('a', { href: res.url, download: '', class: 'btn btn-sm btn-ghost', style: { width: '100%', justifyContent: 'center' } },
          icon('download', 13), 'Tải về'),
      ));
    });
    out.appendChild(grid);
  }

  // Restore file list + results after returning to this tab
  renderList();
  if (state.results) renderResult(state.results);
}
