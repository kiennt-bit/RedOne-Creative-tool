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
  put: (p, body) => request('PUT', p, { body }),
  postForm: (p, form) => request('POST', p, { form }),
  del: (p) => request('DELETE', p),

  // Domain-specific
  health: () => request('GET', '/api/health'),

  // Kho tính năng (feature store)
  features: {
    catalog: () => request('GET', '/api/features/catalog'),
    installed: () => request('GET', '/api/features/installed'),
    install: (id) => request('POST', '/api/features/install', { body: { id } }),
    uninstall: (id) => request('POST', '/api/features/uninstall', { body: { id } }),
  },

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

  shakker: {
    account: () => request('GET', '/api/shakker/account'),
    models: (params) => request('GET', '/api/shakker/models', { params }),
    loras: (params) => request('GET', '/api/shakker/loras', { params }),
    generate: (payload) => request('POST', '/api/shakker/generate', { body: payload }),
    upscale: (payload) => request('POST', '/api/shakker/upscale', { body: payload }),
    upscaleEstimate: (payload) => request('POST', '/api/shakker/upscale/estimate', { body: payload }),
    cancel: (taskId) => request('POST', `/api/shakker/cancel/${taskId}`),
    retryItem: (itemId) => request('POST', `/api/shakker/item/${itemId}/retry`),
    retryFailed: (taskId) => request('POST', `/api/shakker/${taskId}/retry-failed`),
    retryItems: (taskId, itemIds) => request('POST', `/api/shakker/${taskId}/retry-items`, { body: { item_ids: itemIds } }),
    uploadRef: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return request('POST', '/api/shakker/upload-ref', { form: fd });
    },
  },

  shakkerAccounts: {
    list: () => request('GET', '/api/shakker-accounts'),
    del: (id) => request('DELETE', `/api/shakker-accounts/${id}`),
    toggle: (id) => request('POST', `/api/shakker-accounts/${id}/toggle`),
    check: (id) => request('POST', `/api/shakker-accounts/${id}/check`),
    checkAll: () => request('POST', '/api/shakker-accounts/check-all'),
  },

  analyzer: {
    script: (payload) => request('POST', '/api/analyzer/script', { body: payload }),
    regenScene: (payload) => request('POST', '/api/analyzer/regenerate-scene', { body: payload }),
    youtube: (payload) => request('POST', '/api/analyzer/youtube', { body: payload }),
    youtubeUpload: (form) => request('POST', '/api/analyzer/youtube-upload', { form }),
    imageToPrompt: (form) => request('POST', '/api/analyzer/image-to-prompt', { form }),
    ideaImagePrompts: (form) => request('POST', '/api/analyzer/idea-image-prompts', { form }),
  },

  storyboard: {
    start: (form) => request('POST', '/api/storyboard/start', { form }),
  },

  media: {
    bgRemove: (form) => request('POST', '/api/media/bg-remove', { form }),
    watermark: (form) => request('POST', '/api/media/watermark-remove', { form }),
    videoWatermark: (form) => request('POST', '/api/media/video-watermark-remove', { form }),
    videoWatermarkBatch: (paths, opts = {}) => request('POST', '/api/media/video-watermark-remove-batch',
      { body: { paths, method: opts.method || 'auto', device: opts.device || 'auto',
                gpu_ratio: opts.gpuRatio || 70 } }),
    lamaStatus: (force = false) => request('GET', '/api/media/lama-status', { params: { force } }),
    audioMerge: (form) => request('POST', '/api/media/audio-merge', { form }),
    subtitle: (form) => request('POST', '/api/media/subtitle', { form }),
    resizePresets: () => request('GET', '/api/media/resize-presets'),
    batchResize: (form) => request('POST', '/api/media/batch-resize', { form }),
  },

  // Trình dựng video (Part B)
  videoEditor: {
    projects: () => request('GET', '/api/video-editor/projects'),
    project: (id) => request('GET', `/api/video-editor/projects/${id}`),
    createProject: (name) => request('POST', '/api/video-editor/projects', { body: { name } }),
    saveProject: (id, name, data) => request('PUT', `/api/video-editor/projects/${id}`, { body: { name, data } }),
    deleteProject: (id) => request('DELETE', `/api/video-editor/projects/${id}`),
    myMedia: (type = 'all') => request('GET', '/api/video-editor/my-media', { params: { type } }),
    upload: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return request('POST', '/api/video-editor/upload', { form: fd });
    },
    render: (payload) => request('POST', '/api/video-editor/render', { body: payload }),
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
    setupStatus: () => request('GET', '/api/system/setup-status'),
    setupState: () => request('GET', '/api/system/setup-state'),
    setupRun: () => request('POST', '/api/system/setup-run'),
  },

  // RedOne Hub (multi-user) — proxied through the local backend.
  hub: {
    status: () => request('GET', '/api/hub/status'),
    teamTasks: (params) => request('GET', '/api/hub/team/tasks', { params }),
    teamUsage: (days = 30) => request('GET', '/api/hub/team/usage', { params: { days } }),
    users: () => request('GET', '/api/hub/admin/users'),
    upsertUser: (payload) => request('POST', '/api/hub/admin/users', { body: payload }),
    delUser: (email) => request('DELETE', `/api/hub/admin/users/${encodeURIComponent(email)}`),
    teams: () => request('GET', '/api/hub/admin/teams'),
    upsertTeam: (payload) => request('POST', '/api/hub/admin/teams', { body: payload }),
    delTeam: (id) => request('DELETE', `/api/hub/admin/teams/${id}`),
    setQuota: (payload) => request('POST', '/api/hub/admin/quota', { body: payload }),
    grant: (payload) => request('POST', '/api/hub/admin/grant', { body: payload }),
    audit: (limit = 100) => request('GET', '/api/hub/admin/audit', { params: { limit } }),
    // Shared-account credentials (lead of team or admin). Returns MASKED info
    // (email + *_set flags), never the actual secrets.
    getTeamCredentials: (teamId) => request('GET', '/api/hub/team-credentials', { params: teamId ? { team_id: teamId } : {} }),
    setTeamCredentials: (payload) => request('POST', '/api/hub/team-credentials', { body: payload }),
    delTeamCredentials: (teamId) => request('DELETE', '/api/hub/team-credentials', { params: { team_id: teamId } }),
    // Shared-account real balance (Flow credit + Shakker usable power).
    sharedBalance: () => request('GET', '/api/hub/shared-balance'),
    // Shared-account status for the Accounts tab (any role) — email + flags +
    // live connection on this machine. NEVER returns the password.
    sharedAccountStatus: () => request('GET', '/api/hub/shared-account-status'),
  },

  tasks: {
    list: (limit = 200) => request('GET', '/api/tasks', { params: { limit } }),
    get: (id) => request('GET', `/api/tasks/${id}`),
    cancel: (id) => request('POST', `/api/tasks/${id}/cancel`),
    pause: (id) => request('POST', `/api/tasks/${id}/pause`),
    resume: (id) => request('POST', `/api/tasks/${id}/resume`),
    retry: (id) => request('POST', `/api/tasks/${id}/retry`),
    // Regenerate ALL failed items — works even while the task is still running.
    retryFailed: (id) => request('POST', `/api/tasks/${id}/retry-failed`),
    // Regenerate a SINGLE item by its id — works mid-task too.
    retryItem: (itemId) => request('POST', `/api/tasks/item/${itemId}/retry`),
    // Regenerate a SPECIFIC LIST of items (gallery "Gen lại" over ticked cards).
    retryItems: (taskId, itemIds) => request('POST', `/api/tasks/${taskId}/retry-items`, { body: { item_ids: itemIds } }),
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
