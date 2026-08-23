import type { SessionState } from '@shared/protocol';
import { ApiError, createSession, getSessionState } from '@/lib/api';

// sessionStorage, never localStorage: localStorage is shared by every tab of the origin, so two
// tabs would fight over one pinned Postgres backend. One browser tab = one session = one backend.
const key = (connectionId: string) => `sqlmypg.session.${connectionId}`;

export function storedSessionId(connectionId: string): string | null {
  return sessionStorage.getItem(key(connectionId));
}

export function rememberSessionId(connectionId: string, sessionId: string): void {
  sessionStorage.setItem(key(connectionId), sessionId);
}

export function forgetSessionId(connectionId: string): void {
  sessionStorage.removeItem(key(connectionId));
}

// ponytail: "Duplicate tab" copies sessionStorage, so the clone shares the original's session id;
// hand out a per-tab claim token at create time and reject mismatches server-side if that bites.
export async function ensureSession(connectionId: string): Promise<SessionState> {
  const existing = storedSessionId(connectionId);
  if (existing) {
    const alive = await getSessionState(existing).catch((err: unknown) => {
      // reaped for idleness or lost with the server process: not an error, just make a new one
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    });
    if (alive) return alive;
    forgetSessionId(connectionId);
  }
  const created = await createSession({ connectionId });
  rememberSessionId(connectionId, created.id);
  return created;
}
