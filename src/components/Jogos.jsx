import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { MINISTRY_EMBLEMS, BANCO_CENTRAL_EMBLEM, INTELIGENCIA_EMBLEM } from './ministerios';

// ==========================================
// JOGOS: missões do dia, Quiz da Constituição (offline), Despacho de processos e Memória dos emblemas
// ==========================================
// O quiz e a memória funcionam sem internet: o banco de perguntas e as respostas/partidas ficam no
// aparelho e sincronizam quando a conexão volta. O despacho precisa de internet (o tempo é do servidor).

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* armazenamento cheio ou bloqueado */ }
  },
};

const newId = () => {
  try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (_) { /* contexto sem crypto */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isNetworkError = (err) => /conex|comunica|Tempo limite|Failed to fetch|NetworkError/i.test(String(err && err.message));

const ACTION_INFO = {
  apoiar: { icon: 'star', go: 'diario', verb: 'Abrir o Diário' },
  comentar: { icon: 'comment', go: 'diario', verb: 'Abrir o Diário' },
  publicar: { icon: 'pencil', go: 'diario', verb: 'Publicar' },
  quiz: { icon: 'book', go: 'quiz', verb: 'Jogar o quiz' },
  despacho: { icon: 'gavel', go: 'despacho', verb: 'Despachar' },
  memoria: { icon: 'brain', go: 'memoria', verb: 'Jogar a memória' },
};

const keys = (user) => ({
  bank: `ilc_quiz_bank_${user}`,
  quizPending: `ilc_quiz_pending_${user}`,
  memPending: `ilc_memoria_pending_${user}`,
  memBest: `ilc_memoria_best_${user}`,
  hub: `ilc_jogos_hub_${user}`,
});

// Envia o que foi jogado offline. Devolve os pontos ganhos.
async function syncPending(api, k) {
  let points = 0;
  const quiz = store.get(k.quizPending, []);
  if (quiz.length) {
    const r = await api('/games/quiz/sync', { method: 'POST', body: { answers: quiz } });
    const sent = new Set(quiz.map((a) => a.client_id));
    store.set(k.quizPending, store.get(k.quizPending, []).filter((a) => !sent.has(a.client_id)));
    points += r.points || 0;
  }
  const mem = store.get(k.memPending, []);
  if (mem.length) {
    const r = await api('/games/memoria/sync', { method: 'POST', body: { games: mem } });
    const sent = new Set(mem.map((g) => g.client_id));
    store.set(k.memPending, store.get(k.memPending, []).filter((g) => !sent.has(g.client_id)));
    points += r.points || 0;
  }
  return points;
}

// ------------------------------------------
// Missões do dia
// ------------------------------------------
function Missions({ missions, onClaim, onGo, claiming }) {
  if (!missions.length) {
    return (
      <div className="game-empty">
        <Icon name="hourglass" size={20} />
        <span>Os ministérios ainda estão preparando as missões de hoje. Volte mais tarde.</span>
      </div>
    );
  }
  return (
    <div className="mission-list">
      {missions.map((m) => {
        const info = ACTION_INFO[m.action] || ACTION_INFO.apoiar;
        const pct = Math.round((m.progress / m.target) * 100);
        const emblem = MINISTRY_EMBLEMS[m.ministry_code];
        return (
          <div key={m.id} className={`mission ${m.claimed ? 'claimed' : m.done ? 'done' : ''}`}>
            <div className="mission-top">
              {emblem ? <img src={emblem} alt="" className="mission-emblem" /> : <span className="mission-icon"><Icon name={info.icon} size={18} /></span>}
              <div className="mission-text">
                <strong>{m.title}</strong>
                {m.description && <p>{m.description}</p>}
              </div>
              <span className="mission-points">+{m.points}</span>
            </div>
            <div className="mission-bar" aria-label={`${m.progress} de ${m.target}`}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="mission-foot">
              <span className="mission-count">{m.progress}/{m.target}</span>
              {m.claimed ? (
                <span className="mission-claimed"><Icon name="check" size={15} /> Resgatada</span>
              ) : m.done ? (
                <button type="button" className="state-btn primary ctl-btn" disabled={claiming === m.id} onClick={() => onClaim(m)}>
                  <Icon name="trophy" size={15} /> {claiming === m.id ? 'Resgatando...' : 'Resgatar'}
                </button>
              ) : (
                <button type="button" className="state-btn outline ctl-btn" onClick={() => onGo(info.go)}>{info.verb}</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------
// Quiz da Constituição (offline)
// ------------------------------------------
const ROUND_SIZE = 5;

function QuizGame({ api, k, online, onExit, onSynced }) {
  const [bank, setBank] = useState(() => store.get(k.bank, null));
  const [loading, setLoading] = useState(!store.get(k.bank, null));
  const [round, setRound] = useState(null);
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState(null);
  const [score, setScore] = useState(0);

  // Atualiza o banco quando há internet; sem internet usa o que está guardado
  useEffect(() => {
    let alive = true;
    if (!online) { setLoading(false); return undefined; }
    api('/games/quiz/bank')
      .then((data) => {
        if (!alive) return;
        store.set(k.bank, data);
        setBank(data);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [api, k.bank, online]);

  const start = useCallback(() => {
    if (!bank || !bank.questions.length) return;
    const done = new Set(bank.answered_ids || []);
    store.get(k.quizPending, []).forEach((a) => { if (a.correct) done.add(a.question_id); });
    const fresh = shuffle(bank.questions.filter((q) => !done.has(q.id)));
    const seen = shuffle(bank.questions.filter((q) => done.has(q.id)));
    setRound([...fresh, ...seen].slice(0, ROUND_SIZE));
    setIndex(0);
    setChosen(null);
    setScore(0);
  }, [bank, k.quizPending]);

  const answer = (i) => {
    if (chosen !== null) return;
    const q = round[index];
    const correct = i === q.correct_index;
    setChosen(i);
    if (correct) setScore((s) => s + 1);
    // Guarda no aparelho; vai para o servidor ao sincronizar
    store.set(k.quizPending, [
      ...store.get(k.quizPending, []),
      { client_id: newId(), question_id: q.id, chosen: i, correct, answered_at: new Date().toISOString() },
    ]);
  };

  const next = () => {
    if (index + 1 < round.length) {
      setIndex(index + 1);
      setChosen(null);
    } else {
      setIndex(round.length);
      if (online) onSynced();
    }
  };

  const total = bank ? bank.questions.length : 0;

  return (
    <div className="game-panel">
      <div className="game-panel-head">
        <button type="button" className="game-back" onClick={onExit}><Icon name="back" size={18} /> Jogos</button>
        <h3><Icon name="book" size={18} /> Quiz da Constituição</h3>
      </div>

      {loading && <p className="game-muted">Carregando perguntas...</p>}

      {!loading && !total && (
        <div className="game-empty">
          <Icon name={online ? 'hourglass' : 'offline'} size={20} />
          <span>{online
            ? 'O Ministério da Educação ainda não publicou perguntas aprovadas. Volte mais tarde.'
            : 'Abra o quiz uma vez com internet para baixar as perguntas. Depois ele funciona offline.'}</span>
        </div>
      )}

      {!loading && total > 0 && !round && (
        <div className="game-intro">
          <p>Responda {ROUND_SIZE} perguntas sobre a Constituição Cívica do Estado. Cada acerto inédito vale +{bank.points_each} pontos, até {bank.cap} acertos por dia.</p>
          <p className="game-muted">{total} perguntas no banco{online ? '' : ' (modo offline: as respostas sincronizam quando a internet voltar)'}.</p>
          <button type="button" className="state-btn primary" onClick={start}>Começar</button>
        </div>
      )}

      {round && index < round.length && (() => {
        const q = round[index];
        return (
          <div className="quiz-card" key={q.id}>
            <div className="quiz-progress">
              {round.map((_, i) => <span key={i} className={i < index ? 'past' : i === index ? 'now' : ''} />)}
            </div>
            <p className="quiz-question">{q.question}</p>
            <div className="quiz-options">
              {q.options.map((opt, i) => {
                let cls = '';
                if (chosen !== null) {
                  if (i === q.correct_index) cls = 'right';
                  else if (i === chosen) cls = 'wrong';
                  else cls = 'dim';
                }
                return (
                  <button type="button" key={i} className={`quiz-option ${cls}`} onClick={() => answer(i)} disabled={chosen !== null}>
                    <span className="quiz-letter">{'ABCD'[i]}</span>
                    <span>{opt}</span>
                  </button>
                );
              })}
            </div>
            {chosen !== null && (
              <div className={`quiz-feedback ${chosen === q.correct_index ? 'right' : 'wrong'}`}>
                <strong>{chosen === q.correct_index ? 'Correto!' : 'Resposta errada.'}</strong>
                {q.explanation && <span>{q.explanation}</span>}
                <button type="button" className="state-btn primary ctl-btn" onClick={next}>
                  {index + 1 < round.length ? 'Próxima' : 'Ver resultado'}
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {round && index >= round.length && (
        <div className="game-result">
          <Icon name="trophy" size={34} />
          <strong>{score} de {round.length} acertos</strong>
          <p className="game-muted">{online ? 'Respostas enviadas. Os pontos aparecem na sua carteira.' : 'Respostas guardadas no aparelho. Os pontos entram quando a internet voltar.'}</p>
          <div className="ctl-row">
            <button type="button" className="state-btn primary ctl-btn" onClick={start}>Jogar de novo</button>
            <button type="button" className="state-btn outline ctl-btn" onClick={onExit}>Voltar</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------
// Despacho de processos (online, com tempo)
// ------------------------------------------
function DespachoGame({ api, showToast, online, onExit, onPlayed }) {
  const [state, setState] = useState({ phase: 'loading' });
  const [remaining, setRemaining] = useState(0);
  const deadline = useRef(0);
  const sending = useRef(false);

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    sending.current = false;
    try {
      const data = await api('/games/despacho/next', { method: 'POST' });
      if (data.finished) { setState({ phase: 'finished', reason: data.reason }); return; }
      deadline.current = Date.now() + data.remaining * 1000;
      setRemaining(data.remaining);
      setState({ phase: 'case', data });
    } catch (err) {
      setState({ phase: 'error', message: err.message });
    }
  }, [api]);

  useEffect(() => { if (online) load(); else setState({ phase: 'offline' }); }, [online, load]);

  const decide = useCallback(async (decision) => {
    if (sending.current || state.phase !== 'case') return;
    sending.current = true;
    try {
      const r = await api(`/games/despacho/${state.data.play_id}/decide`, { method: 'POST', body: { decision } });
      setState({ phase: 'result', data: state.data, result: r, decision });
      if (r.reward && r.reward.points) showToast('Despacho correto', `+${r.reward.points} pontos na sua carteira.`, 'success');
      onPlayed();
    } catch (err) {
      sending.current = false;
      showToast('Não deu para despachar', err.message, 'warning');
    }
  }, [api, state, showToast, onPlayed]);

  // Relógio: ao zerar, o processo é arquivado
  useEffect(() => {
    if (state.phase !== 'case') return undefined;
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) { clearInterval(t); decide('timeout'); }
    }, 250);
    return () => clearInterval(t);
  }, [state.phase, decide]);

  const c = state.data && state.data.case;
  const emblem = c && MINISTRY_EMBLEMS[c.ministry_code];

  return (
    <div className="game-panel">
      <div className="game-panel-head">
        <button type="button" className="game-back" onClick={onExit}><Icon name="back" size={18} /> Jogos</button>
        <h3><Icon name="gavel" size={18} /> Despacho de processos</h3>
      </div>

      {state.phase === 'loading' && <p className="game-muted">Buscando o próximo processo...</p>}
      {state.phase === 'offline' && (
        <div className="game-empty"><Icon name="offline" size={20} /><span>O despacho precisa de internet, porque o prazo é contado pelo servidor.</span></div>
      )}
      {state.phase === 'error' && (
        <div className="game-empty"><Icon name="alert" size={20} /><span>{state.message}</span>
          <button type="button" className="state-btn outline ctl-btn" onClick={load}>Tentar de novo</button></div>
      )}
      {state.phase === 'finished' && (
        <div className="game-empty">
          <Icon name={state.reason === 'limit' ? 'check' : 'hourglass'} size={20} />
          <span>{state.reason === 'limit'
            ? 'Você despachou todos os processos de hoje. A mesa reabre amanhã.'
            : 'Não há processos novos na sua mesa. Defesa e Verdade estão preparando mais.'}</span>
        </div>
      )}

      {(state.phase === 'case' || state.phase === 'result') && c && (
        <div className={`case-card ${state.phase === 'result' ? 'decided' : ''}`}>
          <div className="case-head">
            {emblem && <img src={emblem} alt="" className="mission-emblem" />}
            <div className="case-meta">
              <span>{c.ministry_name}</span>
              <small>Processo enviado por {c.author || 'assistente do ministério'}</small>
            </div>
            {state.phase === 'case' && (
              <span className={`case-timer ${remaining <= 10 ? 'urgent' : ''}`}><Icon name="timer" size={15} /> {remaining}s</span>
            )}
          </div>
          {state.phase === 'case' && (
            <div className="case-clock"><span style={{ width: `${(remaining / state.data.seconds) * 100}%` }} /></div>
          )}
          <h4>{c.title}</h4>
          <p className="case-summary">{c.summary}</p>

          {state.phase === 'case' && (
            <div className="case-actions">
              <button type="button" className="case-btn deny" onClick={() => decide('indeferir')}><Icon name="ban" size={18} /> Indeferir</button>
              <button type="button" className="case-btn approve" onClick={() => decide('deferir')}><Icon name="check" size={18} /> Deferir</button>
            </div>
          )}

          {state.phase === 'result' && (
            <div className={`quiz-feedback ${state.result.correct ? 'right' : 'wrong'}`}>
              <strong>
                {state.result.late
                  ? 'Prazo vencido: o processo foi arquivado.'
                  : state.result.correct ? `Despacho correto! +${state.result.points} pontos` : 'Despacho contrário à doutrina do Estado.'}
              </strong>
              <span>Decisão oficial: <b>{state.result.correct_decision === 'deferir' ? 'Deferido' : 'Indeferido'}</b>{state.result.rationale ? `. ${state.result.rationale}` : ''}</span>
              <button type="button" className="state-btn primary ctl-btn" onClick={load}>Próximo processo</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------
// Memória dos emblemas (100% offline)
// ------------------------------------------
const MEMORY_CARDS = [
  { id: 'verdade', name: 'Verdade', img: MINISTRY_EMBLEMS.verdade },
  { id: 'prosperidade', name: 'Prosperidade', img: MINISTRY_EMBLEMS.prosperidade },
  { id: 'defesa', name: 'Defesa', img: MINISTRY_EMBLEMS.defesa },
  { id: 'educacao', name: 'Educação', img: MINISTRY_EMBLEMS.educacao },
  { id: 'saude', name: 'Saúde', img: MINISTRY_EMBLEMS.saude },
  { id: 'ciencia', name: 'Ciência e Tecnologia', img: MINISTRY_EMBLEMS.ciencia },
  { id: 'bcd', name: 'Banco Central Democrata', img: BANCO_CENTRAL_EMBLEM },
  { id: 'sie', name: 'Serviço de Inteligência', img: INTELIGENCIA_EMBLEM },
];

const newDeck = () => shuffle([...MEMORY_CARDS, ...MEMORY_CARDS].map((c, i) => ({ ...c, key: `${c.id}-${i}` })));

function MemoriaGame({ k, online, onExit, onFinished }) {
  const [deck, setDeck] = useState(newDeck);
  const [open, setOpen] = useState([]);
  const [matched, setMatched] = useState(() => new Set());
  const [moves, setMoves] = useState(0);
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [result, setResult] = useState(null);
  const [lastMatch, setLastMatch] = useState(null);
  const best = store.get(k.memBest, null);

  useEffect(() => {
    if (!startedAt || result) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [startedAt, result]);

  const restart = () => {
    setDeck(newDeck());
    setOpen([]);
    setMatched(new Set());
    setMoves(0);
    setStartedAt(null);
    setResult(null);
    setLastMatch(null);
  };

  const flip = (i) => {
    if (result || open.length === 2 || open.includes(i) || matched.has(deck[i].id)) return;
    if (!startedAt) setStartedAt(Date.now());
    const next = [...open, i];
    setOpen(next);
    if (next.length < 2) return;
    setMoves((m) => m + 1);
    const [a, b] = next;
    if (deck[a].id === deck[b].id) {
      const done = new Set(matched);
      done.add(deck[a].id);
      setTimeout(() => {
        setMatched(done);
        setOpen([]);
        setLastMatch(deck[a].name);
        if (done.size === MEMORY_CARDS.length) {
          const seconds = Math.max(3, Math.round((Date.now() - (startedAt || Date.now())) / 1000));
          const totalMoves = moves + 1;
          const game = { client_id: newId(), pairs: MEMORY_CARDS.length, moves: totalMoves, seconds, played_at: new Date().toISOString() };
          store.set(k.memPending, [...store.get(k.memPending, []), game]);
          const prev = store.get(k.memBest, null);
          const isBest = !prev || totalMoves < prev.moves || (totalMoves === prev.moves && seconds < prev.seconds);
          if (isBest) store.set(k.memBest, { moves: totalMoves, seconds });
          setResult({ moves: totalMoves, seconds, isBest });
          onFinished();
        }
      }, 450);
    } else {
      setTimeout(() => setOpen([]), 850);
    }
  };

  const elapsed = startedAt ? Math.round(((result ? startedAt + result.seconds * 1000 : now) - startedAt) / 1000) : 0;
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const stars = result ? (result.moves <= 12 ? 3 : result.moves <= 18 ? 2 : 1) : 0;

  return (
    <div className="game-panel">
      <div className="game-panel-head">
        <button type="button" className="game-back" onClick={onExit}><Icon name="back" size={18} /> Jogos</button>
        <h3><Icon name="brain" size={18} /> Memória dos emblemas</h3>
      </div>

      <div className="memory-stats">
        <span><Icon name="target" size={15} /> {moves} jogadas</span>
        <span><Icon name="timer" size={15} /> {mmss(elapsed)}</span>
        <span><Icon name="trophy" size={15} /> {best ? `${best.moves} jogadas` : 'sem recorde'}</span>
      </div>

      <div className="memory-grid">
        {deck.map((card, i) => {
          const up = open.includes(i) || matched.has(card.id);
          return (
            <button
              type="button"
              key={card.key}
              className={`memory-card ${up ? 'up' : ''} ${matched.has(card.id) ? 'matched' : ''}`}
              onClick={() => flip(i)}
              aria-label={up ? card.name : 'Carta virada'}
            >
              <span className="memory-inner">
                <span className="memory-face memory-back"><Icon name="landmark" size={22} /></span>
                <span className="memory-face memory-front"><img src={card.img} alt="" draggable="false" /></span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="memory-hint">{lastMatch ? `Par encontrado: ${lastMatch}` : 'Encontre os pares dos emblemas do Estado. Funciona sem internet.'}</p>

      {result && (
        <div className="game-result">
          <div className="memory-stars">{[1, 2, 3].map((n) => <Icon key={n} name="star" size={26} className={n <= stars ? 'on' : ''} />)}</div>
          <strong>{result.moves} jogadas em {mmss(result.seconds)}</strong>
          {result.isBest && <span className="memory-best">Novo recorde!</span>}
          <p className="game-muted">{online ? 'Partida enviada. As 3 primeiras do dia valem pontos.' : 'Partida guardada no aparelho. Os pontos entram quando a internet voltar.'}</p>
          <div className="ctl-row">
            <button type="button" className="state-btn primary ctl-btn" onClick={restart}>Jogar de novo</button>
            <button type="button" className="state-btn outline ctl-btn" onClick={onExit}>Voltar</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------
// Tela principal
// ------------------------------------------
export default function Jogos({ api, showToast, username, onNavigate }) {
  const k = useMemo(() => keys(username || 'anon'), [username]);
  const [hub, setHub] = useState(() => store.get(k.hub, null));
  const [view, setView] = useState('hub');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  const [claiming, setClaiming] = useState(null);
  const [pending, setPending] = useState(0);

  const countPending = useCallback(() => {
    setPending(store.get(k.quizPending, []).length + store.get(k.memPending, []).length);
  }, [k]);

  const refresh = useCallback(async () => {
    countPending();
    try {
      const gained = await syncPending(api, k);
      if (gained > 0) showToast('Jogos sincronizados', `+${gained} pontos do que você jogou.`, 'success');
      const data = await api('/games');
      store.set(k.hub, data);
      setHub(data);
      setOnline(true);
    } catch (err) {
      if (isNetworkError(err)) setOnline(false);
    } finally {
      countPending();
    }
  }, [api, k, showToast, countPending]);

  useEffect(() => { refresh(); }, [refresh]);

  // Deixa os emblemas da memória em cache já na primeira visita (no APK eles vêm do próprio app)
  useEffect(() => { MEMORY_CARDS.forEach((c) => { const img = new Image(); img.src = c.img; }); }, []);

  useEffect(() => {
    const on = () => { setOnline(true); refresh(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [refresh]);

  const claim = async (m) => {
    setClaiming(m.id);
    try {
      const r = await api(`/games/missions/${m.id}/claim`, { method: 'POST' });
      showToast('Missão cumprida', r.reward ? `+${r.reward.points} pontos na sua carteira.` : 'Missão registrada.', 'success');
      refresh();
    } catch (err) {
      showToast('Não deu para resgatar', err.message, 'warning');
    } finally {
      setClaiming(null);
    }
  };

  const go = (target) => {
    if (target === 'diario') onNavigate('diario');
    else setView(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const exit = () => { setView('hub'); refresh(); };

  if (view === 'quiz') return <section className="tab-pane active jogos-pane"><QuizGame api={api} k={k} online={online} onExit={exit} onSynced={refresh} /></section>;
  if (view === 'despacho') return <section className="tab-pane active jogos-pane"><DespachoGame api={api} showToast={showToast} online={online} onExit={exit} onPlayed={() => {}} /></section>;
  if (view === 'memoria') return <section className="tab-pane active jogos-pane"><MemoriaGame k={k} online={online} onExit={exit} onFinished={() => { if (online) refresh(); else countPending(); }} /></section>;

  const q = hub && hub.quiz;
  const d = hub && hub.despacho;
  const mem = hub && hub.memoria;
  const missionsLeft = hub ? hub.missions.filter((m) => !m.claimed).length : 0;

  return (
    <section className="tab-pane active jogos-pane">
      <div className="diario-head">
        <div>
          <h2 className="section-title">JOGOS DO ESTADO</h2>
          <p className="section-subtitle">Cumpra as missões do dia, prove que conhece a Constituição e ajude os ministérios. Tudo vale pontos na carteira.</p>
        </div>
      </div>

      {(!online || pending > 0) && (
        <div className={`game-sync ${online ? '' : 'off'}`}>
          <Icon name={online ? 'refresh' : 'offline'} size={16} />
          <span>{online
            ? `${pending} jogada(s) esperando envio.`
            : `Sem internet. Quiz e memória funcionam offline${pending ? `; ${pending} jogada(s) serão enviadas quando a conexão voltar` : ''}.`}</span>
          {online && <button type="button" onClick={refresh}>Enviar</button>}
        </div>
      )}

      <div className="bento-card game-block">
        <div className="game-block-head">
          <h3><Icon name="target" size={18} /> Missões de hoje</h3>
          {hub && hub.missions.length > 0 && <span className="game-chip">{missionsLeft ? `${missionsLeft} para resgatar` : 'todas resgatadas'}</span>}
        </div>
        {hub ? <Missions missions={hub.missions} onClaim={claim} onGo={go} claiming={claiming} /> : <p className="game-muted">{online ? 'Carregando...' : 'Conecte-se para ver as missões de hoje.'}</p>}
      </div>

      <div className="game-cards">
        <button type="button" className="game-card" onClick={() => go('quiz')}>
          <span className="game-card-icon"><Icon name="book" size={24} /></span>
          <span className="game-card-text">
            <strong>Quiz da Constituição</strong>
            <small>Perguntas do Ministério da Educação. Funciona offline.</small>
            {q && <em>{q.rewarded}/{q.cap} acertos com pontos hoje · +{q.points_each} cada</em>}
          </span>
        </button>
        <button type="button" className="game-card" onClick={() => go('despacho')}>
          <span className="game-card-icon"><Icon name="gavel" size={24} /></span>
          <span className="game-card-text">
            <strong>Despacho de processos</strong>
            <small>Defira ou indefira casos da Defesa e da Verdade em {d ? d.seconds : 45} segundos.</small>
            {d && <em>{d.total}/{d.cap} processos hoje · +{d.points_each} por acerto</em>}
          </span>
        </button>
        <button type="button" className="game-card" onClick={() => go('memoria')}>
          <span className="game-card-icon"><Icon name="brain" size={24} /></span>
          <span className="game-card-text">
            <strong>Memória dos emblemas</strong>
            <small>Encontre os pares dos emblemas do Estado. 100% offline.</small>
            {mem && <em>{mem.rewarded}/{mem.cap} partidas com pontos hoje · +{mem.points_each} cada</em>}
          </span>
        </button>
      </div>
    </section>
  );
}
