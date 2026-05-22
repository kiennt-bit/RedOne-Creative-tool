// Lightweight fetch wrapper for the FastAPI backend
const BASE = '';

async function request(method, path, { body, form, params } = {}) {
  const url = new URL(BASE + path, location.origin);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const opts = { method, headers: {} };
  if (form instanceof FormData) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const detail = (data && data.detail) || data || `HTTP ${res.status}`;
    const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (p, params) => request('GET', p, { params }),
  post: (p, body) => request('POST', p, { body }),
  postForm: (p, form) => request('POST', p, { form }),
  del: (p) => request('DELETE', p),

  // Domain-specific
  health: () => request('GET', '/api/health'),

  accounts: {
    list: () => request('GET', '/api/accounts'),
    add: (email) => request('POST', '/api/accounts', { body: { email } }),
    del: (id) => request('DELETE', `/api/accounts/${id}`),
    toggle: (id) => request('POST', `/api/accounts/${id}/toggle`),
    check: (id) => request('POST', `/api/accounts/${id}/check`),
    checkAll: () => request('POST', '/api/accounts/check-all'),
    login: (id) => request('POST', `/api/accounts/${id}/login`),
    uploadCookie: (id, file) => {
      const fd = new FormData();
      fd.append('file', file);
      return request('POST', `/api/accounts/${id}/cookie`, { form: fd });
    },
  },

  content: {
    start: (payload) => request('POST', '/api/content/start', { body: payload }),
    cancel: (taskId) => request('POST', `/api/content/cancel/${taskId}`),
    tasks: () => request('GET', '/api/content/tasks'),
    task: (id) => request('GET', `/api/content/tasks/${id}`),
    uploadImage: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return request('POST', '/api/content/upload-image', { form: fd });
    },
  },

  longVideo: {
    start: (payload) => request('POST', '/api/long-video/start', { body: payload }),
    cancel: (taskId) => request('POST', `/api/long-video/cancel/${taskId}`),
  },

  image: {
    start: (payload) => request('POST', '/api/image/start', { body: payload }),
    cancel: (taskId) => request('POST', `/api/image/cancel/${taskId}`),
    upscale: (itemId, resolution) => request('POST', `/api/image/upscale/${itemId}`, { params: { resolution } }),
    upscaleBatch: (itemIds, resolution) => request('POST', '/api/image/upscale-batch',
      { body: { item_ids: itemIds, resolution } }),
  },

  analyzer: {
    script: (payload) => request('POST', '/api/analyzer/script', { body: payload }),
    regenScene: (payload) => request('POST', '/api/analyzer/regenerate-scene', { body: payload }),
    youtube: (payload) => request('POST', '/api/analyzer/youtube', { body: payload }),
    youtubeUpload: (form) => request('POST', '/api/analyzer/youtube-upload', { form }),
    imageToPrompt: (form) => request('POST', '/api/analyzer/image-to-prompt', { form }),
  },

  media: {
    bgRemove: (form) => request('POST', '/api/media/bg-remove', { form }),
    watermark: (form) => request('POST', '/api/media/watermark-remove', { form }),
    videoWatermark: (form) => request('POST', '/api/media/video-watermark-remove', { form }),
    videoWatermarkBatch: (paths, opts = {}) => request('POST', '/api/media/video-watermark-remove-batch',
      { body: { paths, method: opts.method || 'auto', device: opts.device || 'auto',
                gpu_ratio: opts.gpuRatio || 70 } }),
    lamaStatus: (force = false) => request('GET', '/api/media/lama-status', { params: { force } }),
    upscale: (form) => request('POST', '/api/media/upscale', { form }),
    audioMerge: (form) => request('POST', '/api/media/audio-merge', { form }),
    subtitle: (form) => request('POST', '/api/media/subtitle', { form }),
    resizePresets: () => request('GET', '/api/media/resize-presets'),
    batchResize: (form) => request('POST', '/api/media/batch-resize', { form }),
  },

  settings: {
    get: () => request('GET', '/api/settings'),
    update: (payload) => request('POST', '/api/settings', { body: payload }),
    testGemini: () => request('POST', '/api/settings/test-gemini'),
    logs: (limit = 200) => request('GET', '/api/settings/logs', { params: { limit } }),
    cloakStatus: () => request('GET', '/api/settings/cloak-status'),
  },

  system: {
    info: () => request('GET', '/api/system/info'),
    checkUpdate: (force = false) => request('GET', '/api/system/check-update', { params: { force } }),
    updateState: () => request('GET', '/api/system/update-state'),
    startUpdate: () => request('POST', '/api/system/start-update'),
    applyUpdate: () => request('POST', '/api/system/apply-update'),
    shutdown: () => request('POST', '/api/system/shutdown'),
    lamaInstall: () => request('POST', '/api/system/lama-install'),
    lamaInstallState: () => request('GET', '/api/system/lama-install-state'),
  },

  tasks: {
    list: (limit = 200) => request('GET', '/api/tasks', { params: { limit } }),
    get: (id) => request('GET', `/api/tasks/${id}`),
    cancel: (id) => request('POST', `/api/tasks/${id}/cancel`),
    retry: (id) => request('POST', `/api/tasks/${id}/retry`),
    queue: () => request('GET', '/api/tasks/_/queue'),
    openFolder: (id) => request('POST', `/api/tasks/${id}/open-folder`),
  },

  files: {
    delete: (paths) => request('POST', '/api/files/delete', { body: { paths } }),
    moveToOutputs: (paths) => request('POST', '/api/files/move-to-outputs', { body: { paths } }),
    openFolder: (path) => request('POST', '/api/files/open-folder', { body: { path } }),
    // download-zip returns a binary stream; handle via fetch directly
    downloadZip: async (paths) => {
      const res = await fetch('/api/files/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `redone_${paths.length}_files.zip`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    },
  },
};
