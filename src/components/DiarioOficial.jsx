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

function PostCard({ post, api, showToast, isAdmin, onChange, onRemove, apiOrigin }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const isCitizen = post.author_type === 'citizen';
  const emblem = MINISTRY_EMBLEMS[post.ministry_code];
  const long = post.body.length > 420;
  const canDelete = isAdmin || post.mine;
  const [avatarFailed, setAvatarFailed] = useState(false);

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
      await api(`/feed/${post.id}`, { method: 'DELETE' });
      onRemove(post.id);
      showToast('Diário Oficial', 'Publicação apagada.', 'success');
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    }
  };

  return (
    <article className={`feed-card ${post.pinned ? 'pinned' : ''}`}>
      <header className="feed-card-head">
        {isCitizen ? (
          post.author_avatar && !avatarFailed ? (
            <img className="feed-emblem citizen" src={post.author_avatar} alt="" onError={() => setAvatarFailed(true)} />
          ) : (
            <span className="feed-emblem citizen feed-initial" aria-hidden="true">{post.author.charAt(0).toUpperCase()}</span>
          )
        ) : (
          <img className="feed-emblem" src={emblem} alt="" />
        )}
        <div className="feed-author">
          {isCitizen ? (
            <>
              <span className="feed-ministry citizen">@{post.author}</span>
              <span className="feed-byline">
                {post.author_title ? `${post.author_title} · ` : ''}{formatRelative(post.published_at)}
              </span>
            </>
          ) : (
            <>
              <span className="feed-ministry">{post.ministry_name}</span>
              <span className="feed-byline">
                {post.author} · <span className="feed-auto-tag" title="Publicação gerada pelo assistente automatizado do ministério">assistente automatizado</span> · {formatRelative(post.published_at)}
              </span>
            </>
          )}
        </div>
        {canDelete && (
          <div className="feed-menu-wrap">
            <button type="button" className="feed-menu-btn" aria-label="Opções" onClick={() => setMenu((m) => !m)}><Icon name="more" size={20} /></button>
            {menu && (
              <div className="feed-menu">
                {isAdmin && <button type="button" onClick={pin}>{post.pinned ? 'Desafixar' : 'Fixar no topo'}</button>}
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

      {post.image_url && (
        <div className="feed-photo">
          <img src={`${apiOrigin}${post.image_url}`} alt={isCitizen ? `Foto publicada por @${post.author}` : ''} loading="lazy" />
        </div>
      )}
      {post.title && <h3 className="feed-title">{post.title}</h3>}
      {post.body && <p className={`feed-body ${long && !expanded ? 'clamped' : ''}`}>{post.body}</p>}
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


// Reduz a foto no aparelho antes de enviar: lado maior até 1280px, JPEG 0,78 (uma foto de
// celular de 4 MB costuma virar 150 a 300 KB). Fica no volume de dados do servidor.
const PHOTO_MAX_SIDE = 1280;
const PHOTO_QUALITY = 0.78;
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
      reject(new Error('Escolha uma foto (JPG, PNG ou WEBP).'));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = PHOTO_MAX_SIDE;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      // Fundo escuro para PNG transparente não virar preto/branco aleatório no JPEG
      ctx.fillStyle = '#0B1629';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não foi possível ler esta foto.')); };
    img.src = url;
  });
}

function Composer({ api, showToast, me, onPosted }) {
  const [text, setText] = useState('');
  const [image, setImage] = useState(null);
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      setImage(await shrinkImage(file));
    } catch (err) {
      showToast('Foto', err.message, 'warning');
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (sending || (!text.trim() && !image)) return;
    setSending(true);
    try {
      const data = await api('/feed', { method: 'POST', body: { body: text.trim(), ...(image ? { image } : {}) } });
      setText('');
      setImage(null);
      setFocused(false);
      onPosted(data.post);
      showToast('Publicado', 'Sua publicação está no Diário Oficial.', 'success');
    } catch (err) {
      showToast('Não foi possível publicar', err.message, 'warning');
    } finally {
      setSending(false);
    }
  };

  const expanded = focused || text || image;

  return (
    <form className={`feed-composer ${expanded ? 'open' : ''}`} onSubmit={submit}>
      <div className="feed-composer-row">
        {me.avatar && !avatarFailed ? (
          <img className="feed-emblem citizen" src={me.avatar} alt="" onError={() => setAvatarFailed(true)} />
        ) : (
          <span className="feed-emblem citizen feed-initial" aria-hidden="true">{(me.username || 'U').charAt(0).toUpperCase()}</span>
        )}
        <textarea
          rows={expanded ? 3 : 1}
          maxLength={2200}
          placeholder="Escreva uma publicação..."
          value={text}
          onFocus={() => setFocused(true)}
          onChange={(e) => setText(e.target.value)}
          aria-label="Escrever publicação"
        />
      </div>
      {image && (
        <div className="feed-composer-preview">
          <img src={image} alt="Prévia da foto" />
          <button type="button" className="feed-composer-remove" onClick={() => setImage(null)} aria-label="Remover foto">
            <Icon name="x" size={20} />
          </button>
        </div>
      )}
      {expanded && (
        <div className="feed-composer-actions">
          {/* capture abre a câmera direto; sem capture abre a galeria */}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
          <input ref={galleryRef} type="file" accept="image/*" hidden onChange={pick} />
          <button type="button" className="feed-composer-photo" onClick={() => cameraRef.current && cameraRef.current.click()}>
            <Icon name="camera" size={18} /> Câmera
          </button>
          <button type="button" className="feed-composer-photo" onClick={() => galleryRef.current && galleryRef.current.click()}>
            <Icon name="image" size={18} /> Galeria
          </button>
          <span className="feed-composer-count">{text.length > 1800 ? `${text.length}/2200` : ''}</span>
          <button type="submit" className="state-btn primary feed-composer-send" disabled={sending || (!text.trim() && !image)}>
            {sending ? 'Publicando...' : 'Publicar'}
          </button>
        </div>
      )}
    </form>
  );
}

export default function DiarioOficial({ api, showToast, isAdmin, me = {}, apiOrigin = '' }) {
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
          <p className="section-subtitle">Comunicados dos ministérios e publicações dos cidadãos. Publique, apoie e comente.</p>
        </div>
        <div className="diario-tools">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar por ministério">
            <option value="">Tudo</option>
            <option value="cidadaos">Publicações dos cidadãos</option>
            {ministries.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
          </select>
          <button type="button" className="feed-refresh" onClick={() => load(true)} disabled={loading} aria-label="Atualizar"><Icon name="refresh" size={18} className={loading ? 'ilc-spin-slow' : ''} /></button>
        </div>
      </div>

      <div className="feed-list">
        <Composer
          api={api}
          showToast={showToast}
          me={me}
          onPosted={(p) => {
            if (filter && filter !== 'cidadaos') return;
            setPosts((prev) => {
              const firstUnpinned = prev.findIndex((x) => !x.pinned);
              const at = firstUnpinned === -1 ? prev.length : firstUnpinned;
              return [...prev.slice(0, at), p, ...prev.slice(at)];
            });
          }}
        />
        {posts.map((p) => (
          <PostCard key={p.id} post={p} api={api} showToast={showToast} isAdmin={isAdmin} onChange={update} onRemove={removePost} apiOrigin={apiOrigin} />
        ))}

        {!loading && !error && posts.length === 0 && (
          <div className="feed-empty">
            <p>Nenhuma publicação ainda.</p>
            <p className="feed-muted">Seja o primeiro a publicar. Os assistentes dos ministérios também publicam ao longo do dia, entre 7h e 22h.</p>
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
