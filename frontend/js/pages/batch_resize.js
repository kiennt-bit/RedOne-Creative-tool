// Batch resize page
import { el, clear, toast, setLoading, icon, formatBytes } from '../ui.js';
import { api } from '../api.js';

export function renderBatchResize(root) {
  const state = { files: [], presets: {} };

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Resize Hàng Loạt'),
      el('p', null, 'Đổi kích thước nhiều ảnh theo preset platform hoặc tùy chỉnh'),
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
      el('label', { class: 'field-label' }, 'Định dạng'),
      el('select', { class: 'select', id: 'br-fmt' },
        el('option', { value: 'png', selected: 'true' }, 'PNG'),
        el('option', { value: 'jpg' }, 'JPEG'),
        el('option', { value: 'webp' }, 'WebP'),
      ),
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
    el('input', { type: 'file', accept: 'image/*', multiple: 'true', id: 'br-files', style: { display: 'none' } }),
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
      list.appendChild(el('div', { class: 'file-row' },
        el('div', { class: 'file-icon' }, icon('image', 16)),
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
      const out = root.querySelector('#br-result');
      clear(out);
      out.appendChild(el('h4', { style: { marginTop: '16px' } }, 'Kết quả'));
      const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' } });
      (r.results || []).forEach(res => {
        if (res.error) {
          grid.appendChild(el('div', { class: 'card', style: { padding: '8px', fontSize: '11px', color: 'var(--red)' } },
            res.name, ': ', res.error));
        } else {
          grid.appendChild(el('div', null,
            el('img', { src: res.url, class: 'thumb', style: { objectFit: 'cover' } }),
            el('div', { style: { fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '4px' } }, res.name),
          ));
        }
      });
      out.appendChild(grid);
      toast(`Resize xong ${r.results.filter(x => !x.error).length} file`, 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  });
}
