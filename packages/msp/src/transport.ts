/** Transport abstraction: Web Serial in browser, in-memory for emulators/tests. */

export interface Transport {
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  onData(cb: (chunk: Uint8Array) => void): () => void;
  onClose(cb: () => void): () => void;
  info(): { vid?: number; pid?: number; label: string };
}

/** Known USB VID/PID → device hints. */
export const KNOWN_USB: Record<string, { label: string; kind: 'fc' | 'dfu' | 'transmitter' }> = {
  '0483:5740': { label: 'STM32 Virtual COM Port (FC / INAV)', kind: 'fc' },
  '0483:df11': { label: 'STM32 DFU bootloader', kind: 'dfu' },
  '2e3c:5740': { label: 'AT32 Virtual COM Port', kind: 'fc' },
  '1209:4f54': { label: 'EdgeTX radio (USB serial)', kind: 'transmitter' },
  '0483:5750': { label: 'EdgeTX radio (CDC)', kind: 'transmitter' }
};

export function usbKey(vid?: number, pid?: number): string | undefined {
  if (vid === undefined || pid === undefined) return undefined;
  return `${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}`;
}

export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/** Android Chrome has no Web Serial, but exposes CDC-ACM boards (STM32 VCP) through WebUSB. */
export function isWebUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

export type SerialBackend = 'serial' | 'usb' | null;
export function serialBackend(): SerialBackend {
  if (isWebSerialSupported()) return 'serial';
  if (isWebUsbSupported()) return 'usb';
  return null;
}

export class WebSerialTransport implements Transport {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private dataCbs = new Set<(c: Uint8Array) => void>();
  private closeCbs = new Set<() => void>();
  private readLoop: Promise<void> | null = null;
  connected = false;

  constructor(private readonly baudRate = 115200) {}

  async requestPort(filters?: SerialPortFilter[]): Promise<void> {
    if (!isWebSerialSupported()) throw new Error('Web Serial не поддерживается этим браузером');
    this.port = await navigator.serial.requestPort(filters ? { filters } : undefined);
  }

  usePort(port: SerialPort): void {
    this.port = port;
  }

  currentPort(): SerialPort | null {
    return this.port;
  }

  /** Reopens the same port if it was closed (FC reboot, previous session ended) — no picker. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.port) await this.requestPort();
    const port = this.port!;
    try {
      await port.open({ baudRate: this.baudRate });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/already open/i.test(msg)) {
        /* left open by a previous session — reuse */
      } else if (/failed to open|access denied|busy/i.test(msg)) {
        throw new Error(`Порт занят другой программой (INAV Configurator, Betaflight, терминал?). Закройте её и повторите. (${msg})`);
      } else throw e;
    }
    if (!port.writable || !port.readable) throw new Error('Порт открылся, но не даёт потоки чтения/записи — переподключите USB');
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.connected = true;
    this.readLoop = this.pump();
  }

  /**
   * Windows CDC drivers surface framing/overrun/break as a *fatal* error on `readable`; the port stays open and
   * a fresh `readable` appears. Keep pumping in that case; only give up when the port itself is gone.
   */
  private async pump(): Promise<void> {
    try {
      while (this.connected) {
        if (!this.reader) {
          if (!this.port?.readable) break;
          this.reader = this.port.readable.getReader();
        }
        try {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) for (const cb of this.dataCbs) cb(value);
        } catch (e) {
          const name = (e as { name?: string }).name ?? '';
          this.reader.releaseLock();
          this.reader = null;
          if (this.connected && this.port?.readable && /BufferOverrun|Framing|Parity|Break/.test(name)) continue;
          break;
        }
      }
    } finally {
      this.connected = false;
      this.writer?.releaseLock();
      this.writer = null;
      this.reader = null;
      for (const cb of this.closeCbs) cb();
    }
  }

  async disconnect(): Promise<void> {
    // On Windows a rebooting FC can leave cancel()/close() hanging; never let that block the caller.
    const withTimeout = <T>(p: Promise<T> | undefined, ms: number) =>
      Promise.race([p ?? Promise.resolve(undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]).catch(() => undefined);
    try {
      this.connected = false;
      await withTimeout(this.reader?.cancel(), 1500);
      await withTimeout(this.writer?.close(), 1500);
      await withTimeout(this.readLoop ?? undefined, 1500);
      await withTimeout(this.port?.close(), 3000);
    } finally {
      this.connected = false;
      this.reader = null;
      this.writer = null;
      this.readLoop = null;
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer || !this.connected) throw new Error('Соединение с бортом потеряно (порт закрыт). Нажмите «Переподключить».');
    await this.writer.write(data);
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  info(): { vid?: number; pid?: number; label: string } {
    const i = this.port?.getInfo();
    const key = usbKey(i?.usbVendorId, i?.usbProductId);
    return {
      vid: i?.usbVendorId,
      pid: i?.usbProductId,
      label: (key && KNOWN_USB[key]?.label) || (key ? `USB ${key}` : 'Serial port')
    };
  }
}

/**
 * CDC-ACM over WebUSB (Android Chrome). The FC's STM32 VCP exposes a control interface (class 0x02) and a data
 * interface (class 0x0A) with one bulk IN and one bulk OUT endpoint. Line coding is set via CDC requests
 * SET_LINE_CODING (0x20) / SET_CONTROL_LINE_STATE (0x22); DTR must be asserted or INAV stays silent.
 */
export class WebUsbCdcTransport implements Transport {
  private device: USBDevice | null = null;
  private epIn = 0;
  private epOut = 0;
  private ctrlIface = 0;
  private dataIface = 0;
  private dataCbs = new Set<(c: Uint8Array) => void>();
  private closeCbs = new Set<() => void>();
  private readLoop: Promise<void> | null = null;
  connected = false;

  constructor(private readonly baudRate = 115200) {}

  async requestDevice(): Promise<void> {
    if (!isWebUsbSupported()) throw new Error('WebUSB не поддерживается этим браузером');
    const known: USBDeviceFilter[] = Object.keys(KNOWN_USB)
      .filter((k) => k !== '0483:df11')
      .map((k) => ({ vendorId: parseInt(k.slice(0, 4), 16), productId: parseInt(k.slice(5), 16) }));
    this.device = await navigator.usb.requestDevice({ filters: [...known, { classCode: 0x02 }] });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.device) await this.requestDevice();
    const dev = this.device!;
    try {
      await dev.open();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/access denied|permission/i.test(msg)) {
        throw new Error(`Android не дал доступ к USB. Разрешите доступ в системном диалоге, проверьте OTG-кабель и режим USB-хоста. (${msg})`);
      }
      throw e;
    }
    if (dev.configuration === null) await dev.selectConfiguration(1);
    const cfg = dev.configuration!;
    const alt = (i: USBInterface) => i.alternates[0];
    const ctrl = cfg.interfaces.find((i) => alt(i)?.interfaceClass === 0x02);
    const data = cfg.interfaces.find((i) => alt(i)?.interfaceClass === 0x0a);
    if (!ctrl || !data) throw new Error('USB-устройство не является CDC-ACM (виртуальный COM-порт). Борт в DFU или нужен другой кабель/режим?');
    this.ctrlIface = ctrl.interfaceNumber;
    this.dataIface = data.interfaceNumber;
    for (const ep of alt(data)?.endpoints ?? []) {
      if (ep.type !== 'bulk') continue;
      if (ep.direction === 'in') this.epIn = ep.endpointNumber;
      else this.epOut = ep.endpointNumber;
    }
    if (!this.epIn || !this.epOut) throw new Error('У CDC-интерфейса нет bulk-эндпоинтов');
    try {
      await dev.claimInterface(this.ctrlIface);
      await dev.claimInterface(this.dataIface);
    } catch (e) {
      throw new Error(`Не удалось захватить USB-интерфейс: устройство занято системным драйвером или другим приложением (${(e as Error).message})`);
    }
    const lc = new DataView(new ArrayBuffer(7));
    lc.setUint32(0, this.baudRate, true);
    lc.setUint8(4, 0); // 1 stop bit
    lc.setUint8(5, 0); // no parity
    lc.setUint8(6, 8); // 8 data bits
    const ctl = (request: number, value: number, data?: BufferSource) =>
      dev.controlTransferOut({ requestType: 'class', recipient: 'interface', request, value, index: this.ctrlIface }, data);
    await ctl(0x20, 0, lc.buffer);
    await ctl(0x22, 0x03); // DTR | RTS
    this.connected = true;
    this.readLoop = this.pump();
  }

  private async pump(): Promise<void> {
    const dev = this.device!;
    try {
      while (this.connected) {
        const r = await dev.transferIn(this.epIn, 512);
        if (r.status === 'stall') {
          await dev.clearHalt('in', this.epIn);
          continue;
        }
        if (r.data && r.data.byteLength) {
          const chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
          for (const cb of this.dataCbs) cb(chunk);
        }
      }
    } catch {
      /* device gone / closed */
    } finally {
      this.connected = false;
      for (const cb of this.closeCbs) cb();
    }
  }

  async disconnect(): Promise<void> {
    const dev = this.device;
    this.connected = false;
    try {
      if (dev?.opened) {
        await dev.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 0, index: this.ctrlIface }).catch(() => undefined);
        await dev.releaseInterface(this.dataIface).catch(() => undefined);
        await dev.releaseInterface(this.ctrlIface).catch(() => undefined);
        await dev.close().catch(() => undefined);
      }
    } finally {
      await this.readLoop?.catch(() => undefined);
      this.readLoop = null;
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.connected || !this.device) throw new Error('Соединение с бортом потеряно (USB закрыт). Нажмите «Переподключить».');
    const r = await this.device.transferOut(this.epOut, data.slice().buffer);
    if (r.status !== 'ok') throw new Error(`USB write ${r.status}`);
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  info(): { vid?: number; pid?: number; label: string } {
    const d = this.device;
    const key = usbKey(d?.vendorId, d?.productId);
    return {
      vid: d?.vendorId,
      pid: d?.productId,
      label: `${(key && KNOWN_USB[key]?.label) || (key ? `USB ${key}` : 'USB')} (WebUSB)`
    };
  }
}

/** Loopback transport: `handler` receives full frames written by the client and returns FC responses. */
export class LoopbackTransport implements Transport {
  connected = false;
  private dataCbs = new Set<(c: Uint8Array) => void>();
  private closeCbs = new Set<() => void>();
  constructor(private readonly handler: (frame: Uint8Array) => Promise<Uint8Array | null> | Uint8Array | null) {}
  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    for (const cb of this.closeCbs) cb();
  }
  async write(data: Uint8Array): Promise<void> {
    const res = await this.handler(data);
    if (res) queueMicrotask(() => this.dataCbs.forEach((cb) => cb(res)));
  }
  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }
  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
  info() {
    return { label: 'Emulator' };
  }
}
