import { useState } from 'react';
import { Card, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

export type Col = [key: string, title: string, kind?: 'number' | 'bool' | 'json' | 'text' | string[]];
type Row = Record<string, unknown> & { id: string };

/** Generic CRUD table used by most admin sections. */
export function AdminSection({ title, list, pick, create, update, remove, method = 'PUT', cols }: { title: string; list: string; pick: string; create?: string; update?: (id: string) => string; remove?: (id: string) => string; method?: 'PUT' | 'PATCH'; cols: Col[] }) {
  const data = useAsync(() => api<Record<string, Row[]>>(list), [list]);
  const rows = data.data?.[pick] ?? [];
  const [edit, setEdit] = useState<Row | null>(null);
  const { notify } = useStore();

  async function save() {
    if (!edit) return;
    const body: Record<string, unknown> = {};
    for (const [k, , kind] of cols) {
      let v = edit[k];
      if (v === undefined || v === '') continue;
      if (kind === 'number') v = Number(v);
      if (kind === 'json' && typeof v === 'string') {
        try { v = JSON.parse(v); } catch { return notify(`Некорректный JSON в поле ${k}`); }
      }
      body[k] = v;
    }
    try {
      if (edit.id && update) await api(update(edit.id), { method, json: body });
      else if (create) await api(create, { method: 'POST', json: body });
      setEdit(null);
      data.reload();
      notify('Сохранено');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const show = (v: unknown, kind?: Col[2]) => (kind === 'json' ? JSON.stringify(v) : kind === 'bool' ? (v ? '✓' : '—') : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).toLocaleString() : String(v ?? '—'));

  return (
    <Card title={title} right={create && <button className="secondary" onClick={() => setEdit({ id: '' })}>+</button>}>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr>{cols.map(([k, t]) => <th key={k}>{t}</th>)}<th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              {cols.map(([k, , kind]) => <td key={k} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: kind === 'text' || kind === 'json' ? 'nowrap' : undefined }}>{show(r[k], kind)}</td>)}
              <td className="row">{update && <button className="secondary" onClick={() => setEdit({ ...r, ...Object.fromEntries(cols.filter(([, , k]) => k === 'json').map(([k]) => [k, JSON.stringify(r[k], null, 1)])) })}>✎</button>}{remove && <button className="danger" onClick={() => confirm('Удалить?') && api(remove(r.id), { method: 'DELETE' }).then(data.reload)}>✕</button>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      {edit && (
        <div className="card" style={{ background: 'var(--panel2)', marginTop: 12 }}>
          {cols.map(([k, t, kind]) => (
            <div key={k}>
              <label>{t}</label>
              {kind === 'bool' ? <input type="checkbox" style={{ width: 'auto' }} checked={Boolean(edit[k])} onChange={(e) => setEdit({ ...edit, [k]: e.target.checked })} />
                : Array.isArray(kind) ? <select value={String(edit[k] ?? '')} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}><option value="">—</option>{kind.map((o) => <option key={o}>{o}</option>)}</select>
                : kind === 'json' || kind === 'text' ? <textarea className={kind === 'json' ? 'code' : ''} style={{ minHeight: 90 }} value={String(edit[k] ?? '')} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
                : <input type={kind === 'number' ? 'number' : 'text'} value={String(edit[k] ?? '')} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />}
            </div>
          ))}
          <div className="row" style={{ marginTop: 10 }}><button onClick={() => void save()}>Сохранить</button><button className="secondary" onClick={() => setEdit(null)}>Отмена</button></div>
        </div>
      )}
    </Card>
  );
}
