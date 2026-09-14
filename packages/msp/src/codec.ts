/** MSP v1 / v2 framing. See https://github.com/iNavFlight/inav/wiki/MSP-V2 */

export function crc8DvbS2(crc: number, byte: number): number {
  crc ^= byte;
  for (let i = 0; i < 8; i++) {
    crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function crc8DvbS2Buf(data: Uint8Array, seed = 0): number {
  let crc = seed;
  for (const b of data) crc = crc8DvbS2(crc, b);
  return crc;
}

export interface MspMessage {
  version: 1 | 2;
  code: number;
  flags: number;
  payload: Uint8Array;
  /** '!' for FC error responses */
  error: boolean;
}

export function encodeV2(code: number, payload: Uint8Array = new Uint8Array(0), flags = 0): Uint8Array {
  const len = payload.length;
  const out = new Uint8Array(9 + len);
  out[0] = 0x24; // $
  out[1] = 0x58; // X
  out[2] = 0x3c; // <
  out[3] = flags;
  out[4] = code & 0xff;
  out[5] = (code >> 8) & 0xff;
  out[6] = len & 0xff;
  out[7] = (len >> 8) & 0xff;
  out.set(payload, 8);
  out[8 + len] = crc8DvbS2Buf(out.subarray(3, 8 + len));
  return out;
}

export function encodeV1(code: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const len = payload.length;
  const out = new Uint8Array(6 + len);
  out[0] = 0x24;
  out[1] = 0x4d; // M
  out[2] = 0x3c;
  out[3] = len;
  out[4] = code;
  out.set(payload, 5);
  let ck = len ^ code;
  for (const b of payload) ck ^= b;
  out[5 + len] = ck & 0xff;
  return out;
}

export function encode(code: number, payload?: Uint8Array): Uint8Array {
  return code > 0xff ? encodeV2(code, payload) : encodeV1(code, payload);
}

type State =
  | 'IDLE'
  | 'HEADER_START'
  | 'HEADER_M'
  | 'HEADER_X'
  | 'V1_LEN'
  | 'V1_CODE'
  | 'V1_PAYLOAD'
  | 'V1_CRC'
  | 'V2_FLAGS'
  | 'V2_CODE_LO'
  | 'V2_CODE_HI'
  | 'V2_LEN_LO'
  | 'V2_LEN_HI'
  | 'V2_PAYLOAD'
  | 'V2_CRC';

/** Incremental MSP parser: feed bytes, receive complete messages. */
export class MspParser {
  private state: State = 'IDLE';
  private error = false;
  private code = 0;
  private flags = 0;
  private len = 0;
  private idx = 0;
  private payload = new Uint8Array(0);
  private crc = 0;
  public crcErrors = 0;

  /** `acceptRequests` also parses '<' (client→FC) frames; used by emulators. */
  constructor(
    private readonly onMessage: (m: MspMessage) => void,
    private readonly acceptRequests = false
  ) {}

  private isDir(b: number): boolean {
    return b === 0x3e || b === 0x21 || (this.acceptRequests && b === 0x3c);
  }

  feed(chunk: Uint8Array): void {
    for (const b of chunk) this.byte(b);
  }

  private reset(): void {
    this.state = 'IDLE';
  }

  private byte(b: number): void {
    switch (this.state) {
      case 'IDLE':
        if (b === 0x24) this.state = 'HEADER_START';
        break;
      case 'HEADER_START':
        if (b === 0x4d) this.state = 'HEADER_M';
        else if (b === 0x58) this.state = 'HEADER_X';
        else this.reset();
        break;
      case 'HEADER_M':
        if (this.isDir(b)) {
          this.error = b === 0x21;
          this.state = 'V1_LEN';
        } else this.reset();
        break;
      case 'HEADER_X':
        if (this.isDir(b)) {
          this.error = b === 0x21;
          this.state = 'V2_FLAGS';
        } else this.reset();
        break;
      case 'V1_LEN':
        this.len = b;
        this.crc = b;
        this.payload = new Uint8Array(b);
        this.idx = 0;
        this.state = 'V1_CODE';
        break;
      case 'V1_CODE':
        this.code = b;
        this.crc ^= b;
        this.state = this.len ? 'V1_PAYLOAD' : 'V1_CRC';
        break;
      case 'V1_PAYLOAD':
        this.payload[this.idx++] = b;
        this.crc ^= b;
        if (this.idx === this.len) this.state = 'V1_CRC';
        break;
      case 'V1_CRC':
        if ((this.crc & 0xff) === b) this.emit(1);
        else this.crcErrors++;
        this.reset();
        break;
      case 'V2_FLAGS':
        this.flags = b;
        this.crc = crc8DvbS2(0, b);
        this.state = 'V2_CODE_LO';
        break;
      case 'V2_CODE_LO':
        this.code = b;
        this.crc = crc8DvbS2(this.crc, b);
        this.state = 'V2_CODE_HI';
        break;
      case 'V2_CODE_HI':
        this.code |= b << 8;
        this.crc = crc8DvbS2(this.crc, b);
        this.state = 'V2_LEN_LO';
        break;
      case 'V2_LEN_LO':
        this.len = b;
        this.crc = crc8DvbS2(this.crc, b);
        this.state = 'V2_LEN_HI';
        break;
      case 'V2_LEN_HI':
        this.len |= b << 8;
        this.crc = crc8DvbS2(this.crc, b);
        this.payload = new Uint8Array(this.len);
        this.idx = 0;
        this.state = this.len ? 'V2_PAYLOAD' : 'V2_CRC';
        break;
      case 'V2_PAYLOAD':
        this.payload[this.idx++] = b;
        this.crc = crc8DvbS2(this.crc, b);
        if (this.idx === this.len) this.state = 'V2_CRC';
        break;
      case 'V2_CRC':
        if (this.crc === b) this.emit(2);
        else this.crcErrors++;
        this.reset();
        break;
    }
  }

  private emit(version: 1 | 2): void {
    this.onMessage({ version, code: this.code, flags: this.flags, payload: this.payload, error: this.error });
  }
}

/** Little-endian payload reader/writer helpers. */
export class PayloadReader {
  private pos = 0;
  private readonly view: DataView;
  constructor(public readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  u8(): number {
    return this.view.getUint8(this.pos++);
  }
  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytes(n: number): Uint8Array {
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  ascii(n: number): string {
    return String.fromCharCode(...this.bytes(n));
  }
}

export class PayloadWriter {
  private parts: number[] = [];
  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.parts.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  u32(v: number): this {
    this.parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  bytes(b: Uint8Array | number[]): this {
    this.parts.push(...b);
    return this;
  }
  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.parts.push(s.charCodeAt(i) & 0xff);
    return this;
  }
  build(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}
