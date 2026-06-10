// Shakker.ai image generation page.
// Mirrors pages/image.js (gallery via tasksStore, survives navigation) but
// targets the Shakker provider: checkpoint + multi-LoRA + 1 reference image
// + 7 aspect ratios + bulk prompts.
import { el, clear, toast, setLoading, icon, modal, makeThumbnail } from '../ui.js';
import { api } from '../api.js';
import { tasksStore } from '../tasks_store.js';
import { ws } from '../ws.js';
import {
  makeSelectionToolbar, attachCardCheckbox,
  makeRetryFailedButton,
} from '../gallery_actions.js';

const FLUX_BASE_TYPE = 19;
const ASPECTS = ['1:1', '3:4', '2:3', '9:16', '4:3', '3:2', '16:9'];

// ── Module-level form state (survives navigation) ──
const form = {
  prompts: [''],
  checkpoint: { id: 1508012, name: 'Shakker Zeno-1', base_type: FLUX_BASE_TYPE },
  loras: [],                  // [{version_id, model_id, weight, name, base_type, trigger_word}]
  aspect: '1:1',
  negativePrompt: '',
  refImageUrl: null,
  refImagePreview: null,
  refStrength: 0.5,
  countPerPrompt: 1,
  taskName: '',
  _initialized: false,
};

function defaultTaskName() {
  const d = new Date();
  const ts = `${d.getHours().toString().padStart(2, '0')}h${d.getMinutes().toString().padStart(2, '0')}`;
  return `shakker_${ts}`;
}

// ─────────────────────────────────────────────────────────────
// Catalog picker modal — reused for model (single) + LoRA (multi)
// ─────────────────────────────────────────────────────────────
function openCatalogPicker({ type, onPick }) {
  const isLora = type === 'lora';
  let page = 1;
  let search = '';
  let loading = false;

  const grid = el('div', {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
      gap: '10px', maxHeight: '52vh', overflowY: 'auto', padding: '4px',
    },
  });
  const statusEl = el('div', { class: 'field-help', style: { margin: '8px 0' } }, 'Đang tải…');
  const searchInput = el('input', {
    class: 'input', placeholder: isLora ? 'Tìm LoRA…' : 'Tìm model…',
    style: { flex: 1 },
  });
  const pageLabel = el('span', { class: 'text-muted text-sm' }, 'Trang 1');

  async function load() {
    if (loading) return;
    loading = true;
    statusEl.textContent = 'Đang tải…';
    clear(grid);
    try {
      const params = { base_type: FLUX_BASE_TYPE, page, page_size: 24 };
      if (search) params.search = search;
      const data = isLora ? await api.shakker.loras(params) : await api.shakker.models(params);
      const items = data.items || [];
      statusEl.textContent = `${data.total || items.length} kết quả`;
      pageLabel.textContent = `Trang ${page}`;
      if (!items.length) {
        grid.appendChild(el('div', { class: 'field-help' }, 'Không tìm thấy.'));
      }
      for (const it of items) {
        const already = isLora && form.loras.some(l => l.version_id === it.version_id);
        const card = el('div', {
          style: {
            border: already ? '2px solid var(--brand)' : '1px solid var(--border)',
            borderRadius: 'var(--r-md)', overflow: 'hidden', cursor: 'pointer',
            background: 'var(--bg-2)', position: 'relative',
          },
          onclick: () => {
            onPick(it);
            if (isLora) {
              // multi-select: keep modal open, mark selected
              card.style.border = '2px solid var(--brand)';
            } else {
              close();
            }
          },
        },
          it.image_url
            ? el('img', { src: it.image_url, loading: 'lazy', style: {
                width: '100%', height: '110px', objectFit: 'cover', display: 'block',
              } })
            : el('div', { style: { height: '110px', background: 'var(--bg-3)' } }),
          el('div', { style: { padding: '6px 8px' } },
            el('div', { style: {
              fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            }, title: it.name }, it.name || '(no name)'),
            el('div', { class: 'text-muted', style: { fontSize: '10px' } },
              `▶ ${(it.run_count || 0).toLocaleString()}`
              + (it.trigger_word ? ` · ${it.trigger_word}` : '')),
          ),
        );
        grid.appendChild(card);
      }
    } catch (e) {
      statusEl.textContent = '';
      grid.appendChild(el('div', { style: { color: 'var(--red)' } }, e.message));
    } finally {
      loading = false;
    }
  }

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = searchInput.value.trim(); page = 1; load(); }, 350);
  });

  const body = el('div', null,
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } },
      searchInput,
    ),
    statusEl,
    grid,
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center', marginTop: '10px' } },
      el('button', { class: 'btn btn-sm btn-ghost', onclick: () => { if (page > 1) { page--; load(); } } }, '‹ Trước'),
      pageLabel,
      el('button', { class: 'btn btn-sm btn-ghost', onclick: () => { page++; load(); } }, 'Sau ›'),
    ),
  );

  const { close } = modal({
    title: isLora ? 'Chọn LoRA (Shakker)' : 'Chọn Model (Shakker)',
    body,
    actions: [{ label: 'Xong', class: 'btn-primary' }],
  });
  load();
}

// ─────────────────────────────────────────────────────────────
// Main page render
// ─────────────────────────────────────────────────────────────
export function renderShakker(root) {
  if (!form._initialized) {
    form._initialized = true;
    const s = window.__app?.store?.settings || {};
    if (s.default_aspect && ASPECTS.includes(s.default_aspect)) form.aspect = s.default_aspect;
  }

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 22)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Ảnh Shakker'),
      el('p', null, 'Sinh ảnh hàng loạt qua Shakker.ai — model + LoRA + ảnh tham chiếu'),
    ),
  ));

  // Token-expired banner (hidden by default)
  const banner = el('div', {
    id: 'shk-banner', class: 'hidden',
    style: {
      background: 'var(--red-soft)', color: 'var(--red)',
      border: '1px solid var(--red)', borderRadius: 'var(--r-md)',
      padding: '10px 14px', marginBottom: '12px', fontSize: '13px',
    },
  });
  root.appendChild(banner);

  const layout = el('div', { class: 'gen-layout' });
  root.appendChild(layout);

  // ── LEFT: config ──
  const left = el('div', { class: 'gen-config' });
  layout.appendChild(left);

  // Account chip
  const acctChip = el('div', { class: 'card', style: { marginBottom: '12px', padding: '12px 14px' } },
    el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      el('div', null,
        el('div', { class: 'field-help', style: { margin: 0 } }, 'Tài khoản Shakker'),
        el('div', { id: 'shk-acct-email', style: { fontWeight: 600, fontSize: '13px' } }, 'Đang tải…'),
      ),
      el('div', { style: { textAlign: 'right' } },
        el('div', { class: 'field-help', style: { margin: 0 } }, 'Power còn lại'),
        el('div', { id: 'shk-acct-power', style: { fontWeight: 700, fontSize: '16px', color: 'var(--brand)' } }, '—'),
      ),
    ),
  );
  left.appendChild(acctChip);

  const cfgCard = el('div', { class: 'card' });
  left.appendChild(cfgCard);

  // Task name
  cfgCard.appendChild(el('div', { class: 'field-group' },
    el('label', { class: 'field-label' }, 'Tên task'),
    el('input', { class: 'input', id: 'shk-taskname', placeholder: 'vd: anh_san_pham' }),
  ));

  // Model picker
  const modelBtn = el('button', {
    class: 'btn btn-ghost', style: {
      width: '100%', justifyContent: 'space-between', border: '1px solid var(--border)',
    },
    onclick: () => openCatalogPicker({
      type: 'model',
      onPick: (it) => {
        form.checkpoint = {
          id: it.version_id, name: it.name,
          base_type: typeof it.base_type === 'number' ? it.base_type : FLUX_BASE_TYPE,
        };
        refreshModelBtn();
        toast(`Model: ${it.name}`, 'success');
      },
    }),
  });
  function refreshModelBtn() {
    clear(modelBtn);
    modelBtn.appendChild(el('span', null, form.checkpoint.name || 'Chọn model'));
    modelBtn.appendChild(el('span', { class: 'text-muted' }, '›'));
  }
  refreshModelBtn();
  cfgCard.appendChild(el('div', { class: 'field-group' },
    el('label', { class: 'field-label' }, 'Model'),
    modelBtn,
  ));

  // LoRA picker (multi)
  const loraList = el('div', { id: 'shk-lora-list', style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' } });
  function refreshLoraList() {
    clear(loraList);
    if (!form.loras.length) {
      loraList.appendChild(el('div', { class: 'field-help', style: { margin: 0 } }, 'Chưa chọn LoRA nào (tùy chọn).'));
    }
    form.loras.forEach((lo, idx) => {
      const weightLabel = el('span', { class: 'text-muted text-sm', style: { minWidth: '32px' } }, lo.weight.toFixed(2));
      const pill = el('div', {
        style: {
          border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
          padding: '8px 10px', background: 'var(--bg-2)',
        },
      },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          el('span', { style: { fontSize: '12px', fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: lo.name }, lo.name || `LoRA ${lo.version_id}`),
          el('button', { class: 'btn btn-icon btn-ghost', title: 'Xóa', onclick: () => { form.loras.splice(idx, 1); refreshLoraList(); } }, icon('x', 14)),
        ),
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' } },
          el('span', { class: 'text-muted text-sm' }, 'Weight'),
          el('input', {
            type: 'range', min: '0', max: '1.5', step: '0.05', value: String(lo.weight),
            style: { flex: 1 },
            oninput: (e) => { lo.weight = parseFloat(e.target.value); weightLabel.textContent = lo.weight.toFixed(2); },
          }),
          weightLabel,
        ),
      );
      loraList.appendChild(pill);
    });
  }
  refreshLoraList();
  cfgCard.appendChild(el('div', { class: 'field-group' },
    el('label', { class: 'field-label' }, 'LoRA (phong cách)'),
    el('button', {
      class: 'btn btn-sm btn-ghost', style: { border: '1px dashed var(--border)', width: '100%' },
      onclick: () => openCatalogPicker({
        type: 'lora',
        onPick: (it) => {
          if (form.loras.some(l => l.version_id === it.version_id)) {
            toast('LoRA đã có trong danh sách', 'info');
            return;
          }
          if (form.loras.length >= 5) {
            toast('Tối đa 5 LoRA', 'warning');
            return;
          }
          form.loras.push({
            version_id: it.version_id, model_id: it.model_id, weight: 0.8,
            name: it.name, base_type: it.base_type, trigger_word: it.trigger_word || '',
          });
          refreshLoraList();
          toast(`Thêm LoRA: ${it.name}`, 'success');
        },
      }),
    }, icon('plus', 14), 'Thêm LoRA'),
    loraList,
  ));

  // Aspect ratio buttons
  const aspectRow = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } });
  function refreshAspect() {
    clear(aspectRow);
    ASPECTS.forEach(a => {
      aspectRow.appendChild(el('button', {
        class: `btn btn-sm ${form.aspect === a ? 'btn-primary' : 'btn-ghost'}`,
        onclick: () => { form.aspect = a; refreshAspect(); },
      }, a));
    });
  }
  refreshAspect();
  cfgCard.appendChild(el('div', { class: 'field-group' },
    el('label', { class: 'field-label' }, 'Tỉ lệ khung hình'),
    aspectRow,
  ));

  // Reference image (single, img2img)
  const refWrap = el('div', { id: 'shk-ref-wrap', style: { marginTop: '6px' } });
  function refreshRef() {
    clear(refWrap);
    if (form.refImageUrl) {
      const strengthLabel = el('span', { class: 'text-muted text-sm', style: { minWidth: '32px' } }, form.refStrength.toFixed(2));
      refWrap.appendChild(el('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } },
        el('img', { src: form.refImagePreview || form.refImageUrl, style: { width: '72px', height: '72px', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--border)' } }),
        el('div', { style: { flex: 1 } },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            el('span', { class: 'field-help', style: { margin: 0 } }, 'Ảnh tham chiếu (img2img)'),
            el('button', { class: 'btn btn-icon btn-ghost', title: 'Xóa ảnh', onclick: () => { form.refImageUrl = null; form.refImagePreview = null; refreshRef(); } }, icon('x', 14)),
          ),
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' } },
            el('span', { class: 'text-muted text-sm' }, 'Độ giống'),
            el('input', {
              type: 'range', min: '0.05', max: '1', step: '0.05', value: String(form.refStrength),
              style: { flex: 1 },
              oninput: (e) => { form.refStrength = parseFloat(e.target.value); strengthLabel.textContent = form.refStrength.toFixed(2); },
            }),
            strengthLabel,
          ),
          el('div', { class: 'field-help', style: { marginTop: '4px' } }, 'Cao = giống ảnh gốc hơn; thấp = sáng tạo tự do hơn.'),
        ),
      ));
    } else {
      const dz = el('div', { class: 'dropzone' },
        el('div', { class: 'dropzone-icon' }, icon('image', 22)),
        el('div', null, 'Kéo thả 1 ảnh hoặc click'),
        el('div', { class: 'field-help' }, 'Tùy chọn — chỉ 1 ảnh tham chiếu.'),
        el('input', { type: 'file', accept: 'image/*', id: 'shk-ref-file', style: { display: 'none' } }),
      );
      const fi = dz.querySelector('#shk-ref-file');
      dz.addEventListener('click', () => fi.click());
      ['dragover', 'dragleave', 'drop'].forEach(ev => {
        dz.addEventListener(ev, e => {
          e.preventDefault();
          dz.classList.toggle('dragover', ev === 'dragover');
          if (ev === 'drop' && e.dataTransfer.files.length) { fi.files = e.dataTransfer.files; doUpload(); }
        });
      });
      fi.addEventListener('change', doUpload);
      async function doUpload() {
        if (!fi.files[0]) return;
        const file = fi.files[0];
        dz.querySelector('div:nth-child(2)').textContent = 'Đang upload…';
        const localUrl = await makeThumbnail(file);
        try {
          const r = await api.shakker.uploadRef(file);
          form.refImageUrl = r.url;
          form.refImagePreview = localUrl;
          refreshRef();
          toast('Đã upload ảnh tham chiếu', 'success');
        } catch (e) {
          toast(`Upload lỗi: ${e.message}`, 'error');
          refreshRef();
        }
      }
      refWrap.appendChild(dz);
    }
  }
  refreshRef();
  cfgCard.appendChild(el('div', { class: 'field-group' },
    el('label', { class: 'field-label' }, 'Ảnh tham chiếu'),
    refWrap,
  ));

  // Negative prompt
  cfgCard.appendChild(el('div', { class: 'field-group' },
    el('label', { class: 'field-label' }, 'Negative prompt (tùy chọn)'),
    el('textarea', { class: 'textarea', id: 'shk-neg', rows: 2, placeholder: 'Để trống = dùng mặc định của Shakker' }, form.negativePrompt),
  ));

  // Images per prompt (max 4). Concurrency is unlimited — all prompts fan out
  // at once (Shakker queues them server-side), so there's no parallel-lane input.
  cfgCard.appendChild(el('div', { class: 'field-group' },
    el('label', { class: 'field-label' }, 'Số ảnh / prompt'),
    el('input', { type: 'number', class: 'input', id: 'shk-count', value: form.countPerPrompt, min: 1, max: 4 }),
    el('div', { class: 'field-help' }, 'Tối đa 4 ảnh mỗi prompt. Tất cả prompt gen đồng thời (không giới hạn luồng).'),
  ));

  // Start / cancel
  cfgCard.appendChild(el('div', { style: { display: 'flex', gap: '8px', marginTop: '16px' } },
    el('button', { class: 'btn btn-primary', style: { flex: 1 }, id: 'shk-start' },
      icon('sparkles'), el('span', null, 'Tạo ảnh')),
    el('button', { class: 'btn btn-danger hidden', id: 'shk-cancel' },
      icon('stop'), el('span', null, 'Hủy')),
  ));

  // Restore task name
  const nameInput = cfgCard.querySelector('#shk-taskname');
  nameInput.value = form.taskName || defaultTaskName();
  form.taskName = nameInput.value;
  nameInput.addEventListener('input', (e) => { form.taskName = e.target.value; });

  // ── RIGHT: prompts + gallery ──
  const right = el('div', { class: 'gen-results' });
  layout.appendChild(right);

  const promptsCard = el('div', { class: 'card', style: { marginBottom: '16px' } },
    el('div', { class: 'card-header' },
      el('div', null,
        el('h3', { class: 'card-title' }, 'Prompts'),
        el('div', { class: 'card-subtitle', id: 'shk-count-label' }, '1 prompt'),
      ),
      el('div', { style: { display: 'flex', gap: '8px' } },
        el('button', { class: 'btn btn-sm btn-ghost', id: 'shk-import' }, icon('upload', 14), 'Import .txt'),
        el('button', { class: 'btn btn-sm btn-danger', id: 'shk-clear-prompts' }, icon('trash', 14), 'Xóa tất cả'),
        el('button', { class: 'btn btn-sm btn-primary', id: 'shk-add' }, icon('plus', 14), 'Thêm'),
      ),
    ),
    el('div', { style: { background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '12px', marginBottom: '12px' } },
      el('label', { class: 'field-label' }, '⚡ Bulk prompt — paste nhiều prompts'),
      el('textarea', { class: 'textarea', id: 'shk-bulk', rows: 4,
        placeholder: 'Mỗi đoạn cách nhau bằng dòng trắng = 1 prompt riêng' }),
      el('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' } },
        el('button', { class: 'btn btn-sm btn-primary', id: 'shk-bulk-apply' }, icon('check', 14), 'Áp dụng'),
        el('div', { class: 'field-help', id: 'shk-bulk-help', style: { margin: 0 } }, 'Nhập 1 hoặc nhiều prompts'),
      ),
    ),
    el('div', { class: 'prompt-list', id: 'shk-list' }),
  );
  right.appendChild(promptsCard);

  const resultsCard = el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', null,
        el('h3', { class: 'card-title' }, 'Ảnh kết quả'),
        el('div', { class: 'card-subtitle', id: 'shk-status' }, 'Chưa có job'),
      ),
      el('div', { id: 'shk-header-actions', style: { display: 'flex', gap: '8px' } },
        el('button', { class: 'btn btn-sm btn-danger hidden', id: 'shk-clear-all',
          title: 'Xóa danh sách (file vẫn còn trên ổ đĩa)', onclick: clearCurrentTask },
          icon('trash', 14), 'Xóa danh sách'),
      ),
    ),
    el('div', { id: 'shk-results' },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 28)),
        el('div', null, 'Sinh ảnh để xem ở đây'),
      ),
    ),
  );
  right.appendChild(resultsCard);

  // ── prompts list ──
  function splitBulk(text) {
    return (text || '').split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  }
  const list = root.querySelector('#shk-list');
  const countLabel = root.querySelector('#shk-count-label');
  function refreshList() {
    // Preserve column scroll — see content.js refreshList (clear() collapses
    // height → scrollTop clamps to 0 → page jumps to top on row delete).
    const _scroller = list.closest('.gen-config, .gen-results');
    const _scrollTop = _scroller ? _scroller.scrollTop : 0;
    clear(list);
    form.prompts.forEach((p, i) => {
      const row = el('div', { class: 'prompt-row' },
        el('div', { class: 'row-number' }, String(i + 1)),
        el('textarea', { class: 'textarea', rows: 2, placeholder: 'Mô tả ảnh… (tiếng Anh cho kết quả tốt)',
          oninput: (e) => { form.prompts[i] = e.target.value; }, style: { flex: 1, minHeight: '44px' } }, p),
        el('div', { class: 'row-actions' },
          form.prompts.length > 1
            ? el('button', { class: 'btn btn-icon btn-ghost', title: 'Xóa', onclick: () => { form.prompts.splice(i, 1); refreshList(); } }, icon('trash', 14))
            : null),
      );
      row.querySelector('textarea').value = p;
      list.appendChild(row);
    });
    countLabel.textContent = `${form.prompts.length} prompt${form.prompts.length > 1 ? 's' : ''}`;
    if (_scroller) _scroller.scrollTop = _scrollTop;
  }
  refreshList();

  root.querySelector('#shk-add').addEventListener('click', () => { form.prompts.push(''); refreshList(); });
  root.querySelector('#shk-import').addEventListener('click', () => {
    const fi = document.createElement('input'); fi.type = 'file'; fi.accept = '.txt';
    fi.onchange = async () => {
      if (!fi.files[0]) return;
      const lines = (await fi.files[0].text()).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!lines.length) return toast('File rỗng', 'warning');
      form.prompts = lines; refreshList(); toast(`Đã import ${lines.length} prompts`, 'success');
    };
    fi.click();
  });
  root.querySelector('#shk-bulk-apply').addEventListener('click', () => {
    const blocks = splitBulk(root.querySelector('#shk-bulk').value);
    if (!blocks.length) return toast('Nhập prompt trước', 'warning');
    form.prompts = blocks.slice(); refreshList();
    toast(`Đã thay thế bằng ${blocks.length} prompt${blocks.length > 1 ? 's' : ''}`, 'success');
  });
  root.querySelector('#shk-clear-prompts').addEventListener('click', async () => {
    const { confirm } = await import('../ui.js');
    if (!await confirm('Xóa tất cả prompts?', 'Xác nhận')) return;
    form.prompts = ['']; refreshList(); toast('Đã xóa prompts', 'info');
  });

  // ── account chip refresh ──
  async function refreshAccount() {
    try {
      const r = await api.shakker.account();
      const emailEl = root.querySelector('#shk-acct-email');
      const powerEl = root.querySelector('#shk-acct-power');
      if (!emailEl || !powerEl) return;
      if (r.ok && r.account) {
        emailEl.textContent = r.account.email || '(shakker)';
        powerEl.textContent = (r.account.usable_power ?? 0).toLocaleString();
        if (r.account.status === 'TOKEN_EXPIRED') showBanner('Phiên Shakker hết hạn — mở shakker.ai trong Chrome và đăng nhập lại.');
        else hideBanner();
      } else {
        emailEl.textContent = 'Chưa có tài khoản';
        powerEl.textContent = '—';
        showBanner('Chưa kết nối Shakker — mở shakker.ai trong Chrome (đã cài extension) để đồng bộ tài khoản.');
      }
    } catch (e) { /* ignore */ }
  }
  function showBanner(msg) {
    if (!banner) return;
    banner.textContent = msg;
    banner.classList.remove('hidden');
  }
  function hideBanner() { if (banner) banner.classList.add('hidden'); }
  refreshAccount();

  // ── start / cancel ──
  const startBtn = root.querySelector('#shk-start');
  const cancelBtn = root.querySelector('#shk-cancel');

  startBtn.addEventListener('click', async () => {
    const prompts = form.prompts.map(p => (p || '').trim()).filter(Boolean);
    if (!prompts.length) return toast('Cần ít nhất 1 prompt', 'warning');
    form.countPerPrompt = Math.max(1, Math.min(4, parseInt(root.querySelector('#shk-count').value || '1', 10)));
    form.negativePrompt = root.querySelector('#shk-neg').value || '';

    const expanded = [];
    for (const p of prompts) for (let k = 0; k < form.countPerPrompt; k++) expanded.push(p);

    setLoading(startBtn, true);
    try {
      const res = await api.shakker.generate({
        prompts,
        checkpoint_id: form.checkpoint.id,
        base_type: form.checkpoint.base_type || FLUX_BASE_TYPE,
        aspect_ratio: form.aspect,
        loras: form.loras.map(l => ({
          model_id: l.model_id, version_id: l.version_id, weight: l.weight,
          base_type: l.base_type, name: l.name, trigger_word: l.trigger_word,
        })),
        negative_prompt: form.negativePrompt,
        ref_image_url: form.refImageUrl,
        ref_strength: form.refStrength,
        count_per_prompt: form.countPerPrompt,
        task_name: form.taskName || defaultTaskName(),
      });
      tasksStore.register(res.task_id, 'shakker', { items: expanded, aspect: form.aspect, model: form.checkpoint.name });
      attachToTask(res.task_id);
      toast(`Task #${res.task_id} (${res.items} ảnh)`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setLoading(startBtn, false);
    }
  });

  cancelBtn.addEventListener('click', async () => {
    const t = currentTaskId();
    if (!t) return;
    try { await api.shakker.cancel(t); toast('Đã hủy', 'info'); } catch (e) { toast(e.message, 'error'); }
  });

  async function clearCurrentTask() {
    const tid = currentTaskId();
    if (!tid) return;
    try {
      const t = tasksStore.get(tid);
      if (t && t.status === 'running') await api.shakker.cancel(tid).catch(() => {});
    } catch (e) { /* ignore */ }
    tasksStore.remove(tid);
    _currentTaskId = null;
    renderTaskGallery(null);
    toast('Đã xóa danh sách', 'info');
  }

  // ── gallery ──
  function aspectThumbClass(aspect) {
    if (aspect === '9:16' || aspect === '3:4' || aspect === '2:3') return 'thumb-portrait';
    if (aspect === '1:1') return 'thumb-square';
    return '';
  }

  const retryBtn = makeRetryFailedButton({
    getTaskState: () => {
      const id = currentTaskId();
      const t = id && tasksStore.get(id);
      return t ? { taskId: id, errorCount: t.error || 0, status: t.status } : null;
    },
    onResetUI: (id) => tasksStore.resetErrorItems(id),
    retryFn: (taskId) => api.shakker.retryFailed(taskId),
  });
  root.querySelector('#shk-header-actions').prepend(retryBtn);

  function renderTaskGallery(taskState) {
    if (!root.isConnected) return;
    const wrap = root.querySelector('#shk-results');
    if (!wrap) return;
    clear(wrap);
    const clearBtn = root.querySelector('#shk-clear-all');
    if (clearBtn) clearBtn.classList.toggle('hidden', !taskState);
    retryBtn.refresh(taskState);

    if (!taskState) {
      wrap.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 28)),
        el('div', null, 'Sinh ảnh để xem ở đây')));
      root.querySelector('#shk-status').textContent = 'Chưa có job';
      cancelBtn.classList.add('hidden');
      return;
    }

    const grid = el('div', { style: {
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '14px',
    } });
    const aspectCls = aspectThumbClass(taskState.aspect);

    const hasAnyDone = taskState.items.some(it => it.status === 'done' && it.output_path);
    let toolbar = null;
    if (hasAnyDone) {
      toolbar = makeSelectionToolbar({
        getCards: () => [...grid.querySelectorAll('.scene-card[data-path]')],
        pathOf: (card) => card.dataset.path,
        itemOf: (card) => {
          const id = parseInt(card.dataset.itemId || '0', 10);
          if (!id) return null;
          const t = tasksStore.get(taskState.id);
          return (t && t.items.find(x => x.id === id)) || { id };
        },
        onRegen: async (ids) => {
          await api.shakker.retryItems(taskState.id, ids);
          ids.forEach(iid => tasksStore.retryItemUI(taskState.id, iid));
        },
        onChange: () => renderTaskGallery(tasksStore.get(taskState.id)),
        onClearSelected: (paths) => {
          tasksStore.removeItemsByPath(taskState.id, paths);
          renderTaskGallery(tasksStore.get(taskState.id));
        },
      });
      wrap.appendChild(toolbar);
    }

    taskState.items.forEach((it, i) => {
      const card = el('div', { class: 'scene-card' });
      const thumb = el('div', { class: `scene-thumb ${aspectCls}` },
        el('div', { class: 'scene-number' }, `#${i + 1}`));
      if (it.status === 'done' && it.output_url) {
        const img = el('img', { src: it.output_url, loading: 'lazy', decoding: 'async', style: { width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in' } });
        img.addEventListener('click', () => window.open(it.output_url, '_blank'));
        thumb.appendChild(img);
      } else if (it.status === 'error') {
        thumb.appendChild(el('div', { class: 'scene-error', title: it.error_detail || it.error || 'Lỗi',
          style: { color: 'var(--red)', fontSize: '11px', padding: '8px', textAlign: 'center', lineHeight: '1.35', overflowY: 'auto', maxHeight: '100%' } },
          it.error || 'Lỗi'));
      } else {
        thumb.appendChild(el('div', { class: 'spinner' }));
      }
      card.appendChild(thumb);

      const chipClass = it.status === 'done' ? 'chip-green' : it.status === 'error' ? 'chip-red' : it.status === 'generating' ? 'chip-blue' : 'chip-yellow';
      const chipText = it.status === 'done' ? 'Hoàn thành' : it.status === 'error' ? 'Lỗi' : it.status === 'generating' ? 'Đang tạo' : 'Đang chờ';
      const info = el('div', { class: 'scene-info' },
        el('div', { class: 'scene-meta' }, el('span', { class: `chip ${chipClass}` }, chipText)),
        el('div', { class: 'scene-prompt' }, it.prompt));

      if (it.status === 'done' && it.output_url) {
        info.appendChild(el('div', { class: 'scene-actions' },
          el('a', { href: it.output_url, download: '', class: 'btn btn-sm btn-ghost' }, icon('download', 14), 'Tải'),
          el('button', { class: 'btn btn-sm btn-ghost', title: 'Copy prompt', onclick: () => {
            const p = (it.prompt || '').trim();
            if (!p) return toast('Không có prompt', 'warning');
            navigator.clipboard.writeText(p); toast('Đã copy prompt', 'success');
          } }, icon('copy', 14))));
      }
      // (Per-card "Gen lại" removed — regen is on the selection toolbar:
      //  tick cards → "Gen lại".)
      card.appendChild(info);
      if (it.status === 'done' && it.output_path) {
        if (it.id != null) card.dataset.itemId = String(it.id);
        attachCardCheckbox(card, it.output_path, toolbar);
      }
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    const total = taskState.total || taskState.items.length;
    const done = taskState.done, err = taskState.error;
    let statusText;
    if (taskState.status === 'running') {
      statusText = `Đang tạo ${done + err}/${total} • OK: ${done}, lỗi: ${err}`;
      cancelBtn.classList.remove('hidden');
    } else if (taskState.status === 'completed') {
      statusText = `Hoàn tất: ${done} OK / ${err} lỗi`;
      cancelBtn.classList.add('hidden');
      refreshAccount();   // power changed
    } else if (taskState.status === 'error') {
      statusText = `Lỗi: ${taskState.error_message || ''}`;
      cancelBtn.classList.add('hidden');
    } else if (taskState.status === 'cancelled') {
      statusText = 'Đã hủy'; cancelBtn.classList.add('hidden');
    } else { statusText = '—'; }
    root.querySelector('#shk-status').textContent = statusText;
  }

  // ── live subscription ──
  let unsubscribe = null;
  let _currentTaskId = null;
  let _rafId = 0;           // coalesce re-renders to ~1 per frame (perf)
  function currentTaskId() { return _currentTaskId; }
  function scheduleRender() {
    if (_rafId) return;
    _rafId = requestAnimationFrame(() => {
      _rafId = 0;
      if (!root.isConnected) return;
      renderTaskGallery(tasksStore.get(currentTaskId()));
    });
  }
  function attachToTask(taskId) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
    _currentTaskId = taskId;
    renderTaskGallery(tasksStore.get(taskId));       // immediate first paint
    unsubscribe = tasksStore.on(taskId, scheduleRender);
  }

  const pending = window.__app && window.__app._pendingTaskId;
  if (pending != null && tasksStore.get(pending)) {
    attachToTask(pending);
    window.__app._pendingTaskId = null;
  } else {
    const latest = tasksStore.latestByKind('shakker');
    if (latest) attachToTask(latest.id);
  }

  // token-expired banner via WS
  const offTokenExpired = ws.on('shakker_token_expired', () => {
    showBanner('Phiên Shakker hết hạn — mở shakker.ai trong Chrome và đăng nhập lại, rồi gen lại.');
    refreshAccount();
  });
  const offAcctUpdate = ws.on('shakker_account_updated', () => refreshAccount());

  // cleanup on navigation. `root` is the PERSISTENT #page-container so
  // document.body.contains(root) is always true — detect unmount via our own
  // marker instead, else the subscription leaks and the gallery jumps tasks.
  const obs = new MutationObserver(() => {
    if (!root.querySelector('#shk-results')) {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
      if (offTokenExpired) offTokenExpired();
      if (offAcctUpdate) offAcctUpdate();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}
