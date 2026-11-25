import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MINISTRY_EMBLEMS, formatRelative } from './ministerios';
import Icon from './Icon.jsx';

const PAGE_SIZE = 10;

function Comments({ post, api, showToast, isAdmin, onCountChange }) {
  const [comments, setComments] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    api(`/feed/${post.id}/comments`)
      .then((data) => { if (alive) setComments(data); })
      .catch((err) => { if (alive) { setComments([]); showToast('Comentários', err.message, 'warning'); } });
    return () => { alive = false; };
  }, [post.id]);

  const send = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const data = await api(`/feed/${post.id}/comments`, { method: 'POST', body: { body } });
      const fresh = await api(`/feed/${post.id}/comments`);
      setComments(fresh);
      onCountChange(fresh.length);
      setText('');
      if (data.reward) {
        showToast('Participação registrada', `+${data.reward.points} pontos na sua carteira cívica.`, 'success');
      }
    } catch (err) {
      showToast('Não foi possível comentar', err.message, 'warning');
    } finally {
      setSending(false);
    }
  };

  const remove = async (id) => {
    try {
      await api(`/feed/comments/${id}`, { method: 'DELETE' });
      const next = comments.filter((c) => c.id !== id);
      setComments(next);
      onCountChange(next.length);
    } catch (err) {
      showToast('Não foi possível apagar', err.message, 'warning');
    }
  };

  return (
    <div className="feed-comments">
      {comments === null && <p className="feed-muted">Carregando comentários...</p>}
      {comments && comments.length === 0 && <p className="feed-muted">Seja o primeiro cidadão a se manifestar.</p>}
      {comments && comments.map((c) => (
        <div key={c.id} className="feed-comment">
          <span className="feed-comment-author">@{c.username}</span>
          <span className="feed-comment-body">{c.body}</span>
          <span className="feed-comment-meta">
            {formatRelative(c.created_at)}
            {(c.mine || isAdmin) && (
              <button type="button" className="feed-link-btn" onClick={() => remove(c.id)}>apagar</button>
            )}
          </span>
        </div>
      ))}
      <form className="feed-comment-form" onSubmit={send}>
        <input
          type="text"
          maxLength={500}
          placeholder="Escreva um comentário..."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="feed-send-btn" disabled={!text.trim() || sending}>
          {sending ? '...' : 'Publicar'}
        </button>
      </form>
    </div>
  );
}

function PostCard({ post, api, showToast, isAdmin, onChange, onRemove }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const emblem = MINISTRY_EMBLEMS[post.ministry_code];
  const long = post.body.length > 420;

  const support = async () => {
    if (busy) return;
    setBusy(true);
    // Atualiza na hora e confirma com o servidor
    onChange({ ...post, supported_by_me: !post.supported_by_me, support_count: post.support_count + (post.supported_by_me ? -1 : 1) });
    try {
      const data = await api(`/feed/${post.id}/support`, { method: 'POST' });
      onChange({ ...post, ...data });
    } catch (err) {
      onChange(post);
      showToast('Apoio não registrado', err.message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  const pin = async () => {
    setMenu(false);
    try {
      await api(`/admin/feed/${post.id}/pin`, { method: 'POST', body: { pinned: !post.pinned } });
      onChange({ ...post, pinned: !post.pinned });
      showToast('Diário Oficial', post.pinned ? 'Publicação desafixada.' : 'Publicação fixada no topo.', 'success');
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    }
  };

  const remove = async () => {
    setMenu(false);
    if (!window.confirm('Apagar esta publicação do Diário Oficial?')) return;
    try {
      await api(`/admin/feed/${post.id}`, { method: 'DELETE' });
      onRemove(post.id);
      showToast('Diário Oficial', 'Publicação apagada.', 'success');
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    }
  };

  return (
    <article className={`feed-card ${post.pinned ? 'pinned' : ''}`}>
      <header className="feed-card-head">
        <img className="feed-emblem" src={emblem} alt="" />
        <div className="feed-author">
          <span className="feed-ministry">{post.ministry_name}</span>
          <span className="feed-byline">
            {post.author} · <span className="feed-auto-tag" title="Publicação gerada pelo assistente automatizado do ministério">assistente automatizado</span> · {formatRelative(post.published_at)}
          </span>
        </div>
        {isAdmin && (
          <div className="feed-menu-wrap">
            <button type="button" className="feed-menu-btn" aria-label="Opções" onClick={() => setMenu((m) => !m)}><Icon name="more" size={20} /></button>
            {menu && (
              <div className="feed-menu">
                <button type="button" onClick={pin}>{post.pinned ? 'Desafixar' : 'Fixar no topo'}</button>
                <button type="button" className="danger" onClick={remove}>Apagar</button>
              </div>
            )}
          </div>
        )}
      </header>

      {(post.pinned || post.kind === 'suggestion') && (
        <div className="feed-tags">
          {post.pinned && <span className="feed-tag gold">Fixado</span>}
          {post.kind === 'suggestion' && <span className="feed-tag green">Proposta aprovada pelo Alto Comando</span>}
        </div>
      )}

      <h3 className="feed-title">{post.title}</h3>
      <p className={`feed-body ${long && !expanded ? 'clamped' : ''}`}>{post.body}</p>
      {long && (
        <button type="button" className="feed-link-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'mostrar menos' : 'ler mais'}
        </button>
      )}

      <footer className="feed-actions">
        <button type="button" className={`feed-action ${post.supported_by_me ? 'active' : ''}`} onClick={support} aria-pressed={post.supported_by_me}>
          <span className="feed-action-icon"><Icon name="star" size={18} fill={post.supported_by_me ? 'currentColor' : 'none'} /></span>
          {post.supported_by_me ? 'Apoiado' : 'Apoiar'}
          <span className="feed-count">{post.support_count}</span>
        </button>
        <button type="button" className={`feed-action ${open ? 'active' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="feed-action-icon"><Icon name="comment" size={18} /></span>
          Comentar
          <span className="feed-count">{post.comment_count}</span>
        </button>
      </footer>

      {open && (
        <Comments
          post={post}
          api={api}
          showToast={showToast}
          isAdmin={isAdmin}
          onCountChange={(n) => onChange({ ...post, comment_count: n })}
        />
      )}
    </article>
  );
}

export default function DiarioOficial({ api, showToast, isAdmin }) {
  const [posts, setPosts] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [ministries, setMinistries] = useState([]);
  const [filter, setFilter] = useState('');
  const sentinel = useRef(null);
  const loadingRef = useRef(false);

  const reqRef = useRef(0);

  const load = useCallback(async (reset) => {
    // Recarregar do zero (filtro novo) passa na frente de uma página que ainda está chegando
    if (!reset && loadingRef.current) return;
    const id = ++reqRef.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (filter) params.set('ministry', filter);
      if (!reset && nextBefore) params.set('before', nextBefore);
      const data = await api(`/feed?${params.toString()}`);
      if (id !== reqRef.current) return;
      setPosts((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.map((p) => p.id));
        return [...base, ...data.posts.filter((p) => !seen.has(p.id))];
      });
      setNextBefore(data.next_before);
      setDone(!data.next_before);
    } catch (err) {
      if (id === reqRef.current) setError(err.message);
    } finally {
      if (id === reqRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [api, filter, nextBefore]);

  useEffect(() => {
    api('/ministries').then(setMinistries).catch(() => {});
  }, []);

  useEffect(() => {
    setPosts([]);
    setNextBefore(null);
    setDone(false);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Rolagem infinita: carrega a próxima página quando o fim da lista aparece na tela
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && posts.length > 0) load(false);
    }, { rootMargin: '600px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [load, done, error, posts.length]);

  const update = (p) => setPosts((prev) => prev.map((x) => (x.id === p.id ? p : x)));
  const removePost = (id) => setPosts((prev) => prev.filter((x) => x.id !== id));

  return (
    <section className="tab-pane active diario-pane">
      <div className="diario-head">
        <div>
          <h2 className="section-title">DIÁRIO OFICIAL</h2>
          <p className="section-subtitle">Comunicados dos ministérios da Democracia Gerenciada. Apoie e comente para somar participação cívica.</p>
        </div>
        <div className="diario-tools">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar por ministério">
            <option value="">Todos os ministérios</option>
            {ministries.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
          </select>
          <button type="button" className="feed-refresh" onClick={() => load(true)} disabled={loading} aria-label="Atualizar"><Icon name="refresh" size={18} className={loading ? 'ilc-spin-slow' : ''} /></button>
        </div>
      </div>

      <div className="feed-list">
        {posts.map((p) => (
          <PostCard key={p.id} post={p} api={api} showToast={showToast} isAdmin={isAdmin} onChange={update} onRemove={removePost} />
        ))}

        {!loading && !error && posts.length === 0 && (
          <div className="feed-empty">
            <p>Nenhuma publicação ainda.</p>
            <p className="feed-muted">Os assistentes dos ministérios publicam ao longo do dia, entre 7h e 22h.</p>
          </div>
        )}

        {error && (
          <div className="feed-empty">
            <p>{error}</p>
            <button type="button" className="state-btn outline" onClick={() => load(posts.length === 0)}>Tentar novamente</button>
          </div>
        )}

        {loading && (
          <div className="feed-skeleton" aria-hidden="true">
            <div className="sk-line w40" /><div className="sk-line w90" /><div className="sk-line w75" />
          </div>
        )}

        {done && posts.length > 0 && <p className="feed-end">Fim do Diário Oficial.</p>}
        <div ref={sentinel} className="feed-sentinel" />
      </div>
    </section>
  );
}
