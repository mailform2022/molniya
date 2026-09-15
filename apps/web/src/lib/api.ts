export const API_BASE: string = import.meta.env.VITE_API_URL ?? '';

const SID_KEY = 'vtx.sid';
export function sessionId(): string {
  let sid = sessionStorage.getItem(SID_KEY);
  if (!sid) {
    sid = crypto.randomUUID();
    sessionStorage.setItem(SID_KEY, sid);
  }
  return sid;
}

/** Stable-ish device fingerprint: UA + screen + tz + language + canvas hash, sha-256. */
export async function fingerprint(): Promise<string> {
  const cached = localStorage.getItem('vtx.fp');
  if (cached) return cached;
  const parts = [navigator.userAgent, screen.width, screen.height, screen.colorDepth, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language, navigator.hardwareConcurrency];
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('vtx-services', 2, 2);
      parts.push(c.toDataURL());
    }
  } catch {
    /* ignore */
  }
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  const fp = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  localStorage.setItem('vtx.fp', fp);
  return fp;
}

export class ApiError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(body.hint ? `${String(body.error ?? status)}: ${String(body.hint)}` : String(body.error ?? body.message ?? status));
  }
}

let token: string | null = localStorage.getItem('vtx.token');
export const auth = {
  get token() { return token; },
  set(t: string | null) {
    token = t;
    if (t) localStorage.setItem('vtx.token', t);
    else localStorage.removeItem('vtx.token');
  }
};

export async function api<T = Record<string, unknown>>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Session-Id', sessionId());
  headers.set('X-Fingerprint', await fingerprint());
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${API_BASE}/api${path}`, { ...init, headers, body, credentials: 'include' });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** multipart upload (files + fields); the browser sets the boundary itself. */
export async function apiUpload<T = Record<string, unknown>>(path: string, form: FormData): Promise<T> {
  const headers = new Headers();
  headers.set('X-Session-Id', sessionId());
  headers.set('X-Fingerprint', await fingerprint());
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${API_BASE}/api${path}`, { method: 'POST', headers, body: form, credentials: 'include' });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** Authenticated download (Bearer token cannot travel in a plain <a href>); saves the response as a file. */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const headers = new Headers();
  headers.set('X-Session-Id', sessionId());
  headers.set('X-Fingerprint', await fingerprint());
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${API_BASE}/api${path}`, { headers, credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))) as Record<string, unknown>);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Absolute URL for public binary API resources (images) rendered via <img>. */
export function apiUrl(path: string): string {
  return `${API_BASE}/api${path}`;
}

export function wsUrl(): string {
  const base = API_BASE || location.origin;
  return `${base.replace(/^http/, 'ws')}/api/realtime?token=${encodeURIComponent(token ?? '')}`;
}
