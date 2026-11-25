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


// Formulário de criação: usado na aba Assistentes e no cartão "Indexar novo usuário" do painel
export function NovoAssistenteForm({ api, showToast, onCreated, onCancel, ministries: givenMinistries }) {
  const [ministries, setMinistries] = useState(givenMinistries || []);
  const [form, setForm] = useState({ name: '', ministry_code: '', persona: '', context: '', posts_per_day: 2, suggestions_per_day: 1 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (givenMinistries && givenMinistries.length) return;
    api('/ministries').then(setMinistries).catch(() => {});
  }, []);

  const set = (k, v) => setForm((f) => {
    const next = { ...f, [k]: v };
    // Sugere um nome enquanto o admin não escreveu o próprio
    if (k === 'ministry_code' && (!f.name || f.name.startsWith('Assistente do '))) {
      const m = ministries.find((x) => x.code === v);
      next.name = m ? `Assistente do ${m.name}` : '';
    }
    return next;
  });

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api('/admin/assistants', {
        method: 'POST',
        body: { ...form, posts_per_day: Number(form.posts_per_day), suggestions_per_day: Number(form.suggestions_per_day) },
      });
      showToast('Assistente criado', `${form.name} entra em serviço na próxima agenda (amanhã, ou hoje se ainda não houver agenda).`, 'success');
      setForm({ name: '', ministry_code: '', persona: '', context: '', posts_per_day: 2, suggestions_per_day: 1 });
      if (onCreated) onCreated();
    } catch (err) {
      showToast('Não foi possível criar', err.message, 'warning');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form-dense ctl-new-form" onSubmit={submit}>
      <p className="field-desc ctl-new-note">Assistente não é usuário: não faz login nem tem carteira. Ele escreve no Diário Oficial e envia sugestões em nome do ministério.</p>
      <div className="form-group">
        <label>MINISTÉRIO *</label>
        <select required value={form.ministry_code} onChange={(e) => set('ministry_code', e.target.value)}>
          <option value="">Selecione o ministério...</option>
          {ministries.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label>NOME DO ASSISTENTE *</label>
        <input type="text" required maxLength={120} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Cabo Ribeiro" />
      </div>
      <div className="form-group">
        <label>PERSONALIDADE *</label>
        <textarea required rows="3" maxLength={1000} value={form.persona} onChange={(e) => set('persona', e.target.value)} placeholder="Ex.: Oficial jovem, animado e direto. Fala de treinos e disciplina." />
      </div>
      <div className="form-group">
        <label>CONTEXTO E DIRETRIZES (OPCIONAL)</label>
        <textarea rows="3" maxLength={3000} value={form.context} onChange={(e) => set('context', e.target.value)} placeholder="O que ele deve priorizar ou evitar." />
      </div>
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
      <div className="ctl-row">
        <button type="submit" className="state-btn primary ctl-btn" disabled={saving}>{saving ? 'Criando...' : 'Criar assistente'}</button>
        {onCancel && <button type="button" className="state-btn outline ctl-btn" onClick={onCancel}>Cancelar</button>}
      </div>
    </form>
  );
}

function AssistantCard({ a, api, showToast, onSaved, ministries }) {
  const [form, setForm] = useState(a);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(null);
  const [taskKind, setTaskKind] = useState('any');
  const [taskText, setTaskText] = useState('');
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => { setForm(a); }, [a]);

  const dirty = ['name', 'ministry_code', 'enabled', 'posts_per_day', 'suggestions_per_day', 'persona', 'context']
    .some((k) => String(form[k]) !== String(a[k]));
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await api(`/admin/assistants/${a.id}`, {
        method: 'PUT',
        body: {
          name: form.name,
          ministry_code: form.ministry_code,
          enabled: form.enabled,
          posts_per_day: Number(form.posts_per_day),
          suggestions_per_day: Number(form.suggestions_per_day),
          persona: form.persona,
          context: form.context,
        },
      });
      showToast('Assistente atualizado', `${form.name} salvo. Mudanças na quantidade por dia valem a partir de amanhã.`, 'success');
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
      const data = await api(`/admin/assistants/${a.id}/run`, { method: 'POST', body: { kind } });
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
      const created = await api('/admin/assistant-tasks', { method: 'POST', body: { assistant_id: a.id, kind: taskKind, instructions } });
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

  const remove = async () => {
    try {
      await api(`/admin/assistants/${a.id}`, { method: 'DELETE' });
      showToast('Assistente excluído', a.name, 'success');
      onSaved();
    } catch (err) {
      showToast('Erro', err.message, 'warning');
    }
  };

  const openTasks = a.tasks.filter((t) => t.status === 'open');
  const pastTasks = a.tasks.filter((t) => t.status !== 'open').slice(0, 5);
  const busy = running !== null;

  return (
    <div className={`bento-card ctl-assistant ${a.enabled ? '' : 'off'}`}>
      <button type="button" className="ctl-assistant-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <img className="ctl-emblem" src={MINISTRY_EMBLEMS[a.ministry_code]} alt="" />
        <div className="ctl-assistant-titles">
          <span className="ctl-ministry">{a.name}</span>
          <span className="ctl-meta">
            {`${a.ministry_name} · ${a.enabled ? 'em serviço' : 'pausado'} · ${a.posts_per_day} ${a.posts_per_day === 1 ? 'publicação' : 'publicações'} e ${a.suggestions_per_day} ${a.suggestions_per_day === 1 ? 'sugestão' : 'sugestões'} por dia`}
            {openTasks.length > 0 && ` · ${openTasks.length} ${openTasks.length === 1 ? 'tarefa' : 'tarefas'} na fila`}
          </span>
        </div>
        <span className={`ctl-chevron ${open ? 'up' : ''}`} aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="ctl-assistant-body">
          <p className="ctl-mission">{a.mission}</p>

          <div className="ctl-grid2">
            <div className="form-group">
              <label>NOME</label>
              <input type="text" maxLength={120} value={form.name} onChange={(e) => set('name', e.target.value)} />
            </div>
            <div className="form-group">
              <label>MINISTÉRIO</label>
              <select value={form.ministry_code} onChange={(e) => set('ministry_code', e.target.value)}>
                {ministries.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
              </select>
            </div>
          </div>
          <label className="checkbox-container ctl-check">
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            Em serviço (publica nos horários sorteados)
          </label>
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
            <textarea rows="3" maxLength={1000} value={form.persona} onChange={(e) => set('persona', e.target.value)} placeholder="Como o assistente fala e se comporta." />
          </div>
          <div className="form-group">
            <label>CONTEXTO E DIRETRIZES PERMANENTES</label>
            <textarea rows="4" maxLength={3000} value={form.context} onChange={(e) => set('context', e.target.value)} placeholder="Ex.: Nesta temporada, o foco é a campanha de alistamento. Sempre cite o lema nacional. Evite falar de impostos." />
            <span className="field-desc">O assistente lê isto em todas as publicações e sugestões.</span>
          </div>

          {dirty && (
            <button type="button" className="state-btn primary ctl-btn" disabled={saving} onClick={save}>
              {saving ? 'Salvando...' : 'Salvar assistente'}
            </button>
          )}

          {!dirty && (
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
              <div className="ctl-row ctl-danger-zone">
                {!confirmDelete ? (
                  <button type="button" className="feed-link-btn danger" onClick={() => setConfirmDelete(true)}>Excluir assistente</button>
                ) : (
                  <>
                    <span className="ctl-meta">Excluir {a.name}? As publicações já feitas continuam no Diário Oficial.</span>
                    <button type="button" className="state-btn warning ctl-btn" onClick={remove}>Excluir</button>
                    <button type="button" className="state-btn outline ctl-btn" onClick={() => setConfirmDelete(false)}>Cancelar</button>
                  </>
                )}
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
  const [creating, setCreating] = useState(false);

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
              {data.active_models && data.active_models.length > 0 && (
                <span className="field-desc">Em uso agora: <b>{data.active_models.join(', ')}</b>. Se um modelo gratuito sair do ar, o servidor troca sozinho por outro gratuito disponível.</span>
              )}
              {data.free_models && data.free_models.length > 0 && (
                <div className="ctl-free-models">
                  <span className="field-desc">Gratuitos disponíveis no OpenRouter (toque para adicionar):</span>
                  <div className="ctl-row">
                    {data.free_models.map((id) => (
                      <button
                        type="button"
                        key={id}
                        className="ctl-free-chip"
                        onClick={() => {
                          const list = model.split(',').map((m) => m.trim()).filter(Boolean);
                          if (!list.includes(id)) setModel([...list, id].join(','));
                        }}
                      >
                        {id.replace(/:free$/, '')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <SuggestionQueue api={api} showToast={showToast} onReviewed={load} />

          <div className="ctl-list-head">
            <h3 className="ctl-h3">ASSISTENTES ({data.assistants.length})</h3>
            {!creating && data.assistants.length < data.max_assistants && (
              <button type="button" className="state-btn primary ctl-btn" onClick={() => setCreating(true)}>+ Criar assistente</button>
            )}
          </div>
          {creating && (
            <div className="bento-card ctl-block">
              <h3 className="ctl-h3" style={{ marginBottom: '12px' }}>NOVO ASSISTENTE</h3>
              <NovoAssistenteForm
                api={api}
                showToast={showToast}
                ministries={data.ministries}
                onCreated={() => { setCreating(false); load(); }}
                onCancel={() => setCreating(false)}
              />
            </div>
          )}
          {data.assistants.length === 0 && <p className="feed-muted">Nenhum assistente. Crie o primeiro.</p>}
          {data.assistants.map((a) => (
            <AssistantCard key={a.id} a={a} api={api} showToast={showToast} onSaved={load} ministries={data.ministries} />
          ))}
        </>
      )}
    </section>
  );
}
