import { create } from 'zustand';
import { EmulatedFc, MspClient, WebSerialTransport, defaultEmulatedFc, type EmulatorPreset, type MspLogEntry, type Transport } from '@vtx/msp';

export interface FcInfo { variant: string; version: string; target: string; boardId: string; uid: string }

interface FcState {
  client: MspClient | null;
  info: FcInfo | null;
  connecting: boolean;
  error: string | null;
  log: MspLogEntry[];
  emulated: boolean;
  preset: EmulatorPreset | null;
  connect(opts?: { emulate?: boolean; preset?: EmulatorPreset }): Promise<void>;
  /** INAV reboots on CLI `exit`/`save`: USB VCP drops and the port must be reopened. */
  reconnectAfterReboot(): Promise<void>;
  /** Run CLI lines in ONE session and leave with `save` (or `exit`), then reconnect. */
  runCliScript(lines: string[], end: 'save' | 'exit', onLine?: (line: string, out: string) => void): Promise<void>;
  disconnect(): Promise<void>;
}

export const webSerialSupported = typeof navigator !== 'undefined' && 'serial' in navigator;

async function identify(client: MspClient): Promise<FcInfo> {
  const variant = await client.fcVariant();
  const version = await client.fcVersion();
  const board = await client.boardInfo();
  let uid = '';
  try {
    uid = await client.getUid();
  } catch {
    uid = await client.uid();
  }
  return { variant, version, target: board.targetName, boardId: board.identifier, uid };
}

export const useFc = create<FcState>((set, get) => ({
  client: null,
  info: null,
  connecting: false,
  error: null,
  log: [],
  emulated: false,
  preset: null,
  async connect(opts) {
    set({ connecting: true, error: null });
    try {
      let transport: Transport;
      if (opts?.emulate) transport = new EmulatedFc(defaultEmulatedFc(opts.preset ?? 'molniya')).transport;
      else {
        if (!webSerialSupported) throw new Error('Web Serial не поддерживается. Нужен Chrome/Edge 89+ (Android: Chrome 148+ и OTG).');
        const t = new WebSerialTransport();
        await t.requestPort();
        transport = t;
      }
      const client = new MspClient(transport, { log: (e) => set((s) => ({ log: [...s.log.slice(-499), e] })) });
      await client.open();
      const info = await identify(client);
      set({ client, info, connecting: false, emulated: Boolean(opts?.emulate), preset: opts?.emulate ? opts.preset ?? 'molniya' : null });
    } catch (e) {
      set({ connecting: false, error: (e as Error).message });
      throw e;
    }
  },
  async reconnectAfterReboot() {
    const { client, emulated, info } = get();
    if (!client || emulated) return;
    await client.close().catch(() => undefined);
    let lastErr = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2500 : 1000));
      try {
        await client.open();
        const fresh = await identify(client);
        if (info && fresh.uid !== info.uid) throw new Error(`после перезагрузки подключён другой борт (UID ${fresh.uid})`);
        set({ info: fresh, error: null });
        return;
      } catch (e) {
        lastErr = (e as Error).message;
        await client.close().catch(() => undefined);
      }
    }
    set({ error: `Борт перезагрузился, но не вернулся на связь: ${lastErr}. Переподключите USB.` });
    throw new Error(lastErr);
  },
  async runCliScript(lines, end, onLine) {
    const { client } = get();
    if (!client) throw new Error('Борт не подключён');
    const s = await client.cliSession();
    try {
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const head = line.split(/\s+/)[0]!.toLowerCase();
        if (head === 'save' || head === 'exit' || head === 'defaults' || head === 'dfu' || head === 'reboot') continue;
        const out = await s.run(line, 1500);
        onLine?.(line, out);
      }
    } finally {
      await s.end(end);
    }
    await get().reconnectAfterReboot();
  },
  async disconnect() {
    await get().client?.close();
    set({ client: null, info: null, emulated: false, preset: null });
  }
}));
