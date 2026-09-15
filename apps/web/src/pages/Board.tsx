import { useEffect, useRef } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Tip } from '../components/ui';
import { useFc } from '../lib/fc';
import { canWrite, useWizard } from '../lib/wizard';
import { StepConnect, StepCrash, StepDiff, StepFirmware, StepSnapshot } from './Wizard';

const TABS = [
  ['connect', 'Подключение'],
  ['snapshot', 'Снимок'],
  ['diff', 'Diff и опции'],
  ['firmware', 'Прошивка'],
  ['crash', 'После полёта']
] as const;

/** wizard step index → board tab (VTX/radio/artifact steps leave the section). */
const STEP_ROUTE: Record<number, string> = { 0: '/board/connect', 1: '/board/snapshot', 2: '/board/diff', 3: '/board/firmware', 4: '/vtx', 5: '/transmitter', 6: '/wizard', 7: '/board/crash' };
const TAB_STEP: Record<string, number> = { connect: 0, snapshot: 1, diff: 2, firmware: 3, crash: 7 };

/** Board section: the FC-only half of the wizard (steps 1-4, 8) with the same state store, without VTX/radio. */
export function BoardPage() {
  const fc = useFc();
  const w = useWizard();
  const gate = canWrite(w);
  const nav = useNavigate();
  const loc = useLocation();
  const tab = loc.pathname.split('/')[2] ?? 'connect';
  const lastStep = useRef(w.step);
  // step components advance via the shared wizard store; here that maps onto tabs instead of the single-page flow
  useEffect(() => {
    const s = TAB_STEP[tab];
    if (s !== undefined && w.step !== s) { lastStep.current = s; w.setStep(s); }
  }, [tab]);
  useEffect(() => {
    if (w.step !== lastStep.current) { lastStep.current = w.step; const to = STEP_ROUTE[w.step]; if (to) nav(to); }
  }, [w.step]);
  return (
    <>
      <nav className="tabs">
        {TABS.map(([p, l]) => <NavLink key={p} to={`/board/${p}`}>{l}</NavLink>)}
        <Link to="/autoflash">AutoFlash</Link>
        <Link to="/diff">Diff-система</Link>
      </nav>
      {!fc.info && <Tip>Раздел про сам борт: идентификация FC, снимок «как было», diff/опции, прошивка (рабочая или диагностическая) и анализ после полёта. Автопереключение каналов — в разделе «VTX», пульт — в разделе «Пульт», всё вместе по шагам — в «Мастере».</Tip>}
      <Routes>
        <Route index element={<Navigate to="connect" replace />} />
        <Route path="connect" element={<StepConnect />} />
        <Route path="snapshot" element={<StepSnapshot />} />
        <Route path="diff" element={<StepDiff gate={gate} />} />
        <Route path="firmware" element={<StepFirmware gate={gate} />} />
        <Route path="crash" element={<StepCrash />} />
        <Route path="*" element={<Navigate to="connect" replace />} />
      </Routes>
    </>
  );
}
