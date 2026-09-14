import { useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';
import { Card, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

interface Post { id: string; slug: string; title: string; body: string; tags: string[] | null; publishedAt: string }

export function NewsPage() {
  return (
    <Routes>
      <Route index element={<List />} />
      <Route path="feedback" element={<Feedback />} />
      <Route path=":slug" element={<One />} />
    </Routes>
  );
}

function List() {
  const [tag, setTag] = useState('');
  const posts = useAsync(() => api<{ posts: Post[] }>(`/news${tag ? `?tag=${tag}` : ''}`), [tag]);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        {['', 'firmware', 'diff', 'service'].map((t) => <button key={t} className={tag === t ? '' : 'secondary'} onClick={() => setTag(t)}>{t || 'все'}</button>)}
        <a className="btn secondary" href={`${import.meta.env.VITE_API_URL ?? ''}/api/news.rss`} target="_blank" rel="noreferrer">RSS</a>
        <Link className="btn secondary" to="/news/feedback">Обратная связь</Link>
      </div>
      {posts.data?.posts.map((p) => (
        <Card key={p.id} title={<Link to={`/news/${p.slug}`}>{p.title}</Link>} right={<span className="muted">{new Date(p.publishedAt).toLocaleDateString()}</span>}>
          <p>{p.body.slice(0, 240)}{p.body.length > 240 ? '…' : ''}</p>
          <div className="row">{p.tags?.map((t) => <span key={t} className="badge">{t}</span>)}</div>
        </Card>
      ))}
      {posts.data && !posts.data.posts.length && <p className="muted">Новостей пока нет.</p>}
    </>
  );
}

function One() {
  const { slug } = useParams();
  const post = useAsync(() => api<{ post: Post }>(`/news/${slug}`), [slug]);
  if (!post.data) return <p className="muted">{post.error ?? 'Загрузка…'}</p>;
  return <Card title={post.data.post.title} right={<span className="muted">{new Date(post.data.post.publishedAt).toLocaleString()}</span>}><div style={{ whiteSpace: 'pre-wrap' }}>{post.data.post.body}</div></Card>;
}

function Feedback() {
  const { user, config, notify } = useStore();
  const [email, setEmail] = useState(user?.email ?? '');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  async function send() {
    await api('/feedback', { method: 'POST', json: { email: email || undefined, subject: subject || undefined, message } });
    setSent(true);
    notify('Сообщение отправлено');
  }
  return (
    <Card title="Обратная связь">
      {sent ? <p className="ok">Спасибо! Ответим на email или в Telegram.</p> : (
        <>
          <label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label>Тема</label><input value={subject} onChange={(e) => setSubject(e.target.value)} />
          <label>Сообщение</label><textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={6} />
          <div className="row" style={{ marginTop: 10 }}>
            <button disabled={message.length < 5} onClick={() => void send()}>Отправить</button>
            <a className="btn secondary" href={`https://t.me/${(config?.telegram ?? '@SVYAT_2023').replace('@', '')}`} target="_blank" rel="noreferrer">Telegram {config?.telegram}</a>
          </div>
        </>
      )}
    </Card>
  );
}
