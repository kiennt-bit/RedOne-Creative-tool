// Global tasks store — survives page navigation AND browser refresh.
// • Tasks are kept in memory (Map) for fast lookup + reactive subscriptions.
// • Same tasks are mirrored to localStorage on every change, so an F5 or full
//   browser restart still restores the gallery. (Backend keeps running the
//   job; we just need to find which task to re-attach to.)
// • Subscribes to WebSocket events ONCE at app boot.

import { ws } from './ws.js';

const STORAGE_KEY = 'redone_tasks_v1';
const MAX_STORED_TASKS = 20;    // prune oldest beyond this
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);   // unique per module load
const LOG_PREFIX = `%c[tasks_store#${INSTANCE_ID}]`;
const LOG_STYLE = 'color:#dc2626;font-weight:600';

function log(...args) {
  console.log(LOG_PREFIX, LOG_STYLE, ...args);
}

// Track all instances on window so we can detect duplicates
if (!window.__tasksStoreInstances) window.__tasksStoreInstances = [];
window.__tasksStoreInstances.push(INSTANCE_ID);
log(`module loaded (instance count: ${window.__tasksStoreInstances.length})`);

const tasks = new Map();
const subscribers = new Map();
const kindSubscribers = new Map();

// ── Persistence ────────────────────────────────────────────
function persist() {
  try {
    // Convert Map → array, drop oldest beyond MAX
    const arr = [...tasks.values()]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, MAX_STORED_TASKS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch (e) {
    console.warn('[tasks_store] persist failed', e);
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    for (const t of arr) {
      if (t && t.id) tasks.set(t.id, t);
    }
    log(`restored ${arr.length} tasks from localStorage`);
  } catch (e) {
    console.warn('[tasks_store] restore failed', e);
  }
}
restore();

function notify(taskId) {
  const t = tasks.get(taskId);
  if (!t) return;
  persist();
  const subs = subscribers.get(taskId);
  if (subs) for (const fn of subs) {
    try { fn(t); } catch (e) { console.error(e); }
  }
  const kindSubs = kindSubscribers.get(t.kind);
  if (kindSubs) for (const fn of kindSubs) {
    try { fn(t); } catch (e) { console.error(e); }
  }
}

export const tasksStore = {
  register(taskId, kind, meta = {}) {
    const t = {
      id: taskId,
      kind,
      status: 'running',
      aspect: meta.aspect || '1:1',
      model: meta.model || '',
      items: (meta.items || []).map(p => ({
        id: null,
        prompt: typeof p === 'string' ? p : (p.prompt || ''),
        status: 'pending',
        output_url: null,
        error: null,
      })),
      done: 0,
      error: 0,
      total: (meta.items || []).length,
      error_message: null,
      created_at: Date.now(),
    };
    tasks.set(taskId, t);
    log(`register task=${taskId} kind=${kind} items=${t.total}`);
    notify(taskId);
    return t;
  },

  get(taskId) { return tasks.get(taskId) || null; },

  latestByKind(kind) {
    let latest = null;
    for (const t of tasks.values()) {
      if (t.kind === kind && (!latest || t.created_at > latest.created_at)) {
        latest = t;
      }
    }
    return latest;
  },

  list() {
    return [...tasks.values()].sort((a, b) => b.created_at - a.created_at);
  },

  on(taskId, fn) {
    if (!subscribers.has(taskId)) subscribers.set(taskId, new Set());
    subscribers.get(taskId).add(fn);
    return () => {
      const s = subscribers.get(taskId);
      if (s) s.delete(fn);
    };
  },

  onKind(kind, fn) {
    if (!kindSubscribers.has(kind)) kindSubscribers.set(kind, new Set());
    kindSubscribers.get(kind).add(fn);
    return () => {
      const s = kindSubscribers.get(kind);
      if (s) s.delete(fn);
    };
  },

  remove(taskId) {
    tasks.delete(taskId);
    subscribers.delete(taskId);
    persist();
  },

  /**
   * Remove items from a task by their server-side output_path. Files on
   * disk are NOT touched — this only clears them from the in-memory + UI
   * state. If a task becomes empty, it's removed entirely.
   */
  removeItemsByPath(taskId, paths) {
    const t = tasks.get(taskId);
    if (!t) return;
    const drop = new Set(paths);
    t.items = t.items.filter(it => !drop.has(it.output_path));
    t.done = t.items.filter(it => it.status === 'done').length;
    t.error = t.items.filter(it => it.status === 'error').length;
    t.total = t.items.length;
    if (t.items.length === 0) {
      tasks.delete(taskId);
      subscribers.delete(taskId);
      persist();
      return;
    }
    notify(taskId);
  },

  clear() {
    tasks.clear();
    subscribers.clear();
    persist();
  },
};

// ── WebSocket → store reducer ──────────────────────────────
//
// Backend events carry `item_id` (the DB primary key). The store's items
// were created by the frontend without ids — so the FIRST event we see for
// a given item_id claims the next empty slot. Subsequent events for the
// same id reuse that slot. This works for any ordering, including parallel
// generation where items finish out of order.

function pathToUrl(p) {
  if (!p) return null;
  const s = String(p).replace(/\\/g, '/');
  const i = s.indexOf('outputs/');
  return i >= 0 ? `/files/${s.slice(i + 'outputs/'.length)}` : `/files/${s.split('/').pop()}`;
}

function findOrClaimSlot(t, itemId) {
  // Already claimed?
  for (const it of t.items) {
    if (it.id === itemId) return it;
  }
  // Claim first slot without an id
  for (const it of t.items) {
    if (it.id == null) {
      it.id = itemId;
      return it;
    }
  }
  return null;
}

ws.on('task_started', (d) => {
  if (!d || !d.task_id) return;
  const t = tasks.get(d.task_id);
  log('task_started', d.task_id, 'in store?', !!t);
  if (t) {
    t.status = 'running';
    notify(d.task_id);
  }
});

ws.on('item_status', (d) => {
  if (!d || !d.task_id || d.item_id == null) return;
  const t = tasks.get(d.task_id);
  if (!t) return;
  const it = findOrClaimSlot(t, d.item_id);
  if (!it) return;
  // Map backend ItemStatus → UI status. Anything that's not done/error is
  // treated as "generating" while the item is moving through stages.
  const s = (d.status || '').toUpperCase();
  if (s === 'COMPLETED') it.status = 'done';
  else if (s === 'ERROR') it.status = 'error';
  else it.status = 'generating';
  notify(d.task_id);
});

ws.on('item_completed', (d) => {
  if (!d || !d.task_id || d.item_id == null) return;
  const t = tasks.get(d.task_id);
  log('item_completed', d.task_id, 'in store?', !!t);
  if (!t) return;
  const it = findOrClaimSlot(t, d.item_id);
  if (!it) return;
  // Only bump counter when transitioning to done
  if (it.status !== 'done') t.done += 1;
  it.status = 'done';
  it.output_url = pathToUrl(d.output_path);
  it.output_path = d.output_path;
  // Carry media_id through so the gallery's upscale button (2K/4K) can
  // pass it to the backend without an extra DB lookup.
  if (d.media_id) it.media_id = d.media_id;
  notify(d.task_id);
});

// ── Upscale (2K / 4K) events ──────────────────────────────
ws.on('upscale_started', (d) => {
  if (!d || d.item_id == null) return;
  // Find the item across all tasks (upscale doesn't carry task_id)
  for (const t of tasks.values()) {
    const it = t.items.find(x => x.id === d.item_id);
    if (it) {
      it.upscale_status = 'running';
      it.upscale_resolution = d.resolution;
      it.upscale_error = null;
      notify(t.id);
      return;
    }
  }
});

ws.on('upscale_completed', (d) => {
  if (!d || d.item_id == null) return;
  for (const t of tasks.values()) {
    const it = t.items.find(x => x.id === d.item_id);
    if (it) {
      it.upscale_status = 'done';
      it.upscale_url = d.url;
      it.upscale_path = d.path;
      notify(t.id);
      return;
    }
  }
});

ws.on('upscale_error', (d) => {
  if (!d || d.item_id == null) return;
  for (const t of tasks.values()) {
    const it = t.items.find(x => x.id === d.item_id);
    if (it) {
      it.upscale_status = 'error';
      it.upscale_error = d.error || 'Lỗi upscale';
      notify(t.id);
      return;
    }
  }
});

ws.on('item_error', (d) => {
  if (!d || !d.task_id || d.item_id == null) return;
  const t = tasks.get(d.task_id);
  if (!t) return;
  const it = findOrClaimSlot(t, d.item_id);
  if (!it) return;
  if (it.status !== 'error') t.error += 1;
  it.status = 'error';
  it.error = d.error || 'Lỗi không xác định';
  notify(d.task_id);
});

ws.on('task_progress', (d) => {
  if (!d || !d.task_id) return;
  const t = tasks.get(d.task_id);
  if (!t) return;
  if (typeof d.done === 'number') t.done = d.done;
  if (typeof d.error === 'number') t.error = d.error;
  if (typeof d.total === 'number') t.total = d.total;
  notify(d.task_id);
});

ws.on('task_completed', (d) => {
  if (!d || !d.task_id) return;
  const t = tasks.get(d.task_id);
  log('task_completed', d.task_id, 'in store?', !!t);
  if (!t) return;
  t.status = 'completed';
  if (typeof d.done === 'number') t.done = d.done;
  if (typeof d.error === 'number') t.error = d.error;
  notify(d.task_id);
});

ws.on('task_error', (d) => {
  if (!d || !d.task_id) return;
  const t = tasks.get(d.task_id);
  if (!t) return;
  t.status = 'error';
  t.error_message = d.error || null;
  notify(d.task_id);
});

ws.on('task_cancelled', (d) => {
  if (!d || !d.task_id) return;
  const t = tasks.get(d.task_id);
  if (!t) return;
  t.status = 'cancelled';
  notify(d.task_id);
});

// Long-video specific
ws.on('scene_started', (d) => {
  if (!d || !d.task_id) return;
  const t = tasks.get(d.task_id);
  if (!t) return;
  const idx = (d.scene || 1) - 1;
  if (t.items[idx]) {
    t.items[idx].status = 'generating';
    notify(d.task_id);
  }
});

ws.on('scene_done', (d) => {
  if (!d || !d.task_id) return;
  const t = tasks.get(d.task_id);
  if (!t) return;
  const idx = (d.scene || 1) - 1;
  if (t.items[idx]) {
    t.items[idx].status = 'done';
    t.items[idx].output_url = pathToUrl(d.output_path);
    t.items[idx].output_path = d.output_path;
    notify(d.task_id);
  }
});

ws.on('scene_failed', (d) => {
  if (!d || !d.task_id) return;
  const t = tasks.get(d.task_id);
  if (!t) return;
  const idx = (d.scene || 1) - 1;
  if (t.items[idx]) {
    t.items[idx].status = 'error';
    t.items[idx].error = d.error || 'Lỗi';
    notify(d.task_id);
  }
});

// Expose for manual debugging from devtools console
window.__tasksStore = tasksStore;
log('initialized — call window.__tasksStore.list() to inspect');
