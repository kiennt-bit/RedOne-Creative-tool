/**
 * Embedded Bridge Server — Runs inside the CEP panel via Node.js.
 *
 * Implements the same /sync/* protocol that the Chrome extension
 * ("RedOne Auth Helper") expects, so the extension can connect
 * directly to Photoshop — no external server needed.
 *
 * Architecture:
 *   PS CEP Panel (this code)
 *     └─ Node.js HTTP server (port 8000)
 *         ├─ /sync/status          ← extension heartbeat
 *         ├─ /sync/next-task       ← extension polls for work
 *         ├─ /sync/task-result     ← extension delivers results
 *         └─ /api/health           ← generic health check
 *     └─ Bridge task queue (in-memory)
 *         └─ proxy_fetch / recaptcha tasks
 */

/* global require */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ── Configuration ───────────────────────────────────────────────
const XOR_KEY = 0x5A;
const TASK_TTL_MS = 120000;
const EXT_LIVE_THRESHOLD_MS = 60000;
const DEFAULT_PORT = 8099;

// ── XOR Codec (matches extension/background.js) ────────────────

function xorEncode(plaintext) {
  let ascii = '';
  for (let i = 0; i < plaintext.length; i++) {
    const code = plaintext.charCodeAt(i);
    if (code < 0x20 || code > 0x7E) {
      ascii += '\\u' + ('0000' + code.toString(16)).slice(-4);
    } else {
      ascii += plaintext[i];
    }
  }
  let hex = '';
  for (let i = 0; i < ascii.length; i++) {
    hex += ('00' + (ascii.charCodeAt(i) ^ XOR_KEY).toString(16)).slice(-2);
  }
  return hex;
}

function xorDecode(hexString) {
  let result = '';
  for (let i = 0; i < hexString.length; i += 2) {
    const byte = parseInt(hexString.substr(i, 2), 16) ^ XOR_KEY;
    result += String.fromCharCode(byte);
  }
  return result;
}

function wrapEnvelope(payload) {
  return { d: xorEncode(JSON.stringify(payload)) };
}

function unwrapEnvelope(raw) {
  if (raw && typeof raw.d === 'string') {
    return JSON.parse(xorDecode(raw.d));
  }
  return raw || {};
}

// ── Bridge Task Queue ──────────────────────────────────────────

class BridgeTaskQueue {
  constructor() {
    this._pending = [];        // tasks waiting for extension
    this._inFlight = {};       // tasks claimed by extension, awaiting result
    this._extLastPoll = 0;
    this._extLastReadyPoll = 0;
    this._extLastStatus = 'unknown';
    this._extLastUrl = '';
  }

  updateTabState(status, url) {
    this._extLastPoll = Date.now();
    this._extLastStatus = status || 'unknown';
    this._extLastUrl = url || '';
    if (status === 'ready') {
      this._extLastReadyPoll = Date.now();
    }
  }

  bumpLiveness() {
    this._extLastPoll = Date.now();
  }

  isExtensionLive() {
    return (Date.now() - this._extLastPoll) < EXT_LIVE_THRESHOLD_MS;
  }

  isReadyExtensionLive() {
    return (Date.now() - this._extLastReadyPoll) < EXT_LIVE_THRESHOLD_MS;
  }

  snapshotState() {
    return {
      extension_live: this.isExtensionLive(),
      last_poll_age_s: this._extLastPoll
        ? Math.round((Date.now() - this._extLastPoll) / 1000 * 10) / 10
        : null,
      last_tab_status: this._extLastStatus,
      pending_tasks: this._pending.length,
      in_flight_tasks: Object.keys(this._inFlight).length,
    };
  }

  /**
   * Pop next task for the extension. Returns null if queue is empty
   * or extension doesn't have the right tab status.
   */
  popTaskForExtension(tabStatus) {
    if (tabStatus && tabStatus !== 'ready') return null;
    // Remove expired tasks
    const now = Date.now();
    this._pending = this._pending.filter(t => (now - t.createdAt) < TASK_TTL_MS);

    if (this._pending.length === 0) return null;

    const task = this._pending.shift();
    this._inFlight[task.id] = task;
    return { id: task.id, kind: task.kind, payload: task.payload };
  }

  /**
   * Extension delivers a result for a task it previously claimed.
   */
  deliverResult(taskId, result) {
    const task = this._inFlight[taskId];
    if (!task) return false;
    delete this._inFlight[taskId];
    if (task.resolve) task.resolve(result);
    return true;
  }

  /**
   * Enqueue a task and wait for the extension to process it.
   * Returns a Promise that resolves with the result.
   */
  enqueueAndWait(kind, payload) {
    return new Promise((resolve, reject) => {
      if (!this.isExtensionLive()) {
        reject(new Error(
          'Extension chưa kết nối. Mở Chrome có cài "RedOne Auth Helper" ' +
          '+ tab labs.google đã đăng nhập.'
        ));
        return;
      }
      if (!this.isReadyExtensionLive() && Object.keys(this._inFlight).length === 0) {
        reject(new Error(
          'Extension thấy nhưng CHƯA có tab labs.google đã đăng nhập. ' +
          'Mở tab https://labs.google/fx/tools/flow, đăng nhập, rồi thử lại.'
        ));
        return;
      }

      const taskId = crypto.randomBytes(16).toString('hex');
      const task = {
        id: taskId,
        kind,
        payload,
        createdAt: Date.now(),
        resolve,
        reject,
      };
      this._pending.push(task);

      // Timeout
      setTimeout(() => {
        if (this._inFlight[taskId]) {
          delete this._inFlight[taskId];
          reject(new Error(`Extension không phản hồi sau ${TASK_TTL_MS / 1000}s`));
        }
        // Also remove from pending if still there
        const idx = this._pending.indexOf(task);
        if (idx !== -1) {
          this._pending.splice(idx, 1);
          reject(new Error(`Extension không nhận task sau ${TASK_TTL_MS / 1000}s`));
        }
      }, TASK_TTL_MS);
    });
  }

  // ── High-level bridge methods ──

  async harvestRecaptcha(action) {
    const result = await this.enqueueAndWait('recaptcha', {
      site_key: '',
      action: action || 'IMAGE_GENERATION',
    });
    const token = result.token;
    if (!token) throw new Error('reCAPTCHA harvest failed: ' + (result.error || 'no token'));
    return token;
  }

  async proxyFetch(url, method, headers, body, responseMode, timeoutMs) {
    return await this.enqueueAndWait('proxy_fetch', {
      url,
      method: method || 'GET',
      headers: headers || {},
      body: body || null,
      response_mode: responseMode || 'json',
      timeout_ms: timeoutMs || 60000,
    });
  }
}

// ── Module-level singleton ──
const bridge = new BridgeTaskQueue();

// ── HTTP Server ────────────────────────────────────────────────

let _server = null;
let _serverPort = 0;

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function sendJson(res, data, statusCode) {
  res.writeHead(statusCode || 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify(data));
}

async function handleRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${_serverPort}`);
  const path = url.pathname;

  try {
    // ── /sync/status — extension heartbeat
    if (path === '/sync/status') {
      bridge.bumpLiveness();
      sendJson(res, { ok: true, ts: Date.now() / 1000, service: 'redone-bridge' });
      return;
    }

    // ── /sync/next-task — extension polls for work
    if (path === '/sync/next-task') {
      const tabStatus = url.searchParams.get('tab_status') || 'ready';
      const tabUrl = url.searchParams.get('tab_url') || '';
      const capacity = parseInt(url.searchParams.get('capacity') || '1', 10);

      bridge.updateTabState(tabStatus, tabUrl);

      if (capacity <= 0) {
        sendJson(res, { task: null });
        return;
      }

      const task = bridge.popTaskForExtension(tabStatus);
      if (!task) {
        sendJson(res, { task: null });
        return;
      }
      sendJson(res, wrapEnvelope({ task }));
      return;
    }

    // ── /sync/task-result — extension delivers result
    if (path === '/sync/task-result' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload;
      try { payload = unwrapEnvelope(raw); }
      catch (e) { sendJson(res, { ok: false, error: 'bad envelope' }, 400); return; }

      const taskId = payload.task_id;
      const result = payload.result || {};
      if (!taskId) { sendJson(res, { ok: false, error: 'missing task_id' }, 400); return; }

      const delivered = bridge.deliverResult(taskId, result);
      sendJson(res, { ok: delivered });
      return;
    }

    // ── /sync/state — diagnostics
    if (path === '/sync/state') {
      sendJson(res, bridge.snapshotState());
      return;
    }

    // ── /sync/shared-google — stub (standalone mode)
    if (path === '/sync/shared-google') {
      sendJson(res, wrapEnvelope({ ok: false, reason: 'Standalone GenFill mode' }));
      return;
    }

    // ── /api/health — generic health
    if (path === '/api/health') {
      sendJson(res, { ok: true, service: 'redone-genfill-embedded' });
      return;
    }

    // ── /api/ps-genfill/health — plugin health
    if (path === '/api/ps-genfill/health') {
      sendJson(res, {
        ok: true,
        mode: 'embedded',
        has_extension: bridge.isExtensionLive(),
        extension_status: bridge._extLastStatus,
      });
      return;
    }

    // ── 404
    sendJson(res, { error: 'not found' }, 404);

  } catch (err) {
    console.error('[bridge-server] Error:', err);
    sendJson(res, { error: err.message }, 500);
  }
}

/**
 * Start the embedded HTTP server on the given port.
 * Returns a Promise that resolves with the actual port used.
 */
function startServer(port) {
  const FALLBACK_PORTS = [port, port - 1, port - 2, port + 1, port + 2];

  function tryPort(p) {
    return new Promise((resolve) => {
      if (_server) { resolve(_serverPort); return; }

      const srv = http.createServer(handleRequest);
      srv.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[bridge-server] Port ${p} in use, trying next...`);
          resolve(0);
        } else {
          console.error(`[bridge-server] Port ${p} error:`, err.message);
          resolve(0);
        }
      });
      srv.listen(p, '127.0.0.1', () => {
        _server = srv;
        _serverPort = p;
        console.log(`[bridge-server] Listening on http://127.0.0.1:${p}`);
        resolve(p);
      });
    });
  }

  return (async () => {
    for (const p of FALLBACK_PORTS) {
      const result = await tryPort(p);
      if (result > 0) return result;
    }
    console.warn('[bridge-server] All ports in use!');
    return 0;
  })();
}

/**
 * Stop the embedded server.
 */
function stopServer() {
  if (_server) {
    _server.close();
    _server = null;
    _serverPort = 0;
  }
}

// ── Exports ──
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    bridge,
    startServer,
    stopServer,
    DEFAULT_PORT,
    xorEncode,
    xorDecode,
    wrapEnvelope,
    unwrapEnvelope,
  };
}
