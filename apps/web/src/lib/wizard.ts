import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FcSnapshot, VtxPair } from '@vtx/msp';

export type Trust = 'verified' | 'experimental' | 'unverified' | 'banned';

export interface SavedSnapshot {
  /** server id from POST /api/snapshots */
  id: string;
  uid: string;
  target: string;
  version: string;
  trust: Trust;
  takenAt: string;
  diffSha256: string | null;
  local: FcSnapshot;
}

export interface DiagBuild { id: string; logPath: 'flash' | 'sdcard' | 'serial_host'; cliScript: string; status: string }

export interface VtxResult {
  modelId: string | null;
  modelName: string | null;
  rangeId: string | null;
  freqSource: 'catalog' | 'vtx_info' | 'manual' | 'file';
  freqTable: number[][];
  pairs: VtxPair[];
  writtenToFc: boolean;
}

export interface TxChoice { code: string; name: string; profileId: string | null; rcChannel: number }

interface WizardState {
  step: number;
  /** UID the wizard state belongs to; a different board resets the flow. */
  uid: string | null;
  fcTarget: string | null;
  fcVersion: string | null;
  trust: Trust | null;
  snapshot: SavedSnapshot | null;
  /** Edited CLI lines the user wants applied on top of the current config. */
  userDiff: string;
  userDiffApplied: boolean;
  diagBuild: DiagBuild | null;
  diagApplied: boolean;
  firmwareId: string | null;
  vtx: VtxResult | null;
  tx: TxChoice;
  /** Server build set (POST /build-sets) — the saved, hashed artifacts for this board. */
  buildSetId: string | null;
  setStep(n: number): void;
  startFor(info: { uid: string; target: string; version: string }, trust: Trust): void;
  patch(p: Partial<Omit<WizardState, 'setStep' | 'startFor' | 'patch' | 'reset'>>): void;
  reset(): void;
}

const initial = {
  step: 0,
  uid: null,
  fcTarget: null,
  fcVersion: null,
  trust: null,
  snapshot: null,
  userDiff: '',
  userDiffApplied: false,
  diagBuild: null,
  diagApplied: false,
  firmwareId: null,
  vtx: null,
  tx: { code: 'tx12mk2', name: 'RadioMaster TX12 MK2', profileId: null, rcChannel: 9 },
  buildSetId: null
};

export const useWizard = create<WizardState>()(
  persist(
    (set, get) => ({
      ...initial,
      setStep: (step) => set({ step }),
      startFor: ({ uid, target, version }, trust) => {
        if (get().uid !== uid) set({ ...initial, uid, fcTarget: target, fcVersion: version, trust, step: 1 });
        else set({ trust, fcTarget: target, fcVersion: version, step: Math.max(1, get().step) });
      },
      patch: (p) => set(p),
      reset: () => set({ ...initial })
    }),
    { name: 'vtx.wizard', version: 2 }
  )
);

/** Destructive steps (diff apply, diagnostic, firmware, VTX write) require a saved snapshot unless the board is verified. */
export function snapshotRequired(trust: Trust | null): boolean {
  return trust !== 'verified';
}

export function canWrite(w: Pick<WizardState, 'trust' | 'snapshot'>): { ok: boolean; why: string | null } {
  if (w.trust === 'banned') return { ok: false, why: 'Этот target/версия запрещены к прошивке через сервис.' };
  if (snapshotRequired(w.trust) && !w.snapshot) return { ok: false, why: 'Сначала снимите и сохраните исходный снимок борта — без него нельзя ничего менять на непроверенном FC.' };
  return { ok: true, why: null };
}

export const TRUST_LABEL: Record<Trust, { text: string; cls: string; hint: string }> = {
  verified: { text: 'проверен в полёте', cls: 'ok', hint: 'Target и версия INAV есть в списке проверенных: летал, системы подтверждены.' },
  experimental: { text: 'экспериментальный', cls: 'warn', hint: 'Target известен, но по нему есть инциденты (падение / неработающий blackbox). Обязательны снимок и диагностическая прошивка.' },
  unverified: { text: 'непроверенный', cls: 'err', hint: 'Такой target/версии в базе нет. Борт может упасть: сначала снимок, затем диагностический контур.' },
  banned: { text: 'запрещён', cls: 'err', hint: 'Прошивка через сервис заблокирована администратором.' }
};
