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

  async connect(): Promise<void> {
    if (!this.port) await this.requestPort();
    const port = this.port!;
    await port.open({ baudRate: this.baudRate });
    this.writer = port.writable!.getWriter();
    this.reader = port.readable!.getReader();
    this.connected = true;
    this.readLoop = this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) for (const cb of this.dataCbs) cb(value);
      }
    } catch {
      /* port closed / unplugged */
    } finally {
      this.connected = false;
      for (const cb of this.closeCbs) cb();
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.reader?.cancel();
      this.reader?.releaseLock();
      this.reader = null;
      await this.writer?.close().catch(() => undefined);
      this.writer?.releaseLock();
      this.writer = null;
      await this.readLoop;
      await this.port?.close();
    } finally {
      this.connected = false;
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('not connected');
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
