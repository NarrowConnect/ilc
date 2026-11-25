import React, { useEffect, useState } from 'react';
import { MINISTRY_EMBLEMS, formatTime, formatDateTime } from './ministerios';

const RUN_STATUS = {
  pending: 'agendada',
  running: 'em execução',
  done: 'concluída',
  failed: 'falhou',
  skipped: 'pulada',
};

const KIND_LABEL = { post: 'Publicação', suggestion: 'Sugestão', any: 'Qualquer' };

function SuggestionQueue({ api, showToast, onReviewed }) {
  const [status, setStatus] = useState('draft');
  const [items, setItems] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    setItems(null);
    api(`/admin/suggestions?status=${status}`)
      .then(setItems)
      .catch((err) => { setItems([]); showToast('Sugestões', err.message, 'warning'); });
  };

  useEffect(load, [status]);

  const review = async (id, decision) => {
    setBusyId(id);
    try {
      await api(`/admin/suggestions/${id}/review`, { method: 'POST', body: { decision } });
      setItems((prev) => prev.filter((s) => s.id !== id));
      showToast('Sugestão analisada', decision === 'approve' ? 'Aprovada e publicada no Diário Oficial.' : 'Sugestão rejeitada.', 'success');
      onReviewed();
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bento-card ctl-block">
      <div className="ctl-block-head">
        <h3 className="ctl-h3">SUGESTÕES DOS ASSISTENTES</h3>
        <div className="ctl-seg" role="tablist">
          {[['draft', 'Em análise'], ['published', 'Aprovadas'], ['rejected', 'Rejeitadas']].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={status === key} className={status === key ? 'on' : ''} onClick={() => setStatus(key)}>{label}</button>
          ))}
        </div>
      </div>
      {items === null && <p className="feed-muted">Carregando...</p>}
      {items && items.length === 0 && (
        <p className="feed-muted">{status === 'draft' ? 'Nenhuma sugestão aguardando análise.' : 'Nada por aqui ainda.'}</p>
      )}
      {items && items.map((s) => (
        <div key={s.id} className="ctl-suggestion">
          <img className="ctl-emblem-sm" src={MINISTRY_EMBLEMS[s.ministry_code]} alt="" />
          <div className="ctl-suggestion-main">
            <span className="ctl-meta">{s.ministry_name} · {formatDateTime(s.created_at)}</span>
            <strong className="ctl-suggestion-title">{s.title}</strong>
            <p className="ctl-suggestion-body">{s.body}</p>
            {status === 'draft' ? (
              <div className="ctl-row">
                <button type="button" className="state-btn success ctl-btn" disabled={busyId === s.id} onClick={() => review(s.id, 'approve')}>Aprovar e publicar</button>
                <button type="button" className="state-btn outline ctl-btn" disabled={busyId === s.id} onClick={() => review(s.id, 'reject')}>Rejeitar</button>
              </div>
            ) : (
              <span className="ctl-meta">{status === 'published' ? 'Aprovada' : 'Rejeitada'} por @{s.reviewed_by_name || 'admin'} em {formatDateTime(s.reviewed_at)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AssistantCard({ a, api, showToast, onSaved }) {
  const [form, setForm] = useState(a);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(null);
  const [taskKind, setTaskKind] = useState('any');
  const [taskText, setTaskText] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => { setForm(a); }, [a]);

  const dirty = ['has_assistant', 'assistant_enabled', 'posts_per_day', 'suggestions_per_day', 'assistant_persona', 'assistant_context']
    .some((k) => String(form[k]) !== String(a[k]));
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await api(`/admin/assistants/${a.code}`, {
        method: 'PUT',
        body: {
          has_assistant: form.has_assistant,
          assistant_enabled: form.assistant_enabled,
          posts_per_day: Number(form.posts_per_day),
          suggestions_per_day: Number(form.suggestions_per_day),
          assistant_persona: form.assistant_persona,
          assistant_context: form.assistant_context,
        },
      });
      showToast('Assistente atualizado', `${a.assistant_name} salvo. Mudanças na quantidade por dia valem a partir de amanhã.`, 'success');
      onSaved();
    } catch (err) {
      showToast('Não foi possível salvar', err.message, 'warning');
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (kind) => {
    setRunning(kind);
    try {
      const data = await api(`/admin/assistants/${a.code}/run`, { method: 'POST', body: { kind } });
      showToast(
        kind === 'post' ? 'Publicado no Diário Oficial' : 'Sugestão enviada para análise',
        `“${data.post.title}”`,
        'success'
      );
      onSaved();
    } catch (err) {
      showToast('A IA não respondeu', err.message, 'warning');
    } finally {
      setRunning(null);
    }
  };

  const createTask = async (runImmediately) => {
    const instructions = taskText.trim();
    if (!instructions) return;
    setRunning(runImmediately ? 'task' : 'create');
    try {
      const created = await api('/admin/assistant-tasks', { method: 'POST', body: { ministry_code: a.code, kind: taskKind, instructions } });
      setTaskText('');
      if (runImmediately) {
        try {
          const data = await api(`/admin/assistant-tasks/${created.id}/run`, { method: 'POST' });
          showToast('Tarefa cumprida', `“${data.post.title}”`, 'success');
        } catch (err) {
          showToast('Tarefa criada, mas a IA não respondeu', `${err.message} Ela fica na fila para o próximo horário.`, 'warning');
        }
      } else {
        showToast('Tarefa criada', 'O assistente cumpre na próxima rodada dele.', 'success');
      }
      onSaved();
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    } finally {
      setRunning(null);
    }
  };

  const taskAction = async (task, action) => {
    setRunning(task.id);
    try {
      if (action === 'cancel') {
        await api(`/admin/assistant-tasks/${task.id}`, { method: 'DELETE' });
        showToast('Tarefa cancelada', '', 'success');
      } else {
        const data = await api(`/admin/assistant-tasks/${task.id}/run`, { method: 'POST' });
        showToast('Tarefa cumprida', `“${data.post.title}”`, 'success');
      }
      onSaved();
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    } finally {
      setRunning(null);
    }
  };

  const openTasks = a.tasks.filter((t) => t.status === 'open');
  const pastTasks = a.tasks.filter((t) => t.status !== 'open').slice(0, 5);
  const busy = running !== null;

  return (
    <div className={`bento-card ctl-assistant ${a.has_assistant ? '' : 'off'}`}>
      <button type="button" className="ctl-assistant-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <img className="ctl-emblem" src={MINISTRY_EMBLEMS[a.code]} alt="" />
        <div className="ctl-assistant-titles">
          <span className="ctl-ministry">{a.ministry_name}</span>
          <span className="ctl-meta">
            {a.has_assistant
              ? `${a.assistant_name} · ${a.assistant_enabled ? 'em serviço' : 'pausado'} · ${a.posts_per_day} ${a.posts_per_day === 1 ? 'publicação' : 'publicações'} e ${a.suggestions_per_day} ${a.suggestions_per_day === 1 ? 'sugestão' : 'sugestões'} por dia`
              : 'Sem assistente'}
            {openTasks.length > 0 && ` · ${openTasks.length} ${openTasks.length === 1 ? 'tarefa' : 'tarefas'} na fila`}
          </span>
        </div>
        <span className={`ctl-chevron ${open ? 'up' : ''}`} aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="ctl-assistant-body">
          <p className="ctl-mission">{a.mission}</p>

          <div className="ctl-toggles">
            <label className="checkbox-container">
              <input type="checkbox" checked={!!form.has_assistant} onChange={(e) => set('has_assistant', e.target.checked)} />
              Este ministério tem assistente
            </label>
            {form.has_assistant && (
              <label className="checkbox-container">
                <input type="checkbox" checked={!!form.assistant_enabled} onChange={(e) => set('assistant_enabled', e.target.checked)} />
                Em serviço (publica nos horários sorteados)
              </label>
            )}
          </div>

          {form.has_assistant && (
            <>
              <div className="ctl-grid2">
                <div className="form-group">
                  <label>PUBLICAÇÕES POR DIA</label>
                  <input type="number" min="0" max="12" value={form.posts_per_day} onChange={(e) => set('posts_per_day', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>SUGESTÕES POR DIA</label>
                  <input type="number" min="0" max="6" value={form.suggestions_per_day} onChange={(e) => set('suggestions_per_day', e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label>PERSONALIDADE</label>
                <textarea rows="3" maxLength={1000} value={form.assistant_persona} onChange={(e) => set('assistant_persona', e.target.value)} placeholder="Como o assistente fala e se comporta." />
              </div>
              <div className="form-group">
                <label>CONTEXTO E DIRETRIZES PERMANENTES</label>
                <textarea rows="4" maxLength={3000} value={form.assistant_context} onChange={(e) => set('assistant_context', e.target.value)} placeholder="Ex.: Nesta temporada, o foco é a campanha de alistamento. Sempre cite o lema nacional. Evite falar de impostos." />
                <span className="field-desc">O assistente lê isto em todas as publicações e sugestões.</span>
              </div>
            </>
          )}

          {dirty && (
            <button type="button" className="state-btn primary ctl-btn" disabled={saving} onClick={save}>
              {saving ? 'Salvando...' : 'Salvar assistente'}
            </button>
          )}

          {a.has_assistant && !dirty && (
            <>
              <div className="ctl-section-label">TAREFAS</div>
              <div className="ctl-task-form">
                <select value={taskKind} onChange={(e) => setTaskKind(e.target.value)} aria-label="Tipo de tarefa">
                  <option value="any">Na próxima rodada</option>
                  <option value="post">Na próxima publicação</option>
                  <option value="suggestion">Na próxima sugestão</option>
                </select>
                <textarea rows="2" maxLength={2000} value={taskText} onChange={(e) => setTaskText(e.target.value)} placeholder="Ex.: Anuncie o Evento da Democracia de sábado e convide os cidadãos." />
                <div className="ctl-row">
                  <button type="button" className="state-btn primary ctl-btn" disabled={busy || !taskText.trim()} onClick={() => createTask(true)}>
                    {running === 'task' ? 'Escrevendo...' : 'Criar e cumprir agora'}
                  </button>
                  <button type="button" className="state-btn outline ctl-btn" disabled={busy || !taskText.trim()} onClick={() => createTask(false)}>
                    Deixar na fila
                  </button>
                </div>
              </div>

              {openTasks.map((t) => (
                <div key={t.id} className="ctl-task">
                  <span className="ctl-pill">{KIND_LABEL[t.kind]}</span>
                  <span className="ctl-task-text">{t.instructions}</span>
                  <span className="ctl-row tight">
                    <button type="button" className="feed-link-btn" disabled={busy} onClick={() => taskAction(t, 'run')}>{running === t.id ? 'escrevendo...' : 'cumprir agora'}</button>
                    <button type="button" className="feed-link-btn danger" disabled={busy} onClick={() => taskAction(t, 'cancel')}>cancelar</button>
                  </span>
                </div>
              ))}
              {pastTasks.map((t) => (
                <div key={t.id} className="ctl-task past">
                  <span className={`ctl-pill ${t.status}`}>{t.status === 'done' ? 'Cumprida' : 'Cancelada'}</span>
                  <span className="ctl-task-text">{t.instructions}{t.post_title ? ` → “${t.post_title}”` : ''}</span>
                </div>
              ))}

              <div className="ctl-section-label">AGENDA DE HOJE</div>
              {a.today.length === 0 && <p className="feed-muted">A agenda do dia é sorteada no primeiro minuto de funcionamento entre 7h e 22h.</p>}
              <div className="ctl-agenda">
                {a.today.map((r) => (
                  <div key={r.id} className={`ctl-run ${r.status}`} title={r.error || r.post_title || ''}>
                    <span className="ctl-run-time">{formatTime(r.scheduled_for)}</span>
                    <span className="ctl-run-kind">{KIND_LABEL[r.kind]}</span>
                    <span className="ctl-run-status">{RUN_STATUS[r.status]}</span>
                    {(r.post_title || r.error) && <span className="ctl-run-detail">{r.post_title || r.error}</span>}
                  </div>
                ))}
              </div>
              {a.last_failure && (
                <p className="ctl-failure">Última falha ({formatDateTime(a.last_failure.ran_at)}): {a.last_failure.error}</p>
              )}

              <div className="ctl-row">
                <button type="button" className="state-btn outline ctl-btn" disabled={busy} onClick={() => runNow('post')}>
                  {running === 'post' ? 'Escrevendo...' : 'Publicar agora'}
                </button>
                <button type="button" className="state-btn outline ctl-btn" disabled={busy} onClick={() => runNow('suggestion')}>
                  {running === 'suggestion' ? 'Escrevendo...' : 'Sugerir agora'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function AssistentesControle({ api, showToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [model, setModel] = useState('');
  const [savingModel, setSavingModel] = useState(false);

  const load = () => {
    api('/admin/assistants')
      .then((d) => { setData(d); setModel(d.model); setError(null); })
      .catch((err) => setError(err.message));
  };

  useEffect(load, []);

  const saveModel = async () => {
    setSavingModel(true);
    try {
      const d = await api('/admin/assistants-settings', { method: 'PUT', body: { model } });
      setModel(d.model);
      showToast('Modelo atualizado', d.model, 'success');
      load();
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    } finally {
      setSavingModel(false);
    }
  };

  return (
    <section className="tab-pane active ctl-pane">
      <div className="section-heading" style={{ marginBottom: '20px' }}>
        <h2 className="section-title">CONTROLE DOS ASSISTENTES</h2>
        <p className="section-subtitle">Direcione os assistentes dos ministérios: personalidade, diretrizes, tarefas e o que eles enviam para aprovação.</p>
      </div>

      {error && (
        <div className="bento-card ctl-block">
          <p>{error}</p>
          <button type="button" className="state-btn outline ctl-btn" onClick={load}>Tentar novamente</button>
        </div>
      )}

      {data && (
        <>
          <div className="bento-card ctl-block ctl-status">
            <div className="ctl-status-items">
              <span className={`ctl-dot ${data.api_key_configured ? 'ok' : 'bad'}`} />
              <span>{data.api_key_configured ? 'Chave do OpenRouter configurada' : 'Falta a variável OPENROUTER_API_KEY no servidor'}</span>
              {!data.scheduler_enabled && <span className="ctl-pill failed">Agendador desligado (ASSISTANTS_DISABLED)</span>}
              <span className="ctl-meta">Horário de trabalho: {data.window.start_hour}h às {data.window.end_hour}h</span>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>MODELO DE IA (OPENROUTER)</label>
              <div className="ctl-model-row">
                <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder={data.default_model} />
                <button type="button" className="state-btn primary ctl-btn" disabled={savingModel || model === data.model} onClick={saveModel}>Salvar</button>
              </div>
              <span className="field-desc">Use modelos com “:free” no nome. Pode separar vários por vírgula: o primeiro é o principal e os outros entram se ele falhar. Deixe vazio para voltar ao padrão.</span>
            </div>
          </div>

          <SuggestionQueue api={api} showToast={showToast} onReviewed={load} />

          <h3 className="ctl-h3 ctl-list-title">MINISTÉRIOS</h3>
          {data.assistants.map((a) => (
            <AssistantCard key={a.code} a={a} api={api} showToast={showToast} onSaved={load} />
          ))}
        </>
      )}
    </section>
  );
}
