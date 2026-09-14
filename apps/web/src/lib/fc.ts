import { create } from 'zustand';
import { EmulatedFc, MspClient, WebSerialTransport, type MspLogEntry, type Transport } from '@vtx/msp';

export interface FcInfo { variant: string; version: string; target: string; boardId: string; uid: string }

interface FcState {
  client: MspClient | null;
  info: FcInfo | null;
  connecting: boolean;
  error: string | null;
  log: MspLogEntry[];
  emulated: boolean;
  connect(opts?: { emulate?: boolean }): Promise<void>;
  disconnect(): Promise<void>;
}

export const webSerialSupported = typeof navigator !== 'undefined' && 'serial' in navigator;

export const useFc = create<FcState>((set, get) => ({
  client: null,
  info: null,
  connecting: false,
  error: null,
  log: [],
  emulated: false,
  async connect(opts) {
    set({ connecting: true, error: null });
    try {
      let transport: Transport;
      if (opts?.emulate) transport = new EmulatedFc().transport;
      else {
        if (!webSerialSupported) throw new Error('Web Serial не поддерживается. Нужен Chrome/Edge 89+ (Android: Chrome 148+ и OTG).');
        const t = new WebSerialTransport();
        await t.requestPort();
        transport = t;
      }
      const client = new MspClient(transport, { log: (e) => set((s) => ({ log: [...s.log.slice(-499), e] })) });
      await client.open();
      const variant = await client.fcVariant();
      const version = await client.fcVersion();
      const board = await client.boardInfo();
      let uid = '';
      try {
        uid = await client.getUid();
      } catch {
        uid = await client.uid();
      }
      set({ client, info: { variant, version, target: board.targetName, boardId: board.identifier, uid }, connecting: false, emulated: Boolean(opts?.emulate) });
    } catch (e) {
      set({ connecting: false, error: (e as Error).message });
      throw e;
    }
  },
  async disconnect() {
    await get().client?.close();
    set({ client: null, info: null, emulated: false });
  }
}));
