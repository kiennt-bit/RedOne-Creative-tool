// Mandatory first-run setup wizard.
//
// Flow:
//   1. app.js init() calls maybeRunSetupWizard() BEFORE rendering pages
//   2. We fetch /api/system/setup-status. If `setup_complete_for_current_version`
//      is true → resolve immediately and let the app boot normally.
//   3. Otherwise render a fullscreen modal that BLOCKS navigation until
//      the user clicks "Cài đặt tự động" and the pipeline finishes.
//   4. Backend runs install_python → pip install → download model,
//      streaming progress via WS `setup_progress`. We reattach to an
//      in-flight install via /setup-state on page reload.
//
// The modal is intentionally heavy/hard to dismiss. The user picked
// "Bắt buộc — phải cài đủ mới vào tool" so we don't expose a Skip
// button. They can close the tool entirely if they really want out.

import { el, clear, toast, icon } from './ui.js';
import { api } from './api.js';
import { ws } from './ws.js';


/**
 * Resolves when setup is verified OR completed by the user.
 * Renders the wizard modal in place of #app contents if needed.
 */
export async function maybeRunSetupWizard() {
  let status;
  try {
    status = await api.system.setupStatus();
  } catch (e) {
    // If the endpoint itself fails (very old EXE, network glitch),
    // don't gate the UI — let the app boot normally and surface the
    // problem through normal error toasts.
    console.warn('setupStatus failed, skipping wizard:', e);
    return;
  }

  if (status.setup_complete_for_current_version && status.all_ready) {
    return;   // already done — nothing to show
  }

  // Show modal and wait for it to resolve
  return new Promise((resolve) => {
    renderWizard(status, resolve);
  });
}


function renderWizard(initialStatus, onComplete) {
  const root = el('div', {
    style: {
      position: 'fixed', inset: 0,
      background: 'rgba(20, 20, 20, 0.92)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999, padding: '20px',
    },
  });

  const card = el('div', {
    style: {
      background: 'var(--bg-1)',
      borderRadius: '14px',
      width: '100%', maxWidth: '720px', maxHeight: '90vh',
      padding: '28px 32px',
      boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    },
  });
  root.appendChild(card);

  // Header
  card.appendChild(el('h2', {
    style: { margin: '0 0 4px', color: 'var(--brand)', fontSize: '22px' },
  }, '🚀 Chào mừng đến RedOne Creative!'));
  card.appendChild(el('p', { class: 'field-help', style: { margin: '0 0 18px' } },
    'Lần đầu chạy phiên bản mới — cần cài 1 vài thứ. Sẽ mất 5-15 phút tùy mạng.'));

  // Step list
  const stepListWrap = el('div', { style: { marginBottom: '14px' } });
  card.appendChild(stepListWrap);

  function stepRow(key, label, state, hint) {
    // state: pending | running | done | skipped | error
    const icons = {
      pending: '⏳', running: '🔄', done: '✓', skipped: '➜', error: '✕',
    };
    const colors = {
      pending: 'var(--text-muted)', running: 'var(--brand)',
      done: 'var(--green)', skipped: 'var(--text-muted)', error: 'var(--red)',
    };
    return el('div', {
      'data-step': key,
      style: {
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 12px', marginBottom: '4px',
        background: 'var(--bg-2)', borderRadius: '8px',
        border: '1px solid var(--border)',
        opacity: state === 'pending' ? 0.6 : 1,
        transition: 'opacity 0.2s',
      },
    },
      el('span', {
        style: { fontSize: '18px', color: colors[state], minWidth: '24px' },
      }, icons[state]),
      el('div', { style: { flex: 1 } },
        el('div', { style: { fontWeight: 600 } }, label),
        hint ? el('div', { class: 'field-help', style: { marginTop: '2px' } }, hint) : null,
      ),
    );
  }

  function rebuildStepList(status, liveState) {
    clear(stepListWrap);
    const currentStep = liveState?.current_step;
    const stage = liveState?.stage || 'idle';

    function status_for(key, isNeeded, isDone) {
      if (isDone) return 'done';
      if (stage === 'running' && currentStep === key) return 'running';
      if (!isNeeded) return 'done';   // not needed = effectively done
      if (stage === 'done') return 'done';
      if (stage === 'error' && currentStep === key) return 'error';
      return 'pending';
    }

    // MSVC — informational, never auto-installed
    stepListWrap.appendChild(stepRow(
      'msvc',
      'Microsoft Visual C++ Redistributable',
      status.has_msvc ? 'done' : 'skipped',
      status.has_msvc
        ? 'Đã có sẵn trong Windows'
        : 'Không tự cài. Nếu sau này gặp lỗi DLL → tải tay tại '
          + status.msvc_install_url,
    ));

    stepListWrap.appendChild(stepRow(
      'python',
      'Python 3.12',
      status_for('python', !status.has_python, status.has_python),
      status.has_python
        ? `Đã có: ${status.python_path}`
        : 'Tự tải + cài (~30MB, không cần UAC, ~30 giây)',
    ));

    const needsPip = !(
      status.has_torch && status.has_simple_lama && status.has_cv2_ext
      && status.has_google_genai
    );
    stepListWrap.appendChild(stepRow(
      'pip',
      'PyTorch + simple-lama + opencv + google-genai',
      status_for('pip', needsPip, !needsPip),
      status.has_cuda
        ? 'GPU NVIDIA detected → cài CUDA build (~2GB, 5-10 phút)'
        : 'Không có NVIDIA GPU → cài CPU build (~750MB, 3-5 phút)',
    ));

    stepListWrap.appendChild(stepRow(
      'model',
      'big-lama.pt (AI inpainting model)',
      status_for('model', !status.has_model, status.has_model),
      'Tải từ GitHub release (~204MB, 1-2 phút)',
    ));
  }

  rebuildStepList(initialStatus, { stage: 'idle' });

  // Progress bar + label
  const label = el('div', {
    class: 'field-help',
    style: {
      marginTop: '12px', wordBreak: 'break-all', minHeight: '20px',
      fontFamily: 'JetBrains Mono, monospace', fontSize: '11px',
    },
  }, '');
  const barWrap = el('div', {
    style: {
      marginTop: '6px', height: '10px', background: 'var(--bg-2)',
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

  // Log panel (scrolls with pip output)
  const logBox = el('div', {
    style: {
      marginTop: '12px', height: '160px', overflowY: 'auto',
      background: 'var(--bg-2)', padding: '10px', borderRadius: '6px',
      fontFamily: 'JetBrains Mono, monospace', fontSize: '11px',
      color: 'var(--text-muted)', whiteSpace: 'pre-wrap',
      display: 'none',
    },
  });

  card.appendChild(label);
  card.appendChild(barWrap);
  card.appendChild(logBox);

  // Action button
  const actionBtn = el('button', {
    class: 'btn btn-primary',
    style: { marginTop: '18px', alignSelf: 'flex-end', minWidth: '180px' },
  }, 'Cài đặt tự động');
  card.appendChild(actionBtn);

  document.body.appendChild(root);

  // ── State machine ────────────────────────────────────────────
  let currentStatus = initialStatus;
  let currentStage = 'idle';
  let unsub = null;

  function apply(liveState) {
    if (!liveState) return;
    currentStage = liveState.stage;

    const pct = liveState.percent || 0;
    bar.style.width = `${pct}%`;
    label.textContent = liveState.step_label || liveState.stage || '';

    if (Array.isArray(liveState.log_tail) && liveState.log_tail.length) {
      logBox.style.display = 'block';
      logBox.textContent = liveState.log_tail.slice(-20).join('\n');
      logBox.scrollTop = logBox.scrollHeight;
    }

    // Color the bar based on stage
    if (liveState.stage === 'error') {
      bar.style.background = 'var(--red)';
    } else if (liveState.stage === 'done') {
      bar.style.background = 'var(--green)';
    } else {
      bar.style.background = 'var(--brand)';
    }

    rebuildStepList(currentStatus, liveState);

    // Button state
    if (liveState.stage === 'running') {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Đang cài…';
    } else if (liveState.stage === 'done') {
      actionBtn.disabled = false;
      actionBtn.textContent = '✓ Hoàn tất — Vào tool';
    } else if (liveState.stage === 'error') {
      actionBtn.disabled = false;
      actionBtn.textContent = 'Thử lại';
    }
  }

  // Reattach to in-progress install if user reloaded the page
  api.system.setupState().then(s => {
    if (s && s.stage !== 'idle') apply(s);
  }).catch(() => {});

  unsub = ws.on('setup_progress', apply);

  actionBtn.addEventListener('click', async () => {
    if (currentStage === 'done') {
      // Wizard complete — close and let app boot
      if (unsub) unsub();
      root.remove();
      onComplete();
      return;
    }
    if (currentStage === 'running') return;

    // Start (or retry) the pipeline
    actionBtn.disabled = true;
    actionBtn.textContent = 'Đang gửi yêu cầu…';
    try {
      await api.system.setupRun();
      // From here, WS events drive the UI
    } catch (e) {
      label.textContent = `Lỗi: ${e.message}`;
      actionBtn.disabled = false;
      actionBtn.textContent = 'Thử lại';
    }
  });
}
