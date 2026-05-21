// Dedicated "Xóa Watermark Video" page (sidebar group: Xử lý video).
//
// UX is intentionally minimal — match the standalone Red One Creative Tools
// Electron app the user is migrating from:
//   1. Drop one or many MP4 files (multi-select OK)
//   2. Click "Bắt đầu" — videos process sequentially, no per-job settings
//   3. Each video has a status chip + progress bar in the queue
//
// Engine and device choice are deliberately HIDDEN from the user. The
// backend's `auto` resolves to LaMa if all deps are installed, else OpenCV.
// Built-in Veo3 mask is always used (Veo logo bottom-right). For custom
// masks/rect-drawing, users go to the image-only "Xóa Logo / Watermark" page.
//
// A dependency status panel sits at the bottom: chips + a single
// copy-paste install command. Reduces user confusion when something isn't
// installed yet (matches the screenshot the user complained about).

import { el, clear, toast, icon } from '../ui.js';
import { api } from '../api.js';
import { ws } from '../ws.js';


// Per-file state. We keep this in a module-scoped Map keyed by a synthetic
// id so the queue survives re-renders within the same page session.
let nextId = 1;
const queue = new Map();   // id -> {file, name, size, status, progress, label, outputUrl, error}

// Backend's job_id <-> our queue id. Filled in once watermark_started fires
// for the in-flight upload so subsequent progress events can route correctly.
let activeQueueId = null;
let lamaStatusCache = null;


export function renderVideoWatermark(root) {
  // Hero
  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Xóa Watermark Video'),
      el('p', null,
        'Xóa logo Veo (hoặc watermark khác có mask sẵn) khỏi nhiều video cùng lúc. '
        + 'Sequential processing — mỗi video ~10-60s tùy độ dài.'),
    ),
  ));

  const layout = el('div', { class: 'gen-layout' });
  root.appendChild(layout);

  // ─── LEFT: drop zone + actions ──────────────────────
  const left = el('div', { class: 'gen-config' });
  layout.appendChild(left);

  left.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Video nguồn'),
    el('p', { class: 'card-subtitle', style: { marginBottom: '12px' } },
      'Có thể chọn nhiều file. File sẽ được xử lý theo thứ tự.'),
    el('div', { class: 'dropzone', id: 'vwm-dz', style: { marginTop: '12px' } },
      el('div', { class: 'dropzone-icon' }, icon('upload', 28)),
      el('div', null, 'Kéo thả nhiều file MP4 hoặc click để chọn'),
      el('div', { class: 'field-help', style: { marginTop: '6px' } },
        'Hỗ trợ: .mp4, .mov, .webm, .mkv'),
      el('input', {
        type: 'file', accept: 'video/*', multiple: 'true',
        id: 'vwm-file', style: { display: 'none' },
      }),
    ),
    el('div', { style: { display: 'flex', gap: '8px', marginTop: '16px' } },
      el('button', { class: 'btn btn-primary', style: { flex: 1 }, id: 'vwm-go' },
        icon('sparkles'), 'Bắt đầu xóa watermark'),
      el('button', { class: 'btn btn-ghost', id: 'vwm-clear' },
        icon('trash', 14), 'Xóa hàng đợi'),
    ),
    el('div', { class: 'field-help', style: { marginTop: '12px' } },
      'Mặc định dùng mask Veo logo bottom-right + auto chọn engine tốt nhất có sẵn '
      + '(LaMa AI nếu cài, OpenCV nếu không). Output lưu tại '
      + 'outputs/video/watermark_removed/<ngày>/<tên> [RedOne].mp4'),
  ));

  // Dependency status card — hidden by default; loadDepsStatus() reveals
  // it only when something is missing. Avoids visual noise when everything
  // is already installed.
  const depsCard = el('div', { class: 'card', id: 'vwm-deps-card',
    style: { marginTop: '16px', display: 'none' } },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Trạng thái cài đặt'),
      el('button', { class: 'btn btn-sm btn-ghost', id: 'vwm-deps-refresh',
        title: 'Kiểm tra lại sau khi vừa cài xong (không cần restart server)' },
        icon('refresh', 14), 'Kiểm tra lại'),
    ),
    el('div', { id: 'vwm-deps', class: 'field-help' }, 'Đang kiểm tra...'),
  );
  left.appendChild(depsCard);

  // Wire refresh button — re-runs the deps check immediately
  depsCard.querySelector('#vwm-deps-refresh').addEventListener('click', () => {
    loadDepsStatus(root);
  });

  // ─── RIGHT: queue ────────────────────────────────────
  const right = el('div', { class: 'gen-results' });
  layout.appendChild(right);

  right.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', null,
        el('h3', { class: 'card-title' }, 'Hàng đợi xử lý'),
        el('div', { class: 'card-subtitle', id: 'vwm-summary' }, 'Chưa có file'),
      ),
    ),
    el('div', { id: 'vwm-queue' },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('play', 32)),
        el('div', null, 'Drop video vào ô bên trái để bắt đầu'),
      ),
    ),
  ));

  // ─── Wire dropzone ──────────────────────────────────
  const dz = root.querySelector('#vwm-dz');
  const fi = root.querySelector('#vwm-file');
  dz.addEventListener('click', () => fi.click());
  ['dragover', 'dragleave', 'drop'].forEach(ev => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.toggle('dragover', ev === 'dragover');
      if (ev === 'drop' && e.dataTransfer.files.length) {
        addFiles([...e.dataTransfer.files]);
      }
    });
  });
  fi.addEventListener('change', () => {
    addFiles([...fi.files]);
    fi.value = '';
  });

  function addFiles(files) {
    for (const f of files) {
      // Crude video MIME / ext filter — don't block on edge cases
      const ok = f.type.startsWith('video/')
        || /\.(mp4|mov|webm|mkv|avi)$/i.test(f.name);
      if (!ok) {
        toast(`Bỏ qua "${f.name}" — không phải video`, 'warning');
        continue;
      }
      const id = nextId++;
      queue.set(id, {
        id, file: f, name: f.name, size: f.size,
        status: 'queued', progress: 0, label: 'Đang chờ',
      });
    }
    renderQueue();
  }

  // Render entire queue list (called on every change — small list, no diff needed)
  function renderQueue() {
    const wrap = root.querySelector('#vwm-queue');
    clear(wrap);
    if (queue.size === 0) {
      wrap.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('play', 32)),
        el('div', null, 'Drop video vào ô bên trái để bắt đầu'),
      ));
      root.querySelector('#vwm-summary').textContent = 'Chưa có file';
      return;
    }
    const items = [...queue.values()];
    const stats = {
      done: items.filter(x => x.status === 'done').length,
      err: items.filter(x => x.status === 'error').length,
      running: items.filter(x => x.status === 'running').length,
    };
    root.querySelector('#vwm-summary').textContent =
      `${items.length} file • OK: ${stats.done} • Lỗi: ${stats.err}`
      + (stats.running ? ` • Đang chạy: ${stats.running}` : '');

    for (const it of items) {
      const chipClass = it.status === 'done' ? 'chip-green'
                     : it.status === 'error' ? 'chip-red'
                     : it.status === 'running' ? 'chip-blue'
                     : 'chip-yellow';
      const chipText = it.status === 'done' ? 'Hoàn thành'
                     : it.status === 'error' ? 'Lỗi'
                     : it.status === 'running' ? 'Đang xử lý'
                     : 'Đang chờ';
      const sizeStr = `${(it.size / 1024 / 1024).toFixed(1)} MB`;

      const row = el('div', {
        style: {
          padding: '12px',
          marginBottom: '8px',
          background: 'var(--bg-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
        },
      },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          el('span', { class: `chip ${chipClass}` }, chipText),
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('div', { style: {
              fontWeight: 600, fontSize: '13px',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            } }, it.name),
            el('div', { class: 'field-help' }, `${sizeStr} • ${it.label || ''}`),
          ),
          // Per-row remove button (only when not running)
          it.status !== 'running' ? el('button', {
            class: 'btn btn-icon btn-ghost', title: 'Bỏ khỏi hàng đợi',
            onclick: () => { queue.delete(it.id); renderQueue(); },
          }, icon('x', 14)) : null,
        ),
        // Progress bar — only shown while running or post-done
        it.status === 'running' || (it.status === 'done' && it.progress > 0)
          ? el('div', {
              style: {
                marginTop: '8px', height: '6px', background: 'var(--bg-1)',
                borderRadius: '3px', overflow: 'hidden',
              },
            },
              el('div', {
                style: {
                  height: '100%', width: `${it.progress || 0}%`,
                  background: it.status === 'done' ? 'var(--green)' : 'var(--brand)',
                  transition: 'width 0.3s',
                },
              }),
            )
          : null,
        // Done actions: download + open output folder (no inline preview —
        // keeps the queue compact when processing many files).
        it.status === 'done' && it.outputUrl
          ? el('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              el('a', {
                href: it.outputUrl, download: '',
                class: 'btn btn-sm btn-primary',
              }, icon('download', 14), 'Tải về'),
              it.outputPath ? el('button', {
                class: 'btn btn-sm btn-ghost',
                title: 'Mở thư mục chứa file đã xóa watermark',
                onclick: async () => {
                  try {
                    await api.files.openFolder(it.outputPath);
                  } catch (e) { toast(e.message, 'error'); }
                },
              }, icon('folder', 14), 'Mở thư mục') : null,
            )
          : null,
        it.status === 'error' && it.error
          ? el('div', {
              style: { marginTop: '6px', color: 'var(--red)', fontSize: '11px' },
            }, it.error)
          : null,
      );
      wrap.appendChild(row);
    }
  }

  // ─── Subscribe WS events ────────────────────────────
  // We watch all watermark_* events while on this page. activeQueueId routes
  // events to the correct queue item. Other pages also receive these events
  // (gallery's bulk button uses the same channel) so we must filter strictly
  // by whether we have an active upload in flight.
  const unsubs = [
    ws.on('watermark_started', (d) => {
      if (activeQueueId == null) return;
      const it = queue.get(activeQueueId);
      if (it) {
        it.job_id = d.job_id;
        it.status = 'running';
        it.label = 'Bắt đầu…';
        renderQueue();
      }
    }),
    ws.on('watermark_progress', (d) => {
      if (activeQueueId == null) return;
      const it = queue.get(activeQueueId);
      // The video tab can also receive batch progress from the gallery flow;
      // ignore unless this event's job_id matches the one we just started.
      if (!it || (it.job_id && d.job_id !== it.job_id)) return;
      it.progress = d.progress || 0;
      it.label = d.status || '';
      renderQueue();
    }),
  ];

  const obs = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      for (const u of unsubs) try { u(); } catch (e) { /* ignore */ }
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // ─── Buttons ────────────────────────────────────────
  root.querySelector('#vwm-clear').addEventListener('click', () => {
    const running = [...queue.values()].find(x => x.status === 'running');
    if (running) return toast('Đang xử lý, không thể xóa hàng đợi', 'warning');
    queue.clear();
    renderQueue();
  });

  root.querySelector('#vwm-go').addEventListener('click', async () => {
    const pending = [...queue.values()].filter(x => x.status === 'queued' || x.status === 'error');
    if (pending.length === 0) {
      return toast('Hàng đợi trống', 'warning');
    }
    if (lamaStatusCache && !lamaStatusCache.opencv_ok && !lamaStatusCache.lama_ok) {
      return toast(
        'Chưa cài đủ dependencies — xem mục "Trạng thái cài đặt" bên dưới',
        'error',
      );
    }
    const btn = root.querySelector('#vwm-go');
    btn.disabled = true;
    btn.textContent = `Đang xử lý 0/${pending.length}…`;

    for (let i = 0; i < pending.length; i++) {
      const it = pending[i];
      btn.textContent = `Đang xử lý ${i + 1}/${pending.length}…`;
      it.status = 'running';
      it.progress = 0;
      it.label = 'Upload…';
      it.error = null;
      it.outputUrl = null;
      it.job_id = null;
      activeQueueId = it.id;
      renderQueue();

      try {
        const fd = new FormData();
        fd.append('file', it.file);
        fd.append('use_default_mask', 'true');
        fd.append('method', 'auto');
        fd.append('device', 'auto');
        const r = await api.media.videoWatermark(fd);
        it.status = 'done';
        it.progress = 100;
        it.label = 'Hoàn thành';
        it.outputUrl = r.url;
        it.outputPath = r.path;
      } catch (e) {
        it.status = 'error';
        it.error = e.message || 'Lỗi không xác định';
        it.label = 'Lỗi';
      } finally {
        activeQueueId = null;
        renderQueue();
      }
    }

    btn.disabled = false;
    btn.innerHTML = '';
    btn.appendChild(icon('sparkles'));
    btn.append(' Bắt đầu xóa watermark');

    const stats = [...queue.values()];
    const okN = stats.filter(x => x.status === 'done').length;
    const errN = stats.filter(x => x.status === 'error').length;
    if (errN === 0) {
      toast(`Hoàn tất ${okN} video — file mới có suffix [RedOne].mp4`, 'success');
    } else {
      toast(`${okN} OK / ${errN} lỗi — xem chi tiết trong hàng đợi`, 'warning');
    }
  });

  // ─── Load deps status ───────────────────────────────
  loadDepsStatus(root);
}


async function loadDepsStatus(root) {
  const wrap = root.querySelector('#vwm-deps');
  const card = root.querySelector('#vwm-deps-card');
  try {
    const st = await api.media.lamaStatus();
    lamaStatusCache = st;

    // Hide the entire card when LaMa is fully ready — user doesn't need
    // to see install chips on every visit if everything works.
    if (st.lama_ok) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';

    clear(wrap);

    const chip = (ok, text) => el('span', {
      class: ok ? 'chip chip-green' : 'chip chip-yellow',
      style: { marginRight: '6px', marginBottom: '6px' },
    }, `${ok ? '✓' : '⚠'} ${text}`);

    const chipsRow = el('div', { style: { marginBottom: '10px' } },
      chip(st.python_ok, 'Python 3'),
      chip(st.ffmpeg_ok, 'FFmpeg'),
      chip(st.cv2, 'opencv-python'),
      chip(st.torch, 'PyTorch'),
      chip(st.simple_lama, 'simple-lama-inpainting'),
      chip(st.model_ok, 'big-lama.pt model'),
      ...(st.cuda ? [chip(true, 'CUDA GPU')] : []),
    );
    wrap.appendChild(chipsRow);

    // Show server's Python path so user can see WHICH interpreter we're
    // checking against. Catches the common gotcha: user installs with
    // `py -m pip` but server runs a different Python → status stays ⚠.
    if (st.python) {
      wrap.appendChild(el('div', {
        class: 'field-help',
        style: {
          marginBottom: '10px', fontSize: '11px',
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--text-muted)',
        },
        title: 'Server đang dùng Python này — phải cài packages vào ĐÚNG Python này',
      }, `🔍 Đang kiểm tra: ${st.python}`));
    }

    // Verdict line
    let verdict, verdictClass;
    if (st.opencv_ok) {
      verdict = '✓ Chạy được với OpenCV — cài thêm để có LaMa quality cao hơn';
      verdictClass = 'chip-green';
    } else if (!st.python_ok) {
      verdict = '✕ Cần cài Python 3 trước';
      verdictClass = 'chip-red';
    } else {
      verdict = '⚠ Cần cài thêm — xem hướng dẫn bên dưới';
      verdictClass = 'chip-yellow';
    }
    wrap.appendChild(el('div', {
      class: `chip ${verdictClass}`,
      style: { fontSize: '12px', fontWeight: 600 },
    }, verdict));

    // Install instructions block — always shown when card is visible
    // (we only get here if !lama_ok, so something IS missing).
    //
    // CRITICAL: use the SAME interpreter the server is running. On Windows
    // it's common to have multiple Python installs (Anaconda, py launcher,
    // python.org). If the user installs with `py -m pip` but the server
    // runs `python launch.py`, packages land in the WRONG Python and the
    // status chips stay ⚠ even after a "successful" install.
    //
    // We always show the server's actual sys.executable in the command and
    // wrap it in quotes for safety (path may contain spaces).
    const missingMin = !st.opencv_ok;
    {
      const serverPython = st.python || 'python';
      const needsQuote = serverPython.includes(' ');
      const pyArg = needsQuote ? `"${serverPython}"` : serverPython;
      const minCmd = `${pyArg} -m pip install opencv-python simple-lama-inpainting torch imageio-ffmpeg`;
      const helpBox = el('div', {
        style: {
          marginTop: '14px',
          padding: '12px',
          background: 'var(--bg-2)',
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--border)',
        },
      },
        el('div', { style: { fontWeight: 600, marginBottom: '8px' } },
          missingMin ? 'Để chạy được (1 lần):' : 'Để dùng LaMa AI quality (khuyến nghị):'),
        el('div', { style: {
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '12px',
          background: 'var(--bg-1)',
          padding: '8px',
          borderRadius: '6px',
          wordBreak: 'break-all',
          marginBottom: '8px',
        } }, minCmd),
        el('button', {
          class: 'btn btn-sm btn-primary',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(minCmd);
              toast('Đã copy lệnh — paste vào PowerShell / cmd rồi Enter', 'success');
            } catch (e) {
              toast('Copy thất bại — copy thủ công từ ô trên', 'error');
            }
          },
        }, icon('copy', 14), 'Copy lệnh'),
        el('div', { class: 'field-help', style: { marginTop: '10px' } },
          missingMin
            ? '→ Mở PowerShell (Win + X → Terminal) → paste lệnh trên → Enter → đợi 2-5 phút (~2GB tải) → '
              + 'restart RedOne. Lần đầu chạy LaMa sẽ tự download model ~204MB.'
            : '→ OpenCV đã cài, dùng được luôn. LaMa cho chất lượng cao hơn nếu bạn muốn.'),
        el('div', { class: 'field-help', style: { marginTop: '6px' } },
          'Nếu báo "py: not recognized" → chưa cài Python. '),
        st.python_ok ? null : el('div', {
          class: 'field-help',
          style: { marginTop: '6px', color: 'var(--red)' },
        }, '⚠ Chưa thấy Python — tải từ https://python.org/downloads/ (tick "Add Python to PATH" khi cài)'),
      );
      wrap.appendChild(helpBox);
    }
  } catch (e) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', { style: { color: 'var(--red)' } },
      `Không check được: ${e.message}`));
  }
}
