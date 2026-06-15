// WebSocket connection with reconnect + event bus
const listeners = new Map();
let socket = null;
let reconnectTimer = null;
let alive = false;

function notify(event, data) {
  const subs = listeners.get(event) || [];
  for (const fn of subs) {
    try { fn(data); } catch (e) { console.error(`WS handler error for ${event}`, e); }
  }
  const wildcard = listeners.get('*') || [];
  for (const fn of wildcard) {
    try { fn({ event, data }); } catch (e) { console.error(e); }
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/ws`);

  socket.addEventListener('open', () => {
    alive = true;
    notify('_connected');
    console.log('[ws] connected');
  });
  socket.addEventListener('close', () => {
    alive = false;
    notify('_disconnected');
    console.log('[ws] disconnected, retrying...');
    reconnectTimer = setTimeout(connect, 2000);
  });
  socket.addEventListener('error', (e) => {
    console.warn('[ws] error', e);
  });
  socket.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      notify(msg.event, msg.data);
    } catch (err) {
      console.warn('[ws] bad msg', err);
    }
  });
}

export const ws = {
  start: () => { if (!socket) connect(); },
  on: (event, fn) => {
    const subs = listeners.get(event) || [];
    subs.push(fn);
    listeners.set(event, subs);
    return () => {
      const arr = listeners.get(event) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  },
  off: (event, fn) => {
    const arr = listeners.get(event) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
  isAlive: () => alive,
};
