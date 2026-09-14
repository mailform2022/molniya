import { create } from 'zustand';
import { api, auth, wsUrl } from './api';

export interface Access {
  type: 'subscription' | 'trial' | 'none';
  plan: string | null;
  expires_at: string | null;
  device_limit: number;
  devices_used: number;
  features: Record<string, boolean | number | string>;
  source: string | null;
}
export interface User { id: string; email: string; role: 'user' | 'admin'; emailVerified: boolean; profile?: Record<string, unknown> }
export interface Presence { sid: string; role: string; device: string | null; lastSeenAt: string }
export interface RealtimeEvent { channel: string; type: string; payload: unknown; self?: boolean }

interface State {
  user: User | null;
  access: Access | null;
  sessionRole: 'operator' | 'technician' | 'viewer';
  presence: Presence[];
  config: { flags: Record<string, unknown>; content: Record<string, unknown>; telegram: string } | null;
  events: RealtimeEvent[];
  toast: string | null;
  loading: boolean;
  init(): Promise<void>;
  setAuth(token: string, data?: { user?: User; access?: Access }): Promise<void>;
  logout(): Promise<void>;
  refreshAccess(): Promise<void>;
  notify(msg: string): void;
}

let socket: WebSocket | null = null;
const listeners = new Set<(e: RealtimeEvent) => void>();
export function onRealtime(cb: (e: RealtimeEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const useStore = create<State>((set, get) => ({
  user: null,
  access: null,
  sessionRole: 'operator',
  presence: [],
  config: null,
  events: [],
  toast: null,
  loading: true,
  notify(msg) {
    set({ toast: msg });
    setTimeout(() => set((s) => (s.toast === msg ? { toast: null } : {})), 4000);
  },
  async init() {
    try {
      const cfg = await api<State['config'] & { success: boolean }>('/config');
      set({ config: cfg });
    } catch {
      /* offline */
    }
    if (auth.token) {
      try {
        const me = await api<{ user: User; sessionRole: State['sessionRole']; access: Access }>('/auth/me');
        set({ user: me.user, access: me.access, sessionRole: me.sessionRole });
        connect(set, get);
      } catch {
        auth.set(null);
      }
    }
    set({ loading: false });
  },
  async setAuth(token, data) {
    auth.set(token);
    if (data?.user) set({ user: data.user, access: data.access ?? null });
    else {
      const me = await api<{ user: User; sessionRole: State['sessionRole']; access: Access }>('/auth/me');
      set({ user: me.user, access: me.access, sessionRole: me.sessionRole });
    }
    connect(set, get);
  },
  async logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    auth.set(null);
    socket?.close();
    socket = null;
    set({ user: null, access: null, presence: [] });
  },
  async refreshAccess() {
    const r = await api<{ access: Access }>('/subscription');
    set({ access: r.access });
  }
}));

function connect(set: (p: Partial<State>) => void, get: () => State) {
  if (socket) socket.close();
  socket = new WebSocket(wsUrl());
  socket.onmessage = (m) => {
    const ev = JSON.parse(m.data as string) as RealtimeEvent;
    if (ev.type === 'presence') set({ presence: ev.payload as Presence[] });
    if (ev.type === 'access.updated') void get().refreshAccess();
    if (ev.type === 'role.changed') {
      const p = ev.payload as { sid: string; role: State['sessionRole'] };
      if (p.sid === sessionStorage.getItem('vtx.sid')) set({ sessionRole: p.role });
    }
    if (ev.type === 'flags.updated' || ev.type === 'cms.updated' || ev.type === 'quick-fix') void api<State['config'] & { success: boolean }>('/config').then((c) => set({ config: c }));
    set({ events: [ev, ...get().events].slice(0, 100) });
    listeners.forEach((l) => l(ev));
  };
  socket.onclose = () => {
    if (auth.token) setTimeout(() => connect(set, get), 3000);
  };
}

export function sendRealtime(type: string, payload: unknown) {
  socket?.send(JSON.stringify({ type, payload }));
}
