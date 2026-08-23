import type { ClientMessage, ServerMessage } from '@shared/protocol';

type Status = 'connecting' | 'open' | 'closed';

let sock: WebSocket | null = null;
let status: Status = 'closed';
let attempt = 0;
let retry: number | undefined;
let ping: number | undefined;
/** set only by close code 4401: stay down until the app calls connectWs() again after a login */
let unauthenticated = false;

const messageCbs = new Set<(m: ServerMessage) => void>();
const statusCbs = new Set<(s: Status) => void>();

function setStatus(s: Status): void {
  if (s === status) return;
  status = s;
  for (const cb of statusCbs) cb(s);
}

function open(): void {
  setStatus('connecting');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  sock = ws;

  ws.onopen = () => {
    attempt = 0;
    setStatus('open');
    ping = window.setInterval(() => sendWs({ type: 'ping' }), 25_000);
  };

  ws.onmessage = (e) => {
    let m: ServerMessage;
    try {
      m = JSON.parse(String(e.data)) as ServerMessage;
    } catch {
      return;
    }
    for (const cb of messageCbs) cb(m);
  };

  ws.onerror = () => ws.close(); // onclose owns the retry

  ws.onclose = (e) => {
    clearInterval(ping);
    ping = undefined;
    sock = null;
    if (e.code === 4401) unauthenticated = true;
    setStatus('closed');
    if (unauthenticated) return;
    retry = window.setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++));
  };
}

/** idempotent: safe to call on every render/login */
export function connectWs(): void {
  unauthenticated = false;
  if (sock) return;
  clearTimeout(retry);
  retry = undefined;
  open();
}

export function sendWs(m: ClientMessage): void {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m));
}

export function onServerMessage(cb: (m: ServerMessage) => void): () => void {
  messageCbs.add(cb);
  return () => {
    messageCbs.delete(cb);
  };
}

export function wsStatus(): Status {
  return status;
}

export function onWsStatus(cb: (s: Status) => void): () => void {
  statusCbs.add(cb);
  return () => {
    statusCbs.delete(cb);
  };
}
