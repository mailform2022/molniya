import { create } from 'zustand';
import {
  EmulatedFc,
  MspClient,
  WebSerialTransport,
  WebUsbCdcTransport,
  defaultEmulatedFc,
  serialBackend,
  type EmulatorPreset,
  type MspLogEntry,
  type Transport
} from '@vtx/msp';

export interface FcInfo { variant: string; version: string; target: string; boardId: string; uid: string }

/** Where the connection stands; `lost` = client exists but the port closed (FC reboot, USB re-enumeration). */
export type FcLink = 'none' | 'connecting' | 'ready' | 'lost';

interface FcState {
  client: MspClient | null;
  info: FcInfo | null;
  connecting: boolean;
  error: string | null;
  log: MspLogEntry[];
  emulated: boolean;
  preset: EmulatorPreset | null;
  link: FcLink;
  connect(opts?: { emulate?: boolean; preset?: EmulatorPreset }): Promise<void>;
  /** Reopens the port without a picker if it was closed; throws with a Russian hint if the FC is really gone. */
  ensureLink(): Promise<MspClient>;
  /** INAV reboots on CLI `exit`/`save`: USB VCP drops and the port must be reopened. */
  reconnectAfterReboot(): Promise<void>;
  /** Run CLI lines in ONE session and leave with `save` (or `exit`), then reconnect. */
  runCliScript(lines: string[], end: 'save' | 'exit', onLine?: (line: string, out: string) => void): Promise<void>;
  disconnect(): Promise<void>;
}

export const backend = serialBackend();
/** True when a real USB board can be reached from this browser (Web Serial on desktop, WebUSB on Android). */
export const webSerialSupported = backend !== null;

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const isAndroid = /Android/i.test(ua);
export const isIOS = /iPhone|iPad|iPod/i.test(ua);

/** Human explanation for the platform: what is needed to talk to the FC from here. */
export function connectivityHint(): string {
  if (isIOS) return 'iPhone/iPad: Safari и Chrome на iOS не дают доступа к USB. Используйте Android-телефон с OTG или ПК.';
  if (isAndroid) {
    if (backend === 'usb') return 'Android: подключение через WebUSB (Chrome). Нужен OTG-кабель/переходник; телефон должен быть USB-хостом. Драйверы и плагины не нужны — при выборе устройства Android спросит разрешение.';
    return 'Android: откройте сайт в Chrome (не во встроенном браузере Telegram/VK/WebView) — только он даёт доступ к USB. Нужен OTG-кабель.';
  }
  if (backend === 'serial') return 'ПК: Chrome/Edge 89+. Закройте INAV Configurator и другие программы, держащие COM-порт.';
  return 'Этот браузер не даёт доступа к USB. Нужен Chrome или Edge на ПК либо Chrome на Android (OTG).';
}

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

/** Windows re-enumerates the VCP after an FC reboot; the granted port object may be stale. Find a granted twin. */
async function adoptReenumeratedPort(t: WebSerialTransport): Promise<boolean> {
  if (backend !== 'serial') return false;
  const { vid, pid } = t.info();
  const ports = await navigator.serial.getPorts();
  const twin = ports.find((p) => {
    const i = p.getInfo();
    return i.usbVendorId === vid && i.usbProductId === pid && p !== t.currentPort();
  });
  if (!twin) return false;
  t.usePort(twin);
  return true;
}

/** Resolve when the OS reports the rebooted FC back (Web Serial `connect`), or after `ms`. */
function waitForUsbReturn(ms: number): Promise<void> {
  if (backend !== 'serial') return new Promise((r) => setTimeout(r, Math.min(ms, 2500)));
  return new Promise((resolve) => {
    const done = () => {
      navigator.serial.removeEventListener('connect', done);
      resolve();
    };
    navigator.serial.addEventListener('connect', done);
    setTimeout(done, ms);
  });
}

export const useFc = create<FcState>((set, get) => ({
  client: null,
  info: null,
  connecting: false,
  error: null,
  log: [],
  emulated: false,
  preset: null,
  link: 'none',
  async connect(opts) {
    set({ connecting: true, error: null, link: 'connecting' });
    try {
      let transport: Transport;
      if (opts?.emulate) transport = new EmulatedFc(defaultEmulatedFc(opts.preset ?? 'molniya')).transport;
      else if (backend === 'serial') {
        const t = new WebSerialTransport();
        await t.requestPort();
        transport = t;
      } else if (backend === 'usb') {
        const t = new WebUsbCdcTransport();
        await t.requestDevice();
        transport = t;
      } else throw new Error(connectivityHint());
      const client = new MspClient(transport, { log: (e) => set((s) => ({ log: [...s.log.slice(-499), e] })) });
      transport.onClose(() => {
        if (get().client === client) set({ link: 'lost' });
      });
      await client.open();
      const info = await identify(client);
      set({ client, info, connecting: false, link: 'ready', emulated: Boolean(opts?.emulate), preset: opts?.emulate ? opts.preset ?? 'molniya' : null });
    } catch (e) {
      const msg = (e as Error).message;
      const friendly = /No port selected|No device selected/i.test(msg) ? 'Порт не выбран.' : msg;
      set({ connecting: false, error: friendly, link: get().client ? 'lost' : 'none' });
      throw new Error(friendly);
    }
  },
  async ensureLink() {
    const { client, emulated } = get();
    if (!client) throw new Error('Борт не подключён — вернитесь к шагу 1.');
    if (emulated || client.transport.connected) return client;
    set({ link: 'connecting' });
    try {
      await client.open();
      set({ link: 'ready', error: null });
      return client;
    } catch (e) {
      set({ link: 'lost', error: `Порт закрыт и не открывается снова: ${(e as Error).message}` });
      throw new Error('Связь с бортом потеряна (борт перезагрузился или USB переподключён). Нажмите «Переподключить» на шаге 1.');
    }
  },
  async reconnectAfterReboot() {
    const { client, emulated, info } = get();
    if (!client || emulated) return;
    set({ link: 'connecting' });
    await client.close().catch(() => undefined);
    // Windows: the CDC device disappears and comes back as a new SerialPort; wait for the OS event, then retry open ~20 s.
    await waitForUsbReturn(6000);
    await new Promise((r) => setTimeout(r, 800));
    let lastErr = '';
    for (let attempt = 0; attempt < 16; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
      try {
        if (client.transport instanceof WebSerialTransport) await adoptReenumeratedPort(client.transport);
        await client.open();
        const fresh = await identify(client);
        if (info && fresh.uid !== info.uid) throw new Error(`после перезагрузки подключён другой борт (UID ${fresh.uid})`);
        set({ info: fresh, error: null, link: 'ready' });
        return;
      } catch (e) {
        lastErr = (e as Error).message;
        await client.close().catch(() => undefined);
      }
    }
    set({ link: 'lost', error: `Борт перезагрузился, но порт не открылся снова (${lastErr}). Обычно помогает: закрыть INAV Configurator/терминал, переподключить USB, нажать «Переподключить» — данные, снятые до перезагрузки, сохранены.` });
    throw new Error(lastErr);
  },
  async runCliScript(lines, end, onLine) {
    const client = await get().ensureLink();
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
    await get().client?.close().catch(() => undefined);
    set({ client: null, info: null, emulated: false, preset: null, link: 'none', error: null });
  }
}));
