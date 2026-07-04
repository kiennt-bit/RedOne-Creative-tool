/**
 * RedOne GenFill — Photoshop CEP Panel Logic
 *
 * Everything runs inside Photoshop — no external server needed.
 * The panel embeds a Node.js HTTP bridge server that the Chrome extension
 * ("RedOne Auth Helper") connects to, and calls Google Flow API directly.
 *
 * Architecture:
 *   Panel (this) → embedded_server.js (bridge on port 8000)
 *                → flow_api.js (Google Flow via bridge)
 *   Chrome Extension polls port 8000 for tasks
 */

/* global CSInterface, require */

// ── Configuration ───────────────────────────────────────────
const SELECTION_POLL_INTERVAL = 1500; // ms
const EXT_CHECK_INTERVAL = 3000;      // ms

// ── State ───────────────────────────────────────────────────
let csInterface = null;
let isGenerating = false;
let lastResultPath = null;
let serverMode = 'none'; // 'embedded' | 'external' | 'none'

// Node.js modules (available in CEP)
let embeddedServer = null;
let flowApi = null;
let fs = null;

// ── DOM refs ────────────────────────────────────────────────
const $connectionStatus = document.getElementById('connection-status');
const $docName = document.getElementById('doc-name');
const $docSize = document.getElementById('doc-size');
const $selectionStatus = document.getElementById('selection-status');
const $modelSelect = document.getElementById('model-select');
const $promptInput = document.getElementById('prompt-input');
const $btnGenerate = document.getElementById('btn-generate');
const $progressSection = document.getElementById('progress-section');
const $progressText = document.getElementById('progress-text');
const $resultSection = document.getElementById('result-section');
const $resultImage = document.getElementById('result-image');
const $resultMeta = document.getElementById('result-meta');
const $btnApply = document.getElementById('btn-apply');
const $btnRegenerate = document.getElementById('btn-regenerate');
const $errorSection = document.getElementById('error-section');
const $errorText = document.getElementById('error-text');

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    csInterface = new CSInterface();
  } catch (e) {
    console.warn('CSInterface not available — running in debug mode');
    csInterface = null;
  }

  // Load Node.js modules
  try {
    fs = require('fs');
    const nodePath = require('path');
    // In CEP, require() resolves relative to the HTML file's directory,
    // NOT the JS file's directory. Use __dirname to build correct paths.
    const jsDir = nodePath.join(__dirname, 'js');
    embeddedServer = require(nodePath.join(jsDir, 'embedded_server.js'));
    flowApi = require(nodePath.join(jsDir, 'flow_api.js'));
    console.log('[main] Node.js modules loaded from:', jsDir);
  } catch (e) {
    console.warn('[main] Node.js require failed:', e.message);
  }

  // Wire up events
  $btnGenerate.addEventListener('click', handleGenerate);
  $btnApply.addEventListener('click', handleApply);
  $btnRegenerate.addEventListener('click', handleRegenerate);
  $promptInput.addEventListener('input', updateGenerateButton);
  $promptInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleGenerate();
    }
  });

  // Start the embedded server
  await initServer();

  // Start polling
  pollDocumentState();
  setInterval(pollDocumentState, SELECTION_POLL_INTERVAL);
  setInterval(checkExtensionStatus, EXT_CHECK_INTERVAL);
});

// ── Server Init ─────────────────────────────────────────────

async function initServer() {
  if (!embeddedServer) {
    // Browser debug mode — try external backend
    setConnectionStatus('loading', 'Debug mode…');
    serverMode = 'none';
    return;
  }

  setConnectionStatus('loading', 'Đang khởi động server…');

  try {
    const port = await embeddedServer.startServer(embeddedServer.DEFAULT_PORT);
    if (port > 0) {
      serverMode = 'embedded';
      setConnectionStatus('online', `Embedded (port ${port})`);
      console.log(`[main] Embedded server running on port ${port}`);
    } else {
      // Port 8000 in use — RedOne or another instance is running
      serverMode = 'external';
      setConnectionStatus('online', 'RedOne detected');
      console.log('[main] Using external server (port 8000 in use)');
    }
  } catch (e) {
    console.error('[main] Server init failed:', e);
    setConnectionStatus('offline', 'Server lỗi');
    serverMode = 'none';
  }
  updateGenerateButton();
}

// ── Extension Status Check ──────────────────────────────────

function checkExtensionStatus() {
  if (serverMode === 'embedded' && embeddedServer) {
    const state = embeddedServer.bridge.snapshotState();
    if (state.extension_live) {
      const status = embeddedServer.bridge._extLastStatus;
      if (status === 'ready') {
        setConnectionStatus('online', '✓ Sẵn sàng');
      } else {
        setConnectionStatus('loading', 'Extension: ' + status);
      }
    } else {
      setConnectionStatus('offline', 'Chờ extension…');
    }
  } else if (serverMode === 'external') {
    // Check external health
    const ac1 = new AbortController(); setTimeout(() => ac1.abort(), 3000);
    fetch('http://127.0.0.1:8001/api/ps-genfill/health', {
      method: 'GET',
      cache: 'no-store',
      signal: ac1.signal,
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setConnectionStatus('online', data.account_email || 'RedOne'))
      .catch(() => setConnectionStatus('offline', 'Mất kết nối'));
  }
  updateGenerateButton();
}

function isReady() {
  if (serverMode === 'embedded' && embeddedServer) {
    return embeddedServer.bridge.isExtensionLive();
  }
  if (serverMode === 'external') {
    return true; // external server handles availability
  }
  return false;
}

function setConnectionStatus(state, text) {
  const dot = $connectionStatus.querySelector('.status-dot');
  const label = $connectionStatus.querySelector('.status-text');
  dot.className = 'status-dot ' + state;
  label.textContent = text;
}

// ── Document State Polling ──────────────────────────────────
function pollDocumentState() {
  if (!csInterface) {
    $docName.textContent = 'Debug Mode';
    $docSize.textContent = '1920×1080';
    $selectionStatus.textContent = 'Simulated';
    $selectionStatus.className = 'info-value has-selection';
    updateGenerateButton();
    return;
  }

  csInterface.evalScript('getDocumentInfo()', (result) => {
    try {
      const info = JSON.parse(result);
      if (info.error) {
        $docName.textContent = 'Chưa mở file';
        $docSize.textContent = '—';
      } else {
        $docName.textContent = info.name || '—';
        $docSize.textContent = `${info.width}×${info.height}`;
      }
    } catch (e) {
      $docName.textContent = 'Chưa mở file';
      $docSize.textContent = '—';
    }
  });

  csInterface.evalScript('hasActiveSelection()', (result) => {
    if (result === 'true') {
      $selectionStatus.textContent = '✓ Có vùng chọn';
      $selectionStatus.className = 'info-value has-selection';
    } else {
      $selectionStatus.textContent = 'Chưa chọn vùng';
      $selectionStatus.className = 'info-value no-selection';
    }
    updateGenerateButton();
  });
}

// ── Generate Button State ───────────────────────────────────
function updateGenerateButton() {
  const hasPrompt = $promptInput.value.trim().length > 0;
  const ready = isReady() || serverMode === 'external';
  $btnGenerate.disabled = !ready || isGenerating || !hasPrompt;
}

// ── Generate Flow ───────────────────────────────────────────
async function handleGenerate() {
  if (isGenerating) return;
  if (!isReady() && serverMode !== 'external') {
    showError('Extension chưa kết nối. Mở Chrome + extension + tab labs.google/fx');
    return;
  }

  const prompt = $promptInput.value.trim();
  if (!prompt) {
    showError('Vui lòng nhập prompt mô tả nội dung muốn tạo.');
    return;
  }

  lastPromptText = prompt;

  isGenerating = true;
  document.body.classList.add('is-generating');
  hideError();
  hideResult();
  showProgress('Đang export từ Photoshop…');
  updateGenerateButton();

  try {
    showProgress('Đang chuẩn bị dữ liệu…');

    // Step 1: Export document + mask
    const exportResult = await exportFromPhotoshop();
    const { imagePath, maskPath, cropX, cropY, cropW, cropH } = exportResult;
    
    lastCropX = cropX || 0;
    lastCropY = cropY || 0;
    lastCropW = cropW || 0;
    lastCropH = cropH || 0;

    showProgress('Đang gửi lên server (có thể mất 10-30s)…');

    let result;
    const isUpscale = document.getElementById('upscale-4k').checked;

    if (serverMode === 'embedded' && flowApi) {
      // ── EMBEDDED MODE: call flow API directly ──
      result = await flowApi.generateFill(
        imagePath,
        maskPath,
        prompt,
        $modelSelect.value,
        isUpscale
      );
    } else if (serverMode === 'external') {
      // ── EXTERNAL MODE: POST to RedOne backend ──
      result = await sendToExternalBackend(imagePath, maskPath, prompt, isUpscale);
    } else {
      throw new Error('Không có server khả dụng');
    }

    hideProgress();
    showResult(result);

  } catch (err) {
    hideProgress();
    showError(err.message || String(err));
  } finally {
    isGenerating = false;
    document.body.classList.remove('is-generating');
    updateGenerateButton();
  }
}

function exportFromPhotoshop() {
  return new Promise((resolve, reject) => {
    if (!csInterface) {
      // Debug mode
      resolve({ imagePath: 'debug', maskPath: 'debug' });
      return;
    }

    // Step 1: Normalize and export (crop to 1376:768 ratio + Smart Object)
    csInterface.evalScript('normalizeAndExport()', (resultStr) => {
      if (resultStr.indexOf('ERROR:') === 0) {
        reject(new Error('Export ảnh thất bại: ' + resultStr.substring(6)));
        return;
      }

      let cropInfo;
      try {
        cropInfo = JSON.parse(resultStr);
      } catch (e) {
        reject(new Error('Parse crop info thất bại: ' + resultStr.slice(0, 200)));
        return;
      }

      const imagePath = cropInfo.path;
      const { cropX, cropY, cropW, cropH } = cropInfo;

      console.log(`[main] Normalized: ${cropW}x${cropH} (crop: ${cropX},${cropY})`);

      // Step 2: Export mask at normalized dimensions
      csInterface.evalScript('hasActiveSelection()', (hasSel) => {
        if (hasSel === 'true') {
          // Export mask with crop offset adjustment
          const maskScript = `exportNormalizedMask(${cropX}, ${cropY}, ${cropW}, ${cropH})`;
          csInterface.evalScript(maskScript, (maskPath) => {
            if (maskPath.indexOf('ERROR:') === 0) {
              // Fallback: try without normalization
              csInterface.evalScript('exportSelectionMaskAM()', (maskPath2) => {
                if (maskPath2.indexOf('ERROR:') === 0) {
                  reject(new Error('Export mask thất bại: ' + maskPath2.substring(6)));
                  return;
                }
                resolve({ imagePath, maskPath: maskPath2, cropX, cropY, cropW, cropH });
              });
              return;
            }
            resolve({ imagePath, maskPath, cropX, cropY, cropW, cropH });
          });
        } else {
          // No selection → create full white mask at normalized dimensions
          createFullWhiteMaskAtSize(1376, 768).then(maskPath => {
            resolve({ imagePath, maskPath, cropX, cropY, cropW, cropH });
          }).catch(reject);
        }
      });
    });
  });
}

/**
 * Create a full-white mask PNG (same size as source image).
 * Used when there's no selection in PS (fill entire image).
 */
function createFullWhiteMask(imagePath) {
  return new Promise((resolve, reject) => {
    if (!fs) {
      reject(new Error('No fs module'));
      return;
    }
    try {
      // Read source image dimensions using a simple PNG header parse
      const buf = fs.readFileSync(imagePath);
      let w = 1024, h = 1024;
      // PNG: width at offset 16 (4 bytes BE), height at offset 20
      if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
        w = buf.readUInt32BE(16);
        h = buf.readUInt32BE(20);
      }

      // Create minimal white PNG using canvas (CEP has canvas)
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);

      // Export to data URL, decode, save
      const dataUrl = canvas.toDataURL('image/png');
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const maskBuf = Buffer.from(b64, 'base64');

      const os = require('os');
      const path = require('path');
      const maskPath = path.join(os.tmpdir(), 'redone_genfill_mask_auto.png');
      fs.writeFileSync(maskPath, maskBuf);
      resolve(maskPath);
    } catch (e) {
      reject(new Error('Tạo mask tự động thất bại: ' + e.message));
    }
  });
}

/**
 * Create a full-white mask PNG at a specific size.
 * Used when there's no selection and image was normalized.
 */
function createFullWhiteMaskAtSize(w, h) {
  return new Promise((resolve, reject) => {
    if (!fs) {
      reject(new Error('No fs module'));
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);

      const dataUrl = canvas.toDataURL('image/png');
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const maskBuf = Buffer.from(b64, 'base64');

      const os = require('os');
      const nodePath = require('path');
      const maskPath = nodePath.join(os.tmpdir(), 'redone_genfill_mask_auto.png');
      fs.writeFileSync(maskPath, maskBuf);
      resolve(maskPath);
    } catch (e) {
      reject(new Error('Tạo mask tự động thất bại: ' + e.message));
    }
  });
}

/**
 * Fallback: send to external RedOne backend via HTTP multipart.
 */
async function sendToExternalBackend(imagePath, maskPath, prompt) {
  const model = $modelSelect.value;
  const formData = new FormData();

  if (imagePath === 'debug') {
    // Debug mock
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#666'; ctx.fillRect(0, 0, 256, 256);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    formData.append('image', blob, 'test.png');
    const mc = document.createElement('canvas');
    mc.width = 256; mc.height = 256;
    const mctx = mc.getContext('2d');
    mctx.fillStyle = '#000'; mctx.fillRect(0, 0, 256, 256);
    mctx.fillStyle = '#fff'; mctx.fillRect(64, 64, 128, 128);
    const mblob = await new Promise(r => mc.toBlob(r, 'image/png'));
    formData.append('mask', mblob, 'mask.png');
  } else {
    formData.append('image', await readFileAsBlob(imagePath), 'source.png');
    formData.append('mask', await readFileAsBlob(maskPath), 'mask.png');
  }

  formData.append('prompt', prompt);
  formData.append('isUpscale', isUpscale);
  formData.append('model', model);

  const ac2 = new AbortController(); setTimeout(() => ac2.abort(), 180000);
  const resp = await fetch('http://127.0.0.1:8001/api/ps-genfill/generate', {
    method: 'POST', body: formData,
    signal: ac2.signal,
  });
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData.detail || `HTTP ${resp.status}`);
  }
  return await resp.json();
}

function readFileAsBlob(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const buf = fs.readFileSync(filePath);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      resolve(new Blob([ab], { type: 'image/png' }));
    } catch (e) {
      reject(new Error('Không đọc được file: ' + e.message));
    }
  });
}

let lastCropX = 0;
let lastCropY = 0;
let lastCropW = 0;
let lastCropH = 0;
let lastPromptText = "";

// ── Apply Result ────────────────────────────────────────────
function handleApply() {
  if (!lastResultPath || !csInterface) return;

  const safePrompt = lastPromptText.replace(/"/g, '\\"').replace(/\n/g, ' ');
  const script = `applyResultAsLayer("${lastResultPath.replace(/\\/g, '\\\\')}", ${lastCropX}, ${lastCropY}, ${lastCropW}, ${lastCropH}, "${safePrompt}")`;
  csInterface.evalScript(
    script,
    (result) => {
      if (result === 'OK') {
        showProgress('✓ Đã apply vào Photoshop!');
        setTimeout(hideProgress, 2000);
      } else {
        showError('Apply thất bại: ' + (result || 'unknown'));
      }
    }
  );
}

// ── Regenerate ──────────────────────────────────────────────
function handleRegenerate() {
  hideResult();
  handleGenerate();
}

// ── UI Helpers ──────────────────────────────────────────────
function showProgress(text) {
  $progressSection.style.display = 'block';
  $progressText.textContent = text;
}

function hideProgress() {
  $progressSection.style.display = 'none';
}

function showResult(data) {
  $resultSection.style.display = 'block';
  $resultImage.src = 'data:image/png;base64,' + data.image_base64;
  $resultMeta.textContent = `${data.width}×${data.height} • seed ${data.seed}`;
  lastResultPath = data.output_path || null;

  // If no output_path from embedded mode, save via Node.js
  if (!lastResultPath && fs && data.image_base64) {
    try {
      const os = require('os');
      const path = require('path');
      const resultPath = path.join(os.tmpdir(), `redone_genfill_result_${Date.now()}.png`);
      fs.writeFileSync(resultPath, Buffer.from(data.image_base64, 'base64'));
      lastResultPath = resultPath;
    } catch (e) {
      console.warn('[main] Save result to temp failed:', e.message);
    }
  }
}

function hideResult() {
  $resultSection.style.display = 'none';
  $resultImage.src = '';
  lastResultPath = null;
}

function showError(message) {
  $errorSection.style.display = 'block';
  $errorText.textContent = message;
}

function hideError() {
  $errorSection.style.display = 'none';
}
