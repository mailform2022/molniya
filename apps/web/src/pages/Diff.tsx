import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Tip, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { useFc } from '../lib/fc';
import { onRealtime, useStore } from '../lib/store';

interface Template { id: string; name: string; boardModelId: string | null; version: string | null; content: string; isDefault: boolean }
interface Diff { id: string; name: string; boardModelId: string | null; parentTemplateId: string | null; isActive: boolean; version: number; content: string; draft: string | null }
interface Version { id: string; version: number; content: string; createdAt: string }
interface Analysis { commands: number; unknown: string[]; conflicts: string[] }

export function DiffPage() {
  const { token } = useParams();
  const { notify, sessionRole } = useStore();
  const fc = useFc();
  const templates = useAsync(() => api<{ templates: Template[] }>('/diff/templates'));
  const diffs = useAsync(() => api<{ diffs: Diff[] }>('/diffs').catch(() => ({ diffs: [] as Diff[] })));
  const [sel, setSel] = useState<Diff | null>(null);
  const [text, setText] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [shared, setShared] = useState<{ name: string; content: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const readOnly = sessionRole !== 'operator';

  useEffect(() => {
    if (token) void api<{ diff: { name: string; content: string } }>(`/diff/shared/${token}`).then((r) => { setShared(r.diff); setText(r.diff.content); });
  }, [token]);
  useEffect(() => onRealtime((ev) => {
    if (ev.type === 'diff.draft' && !ev.self && sel && (ev.payload as { id: string }).id === sel.id) { notify('Diff изменён в другой сессии'); diffs.reload(); }
  }), [sel, diffs, notify]);

  function open(d: Diff) {
    setSel(d);
    setText(d.draft ?? d.content);
    void api<{ versions: Array<{ user_diff_versions: Version }> }>(`/diffs/${d.id}/versions`).then((r) => setVersions(r.versions.map((v) => v.user_diff_versions)));
    void analyze(d.draft ?? d.content);
  }
  async function analyze(content: string) {
    const r = await api<{ analysis: Analysis }>('/diff/analyze', { method: 'POST', json: { content, base: sel ? templates.data?.templates.find((t) => t.id === sel.parentTemplateId)?.content : undefined } });
    setAnalysis(r.analysis);
  }
  function edit(v: string) {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (sel && !readOnly) void api<{ analysis: Analysis }>(`/diffs/${sel.id}/draft`, { method: 'PUT', json: { draft: v } }).then((r) => setAnalysis(r.analysis));
      else void analyze(v);
    }, 5000);
  }
  async function create(fromTemplate?: Template) {
    const name = prompt('Название diff', fromTemplate ? `${fromTemplate.name} (мой)` : 'Новый diff');
    if (!name) return;
    const r = await api<{ diff: Diff }>('/diffs', { method: 'POST', json: { name, parentTemplateId: fromTemplate?.id, content: fromTemplate ? undefined : text || undefined } });
    diffs.reload();
    open(r.diff);
  }
  async function commit() {
    if (!sel) return;
    await api(`/diffs/${sel.id}/versions`, { method: 'POST', json: { content: text } });
    notify('Версия сохранена');
    diffs.reload();
    open({ ...sel, content: text, draft: text });
  }
  async function applyToFc() {
    if (!fc.client) return notify('Подключите борт');
    const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
    for (const l of lines) await fc.client.cli(l, 800).catch(() => undefined);
    if (sel) await api('/diffs/usage', { method: 'POST', json: { diffId: sel.id, action: 'applied' } });
    notify(`Отправлено ${lines.length} команд`);
  }
  async function share() {
    if (!sel) return;
    const r = await api<{ token: string }>(`/diffs/${sel.id}/share`, { method: 'POST', json: {} });
    const url = `${location.origin}/diff/shared/${r.token}`;
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    notify(`Ссылка скопирована: ${url}`);
  }
  async function readFromFc() {
    if (!fc.client) return notify('Подключите борт');
    const out = await fc.client.cli('diff all', 6000);
    setText(out);
    void analyze(out);
  }

  return (
    <>
      {shared && <Card title={`Общий diff: ${shared.name}`}><Tip>Это diff, которым с вами поделились. Импортируйте в свои, чтобы редактировать.</Tip><button style={{ marginTop: 8 }} onClick={() => void create()}>Импортировать</button></Card>}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(240px, 1fr) 2fr' }}>
        <div>
          <Card title="Эталонные">
            {templates.data?.templates.map((t) => (
              <div key={t.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span>{t.name} <span className="muted">{t.version}</span></span>
                <button className="secondary" onClick={() => void create(t)}>Создать мой</button>
              </div>
            ))}
          </Card>
          <Card title="Мои diff" right={<button className="secondary" onClick={() => void create()}>+</button>}>
            {diffs.data?.diffs.map((d) => (
              <div key={d.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <a href="#" onClick={(e) => { e.preventDefault(); open(d); }} style={{ fontWeight: sel?.id === d.id ? 700 : 400 }}>{d.isActive ? '● ' : ''}{d.name} <span className="muted">v{d.version}</span></a>
                {!d.isActive && <button className="secondary" onClick={() => void api(`/diffs/${d.id}/activate`, { method: 'POST' }).then(() => diffs.reload())}>активный</button>}
              </div>
            ))}
            {diffs.data && !diffs.data.diffs.length && <p className="muted">Пока нет. Создайте из эталонного или считайте с борта.</p>}
          </Card>
        </div>
        <div>
          <Card title={sel ? sel.name : 'Редактор'} right={<div className="row"><button className="secondary" onClick={() => void readFromFc()}>diff all с борта</button>{sel && <button className="secondary" onClick={() => void share()}>Поделиться</button>}</div>}>
            <textarea className="code" value={text} onChange={(e) => edit(e.target.value)} readOnly={readOnly && !!sel} spellCheck={false} />
            {analysis && (
              <p className="muted" style={{ marginTop: 6 }}>
                {analysis.commands} команд ·{' '}
                {analysis.unknown.length ? <span className="warn">неизвестных: {analysis.unknown.length} </span> : 'все команды известны '}
                {analysis.conflicts.length ? <span className="err">· конфликтов: {analysis.conflicts.join('; ')}</span> : ''}
              </p>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              {sel && <button disabled={readOnly} onClick={() => void commit()}>Сохранить версию</button>}
              <button className="secondary" onClick={() => void applyToFc()}>Применить на борт</button>
              <a className="btn secondary" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download={`${sel?.name ?? 'diff'}.txt`}>Экспорт .txt</a>
              {sel && <button className="danger" onClick={() => confirm('Удалить diff?') && api(`/diffs/${sel.id}`, { method: 'DELETE' }).then(() => { setSel(null); diffs.reload(); })}>Удалить</button>}
            </div>
          </Card>
          {sel && versions.length > 0 && (
            <Card title="Версии">
              <table><tbody>{versions.map((v) => <tr key={v.id}><td>v{v.version}</td><td className="muted">{new Date(v.createdAt).toLocaleString()}</td><td><button className="secondary" onClick={() => void api(`/diffs/${sel.id}/rollback/${v.id}`, { method: 'POST' }).then(() => { setText(v.content); notify('Откат выполнен'); })}>Откатить</button></td></tr>)}</tbody></table>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
