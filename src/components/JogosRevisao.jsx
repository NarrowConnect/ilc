import React, { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
import { MINISTRY_EMBLEMS } from './ministerios';
import { formatRelative } from './ministerios';

// Admin: revisão do que os assistentes escreveram para os jogos (missões, quiz e processos).
// Nada entra nos jogos sem aprovação.

const TYPES = [
  { key: 'missions', label: 'Missões', empty: 'missões', gen: 'Pedir missões' },
  { key: 'quiz', label: 'Quiz', empty: 'perguntas', gen: 'Pedir perguntas' },
  { key: 'cases', label: 'Processos', empty: 'processos', gen: 'Pedir processos' },
];

const ACTION_LABEL = {
  apoiar: 'apoiar publicações', comentar: 'comentar', publicar: 'publicar no Diário',
  quiz: 'responder o quiz', despacho: 'despachar processos', memoria: 'jogar a memória',
};

export default function JogosRevisao({ api, showToast }) {
  const [type, setType] = useState('missions');
  const [status, setStatus] = useState('pending');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api(`/admin/games?status=${status}`));
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    }
  }, [api, status, showToast]);

  useEffect(() => { load(); }, [load]);

  const review = async (ids, decision) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await api('/admin/games/review', { method: 'POST', body: { type, ids, decision } });
      showToast(decision === 'approve' ? 'Aprovado' : 'Recusado', `${r.changed} item(ns) ${decision === 'approve' ? 'liberado(s) nos jogos' : 'descartado(s)'}.`, 'success');
      await load();
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  const save = async (id, body) => {
    try {
      await api(`/admin/games/${type}/${id}`, { method: 'PUT', body });
      await load();
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    }
  };

  const generate = async () => {
    setGenerating(true);
    try {
      const r = await api('/admin/games/generate', { method: 'POST', body: { type } });
      showToast('Conteúdo novo', `${r.assistant} escreveu ${r.saved} ${r.label} para revisão.`, 'success');
      setStatus('pending');
      await load();
    } catch (err) {
      showToast('A IA não respondeu', err.message, 'warning');
    } finally {
      setGenerating(false);
    }
  };

  const items = data ? data[type] : [];
  const s = data && data.stock;
  const g = data && data.generator;

  return (
    <div className="bento-card ctl-card games-review">
      <div className="game-block-head">
        <h3><Icon name="gamepad" size={18} /> Conteúdo dos jogos</h3>
        <button type="button" className="feed-refresh" onClick={load} aria-label="Atualizar"><Icon name="refresh" size={18} /></button>
      </div>
      <p className="game-muted">Os assistentes escrevem missões (todos), perguntas do quiz (Educação) e processos (Defesa e Verdade) sozinhos, das 7h às 22h, quando o estoque baixa. Nada entra nos jogos sem a sua aprovação.</p>

      {s && (
        <div className="games-stock">
          <span><b>{s.missions.ready}</b> missões prontas · <b>{s.missions.pending}</b> para revisar</span>
          <span><b>{s.quiz.approved}</b> perguntas no quiz · <b>{s.quiz.pending}</b> para revisar</span>
          <span><b>{s.cases.approved}</b> processos na mesa · <b>{s.cases.pending}</b> para revisar</span>
        </div>
      )}
      {g && (!g.api_key_configured || !g.enabled) && (
        <p className="games-warn"><Icon name="alert" size={15} /> {!g.api_key_configured ? 'OPENROUTER_API_KEY não configurada: os assistentes não conseguem escrever.' : 'Gerador automático desligado (ASSISTANTS_DISABLED). Use o botão para pedir conteúdo.'}</p>
      )}
      {g && g.last_failure && (
        <p className="games-warn"><Icon name="alert" size={15} /> Última falha {formatRelative(g.last_failure.at)}: {g.last_failure.error}</p>
      )}

      <div className="ctl-row games-tabs">
        <div className="ctl-seg">
          {TYPES.map((t) => (
            <button type="button" key={t.key} className={type === t.key ? 'on' : ''} onClick={() => setType(t.key)}>{t.label}</button>
          ))}
        </div>
        <div className="ctl-seg">
          {[['pending', 'Para revisar'], ['approved', 'Aprovados'], ['rejected', 'Recusados']].map(([k, l]) => (
            <button type="button" key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="ctl-row">
        <button type="button" className="state-btn outline ctl-btn" onClick={generate} disabled={generating}>
          <Icon name="sparkles" size={15} /> {generating ? 'Escrevendo...' : TYPES.find((t) => t.key === type).gen}
        </button>
        {status === 'pending' && items.length > 1 && (
          <button type="button" className="state-btn success ctl-btn" disabled={busy} onClick={() => review(items.map((i) => i.id), 'approve')}>
            Aprovar todos ({items.length})
          </button>
        )}
      </div>

      {data && !items.length && (
        <p className="game-muted games-none">Nenhum item {status === 'pending' ? 'para revisar' : status === 'approved' ? 'aprovado' : 'recusado'} em {TYPES.find((t) => t.key === type).empty}.</p>
      )}

      <div className="games-items">
        {items.map((it) => (
          <div key={it.id} className="games-item">
            {type === 'missions' && (
              <>
                <div className="games-item-head">
                  {MINISTRY_EMBLEMS[it.ministry_code] && <img src={MINISTRY_EMBLEMS[it.ministry_code]} alt="" className="ctl-emblem-sm" />}
                  <div>
                    <strong>{it.title}</strong>
                    <small>{it.author_name} · {ACTION_LABEL[it.action]} ({it.target}x) · +{it.points} pontos{it.day ? ` · usada em ${it.day.split('-').reverse().join('/')}` : ''}</small>
                  </div>
                </div>
                {it.description && <p>{it.description}</p>}
              </>
            )}
            {type === 'quiz' && (
              <>
                <div className="games-item-head"><div><strong>{it.question}</strong><small>{it.author_name}</small></div></div>
                <ol className="games-options">
                  {it.options.map((o, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className={i === it.correct_index ? 'right' : ''}
                        disabled={status !== 'pending' || i === it.correct_index}
                        title={status === 'pending' ? 'Marcar como a correta' : undefined}
                        onClick={() => save(it.id, { question: it.question, options: it.options, correct_index: i, explanation: it.explanation })}
                      >
                        {'ABCD'[i]}. {o} {i === it.correct_index && <Icon name="check" size={14} />}
                      </button>
                    </li>
                  ))}
                </ol>
                {it.explanation && <p className="game-muted">{it.explanation}</p>}
                {status === 'pending' && <small className="game-muted">Toque em outra alternativa para corrigir a resposta certa.</small>}
              </>
            )}
            {type === 'cases' && (
              <>
                <div className="games-item-head">
                  {MINISTRY_EMBLEMS[it.ministry_code] && <img src={MINISTRY_EMBLEMS[it.ministry_code]} alt="" className="ctl-emblem-sm" />}
                  <div><strong>{it.title}</strong><small>{it.author_name}</small></div>
                </div>
                <p>{it.summary}</p>
                <div className="ctl-row">
                  <span className="game-muted">Decisão certa:</span>
                  <div className="ctl-seg">
                    {['deferir', 'indeferir'].map((dcs) => (
                      <button
                        type="button"
                        key={dcs}
                        className={it.correct_decision === dcs ? 'on' : ''}
                        disabled={status !== 'pending'}
                        onClick={() => it.correct_decision !== dcs && save(it.id, { title: it.title, summary: it.summary, correct_decision: dcs, rationale: it.rationale })}
                      >
                        {dcs === 'deferir' ? 'Deferir' : 'Indeferir'}
                      </button>
                    ))}
                  </div>
                </div>
                {it.rationale && <p className="game-muted">{it.rationale}</p>}
              </>
            )}
            {status === 'pending' && (
              <div className="ctl-row games-item-actions">
                <button type="button" className="state-btn success ctl-btn" disabled={busy} onClick={() => review([it.id], 'approve')}>Aprovar</button>
                <button type="button" className="state-btn outline ctl-btn" disabled={busy} onClick={() => review([it.id], 'reject')}>Recusar</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
