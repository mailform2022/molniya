import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Tip } from '../components/ui';
import { useFc, webSerialSupported } from '../lib/fc';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

export function ConnectPage() {
  const fc = useFc();
  const { user, notify } = useStore();
  const [cliOut, setCliOut] = useState('');
  const [cmd, setCmd] = useState('vtx_info');

  async function runCli() {
    if (!fc.client) return;
    const out = await fc.client.cli(cmd);
    setCliOut(out);
  }
  async function registerBoard() {
    if (!fc.info) return;
    await api('/devices', { method: 'POST', json: { kind: 'board', uid: fc.info.uid, name: fc.info.target, firmwareVersion: fc.info.version } });
    notify('Борт добавлен в кабинет');
  }

  return (
    <>
      <Card title="Подключение борта" right={fc.info ? <span className="badge ok">{fc.emulated ? 'эмулятор' : 'USB'}</span> : <span className="badge">не подключён</span>}>
        {!webSerialSupported && <Tip>Web Serial недоступен: используйте Chrome/Edge на ПК или Android (Chrome 148+, OTG-кабель). Можно тренироваться на эмуляторе.</Tip>}
        <div className="row" style={{ marginTop: 10 }}>
          {!fc.info ? (
            <>
              <button disabled={!webSerialSupported || fc.connecting} onClick={() => fc.connect().catch(() => undefined)}>Подключить по USB</button>
              <button className="secondary" disabled={fc.connecting} onClick={() => fc.connect({ emulate: true }).catch(() => undefined)}>Эмулятор борта</button>
            </>
          ) : (
            <button className="secondary" onClick={() => void fc.disconnect()}>Отключить</button>
          )}
        </div>
        {fc.error && <p className="err">{fc.error}</p>}
        {fc.info && (
          <table style={{ marginTop: 12 }}>
            <tbody>
              <tr><th>Прошивка</th><td>{fc.info.variant} {fc.info.version}</td></tr>
              <tr><th>Target</th><td>{fc.info.target} ({fc.info.boardId})</td></tr>
              <tr><th>UID</th><td className="kbd">{fc.info.uid}</td></tr>
            </tbody>
          </table>
        )}
        {fc.info && (
          <div className="row" style={{ marginTop: 12 }}>
            {user && <button onClick={() => void registerBoard()}>Сохранить в кабинет</button>}
            <Link className="btn" to="/wizard">Мастер по всем шагам →</Link>
            <Link className="btn secondary" to="/board/snapshot">Раздел «Борт»: снимок → diff → прошивка →</Link>
            <Link className="btn secondary" to="/vtx">Только AutoDetect VTX →</Link>
          </div>
        )}
      </Card>
      {fc.info && (
        <Card title="CLI">
          <div className="row">
            <input value={cmd} onChange={(e) => setCmd(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && void runCli()} />
            <button onClick={() => void runCli()}>Выполнить</button>
          </div>
          {cliOut && <pre className="log" style={{ marginTop: 10 }}>{cliOut}</pre>}
        </Card>
      )}
      <Card title="Лог MSP" right={<button className="secondary" onClick={() => useFc.setState({ log: [] })}>Очистить</button>}>
        <div className="log">
          {fc.log.slice(-200).map((e, i) => (
            <div key={i} className={e.dir === 'err' ? 'err' : e.dir === 'tx' ? 'muted' : ''}>
              {new Date(e.t).toLocaleTimeString()} {e.dir.toUpperCase()} {e.code !== undefined ? `0x${e.code.toString(16)}` : ''} {e.text}
            </div>
          ))}
          {!fc.log.length && <span className="muted">пусто</span>}
        </div>
      </Card>
    </>
  );
}
