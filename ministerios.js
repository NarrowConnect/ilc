// ==========================================
// MINISTÉRIOS, DIÁRIO OFICIAL E ASSISTENTES DE IA
// ==========================================
// - Diário Oficial: feed com as publicações dos ministérios. Cidadãos apoiam e comentam.
// - Assistentes: 4 ministérios têm um "Assistente do Ministério X" que, em horários
//   sorteados ao longo do dia, escreve publicações (vão direto ao feed) e sugestões de
//   melhoria (ficam como rascunho até um admin aprovar).
// - Todo texto dos assistentes vem da IA (OpenRouter). Não há textos prontos de reserva:
//   se a IA falhar, a rodada é pulada e a falha fica no log de auditoria.
//
// Variáveis de ambiente:
//   OPENROUTER_API_KEY   chave da API (obrigatória para os assistentes funcionarem)
//   OPENROUTER_MODEL     modelo(s), separados por vírgula; o primeiro é o principal e os
//                        outros são reserva do próprio OpenRouter. O painel admin pode trocar.
//   ASSISTANTS_DISABLED  "true" desliga o agendador (ex.: em desenvolvimento)

const OPENROUTER_URL = process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions'; // trocar só em testes
const DEFAULT_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const TIMEZONE = 'America/Sao_Paulo';
const TZ_SUFFIX = '-03:00'; // Brasília, sem horário de verão
const WINDOW_START_HOUR = 7; // primeira publicação possível do dia (horário de Brasília)
const WINDOW_END_HOUR = 22; // última publicação possível do dia
const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // rodada atrasada mais de 2h (servidor desligado) é pulada
const TICK_MS = 60 * 1000;
const AI_TIMEOUT_MS = 90 * 1000;
const COMMENT_MAX = 500;
const PARTICIPATION_CODE = 'participacao_diario';

const POST_ANGLES = [
  'um comunicado oficial sobre uma ação concreta do ministério nesta semana',
  'um balanço com números (inventados, mas plausíveis) de resultados recentes do ministério',
  'uma campanha cívica convidando os cidadãos a participar de algo',
  'um aviso ou orientação prática para os cidadãos',
  'uma conquista do governo que o ministério quer celebrar',
  'uma curiosidade sobre a Constituição ou a história do Estado ligada à área do ministério',
  'um reconhecimento público a cidadãos exemplares (sem citar nomes)',
  'um bastidor do dia de trabalho do ministério',
];

const LORE = [
  'Você trabalha no governo do Estado Soberano da Democracia Gerenciada, um país fictício.',
  'Lema nacional: "Soberania, Ordem e Prosperidade". O Estado é dirigido pelo Líder Supremo e pelo Alto Comando; os ministros respondem ao Alto Comando.',
  'Os cidadãos usam o app ILC (Índice de Lealdade Cívica): cada um tem uma carteira com pontuação de 0 a 10.000 (começa em 5.000), faixas que vão de "Vigilância Máxima" até "Alto Comando Honorário", certificados de mérito, eventos cívicos ("Eventos da Democracia") e o Diário Oficial, onde você publica.',
  'Existem 6 ministérios: Verdade, Prosperidade, Defesa, Educação, Saúde e Ciência e Tecnologia. Há também o Banco Central Democrata (autoridade monetária) e o Serviço de Inteligência do Estado.',
  'Regras: escreva sempre em português do Brasil, com tom institucional coerente com o seu ministério. Não cite pessoas, partidos, países ou empresas reais. Não invente leis que retirem direitos fundamentais nem incentive violência.',
].join('\n');

function localParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) % 24, minute: parseInt(parts.minute, 10) };
}

function localTime(day, minutesOfDay) {
  const h = String(Math.floor(minutesOfDay / 60)).padStart(2, '0');
  const m = String(minutesOfDay % 60).padStart(2, '0');
  return new Date(`${day}T${h}:${m}:00${TZ_SUFFIX}`);
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function createMinisterios({ app, pool, authenticateToken, requireRole, applyScoreChange }) {
  const audit = (actorId, entity, entityId, action, newData, oldData = null) =>
    pool.query(
      `INSERT INTO audit_logs (actor_user_id, entity_name, entity_id, action, old_data, new_data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorId, entity, entityId, action, oldData ? JSON.stringify(oldData) : null, JSON.stringify(newData)]
    ).catch((err) => console.error('❌ Falha ao gravar auditoria dos ministérios:', err.message));

  // ------------------------------------------
  // Configuração da IA
  // ------------------------------------------
  async function getModelSetting() {
    const res = await pool.query("SELECT value FROM app_settings WHERE key = 'openrouter_model'");
    const fromDb = res.rows[0] && res.rows[0].value;
    return (fromDb || process.env.OPENROUTER_MODEL || DEFAULT_MODEL).trim();
  }

  async function callOpenRouter(messages) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY não configurada no servidor.');
    const models = (await getModelSetting()).split(',').map((m) => m.trim()).filter(Boolean);
    const body = {
      model: models[0],
      messages,
      temperature: 0.9,
      max_tokens: 700,
    };
    if (models.length > 1) body.models = models;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'ILC - Democracia Gerenciada',
          ...(process.env.APP_URL ? { 'HTTP-Referer': process.env.APP_URL } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'A IA demorou demais para responder.' : `Falha de rede com o OpenRouter: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* resposta não-JSON */ }
    if (!res.ok || !data || data.error) {
      const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || text.slice(0, 300);
      throw new Error(`OpenRouter respondeu ${res.status}: ${msg}`);
    }
    const choice = data.choices && data.choices[0];
    const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
    if (!content) throw new Error('A IA respondeu vazio.');
    return { content, model: data.model || models[0] };
  }

  function parseAiJson(content) {
    const cleaned = content.replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('A IA não respondeu no formato esperado (JSON).');
    let parsed;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (_) {
      throw new Error('A IA respondeu um JSON inválido.');
    }
    const title = String(parsed.titulo || parsed.title || '').trim().slice(0, 140);
    const body = String(parsed.texto || parsed.body || parsed.text || '').trim().slice(0, 2500);
    if (!title || !body) throw new Error('A IA respondeu sem título ou sem texto.');
    return { title, body };
  }

  // ------------------------------------------
  // Contexto que o assistente lê antes de escrever
  // ------------------------------------------
  async function buildContext(ministry, kind) {
    const [citizens, tiers, pending, events, recentPosts, ownSuggestions] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COALESCE(AVG(sa.current_score), 5000) AS media
                  FROM users u LEFT JOIN score_accounts sa ON sa.user_id = u.id WHERE u.status = 'active'`),
      pool.query(`SELECT t.name, COUNT(sa.id) AS total FROM score_tiers t
                  LEFT JOIN score_accounts sa ON sa.current_score BETWEEN t.min_score AND t.max_score
                  GROUP BY t.id, t.name, t.min_score ORDER BY t.min_score`),
      pool.query("SELECT COUNT(*) AS total FROM score_events WHERE status = 'pending'"),
      pool.query(`SELECT title, event_date, location FROM democracy_events
                  WHERE event_date >= $1 ORDER BY event_date ASC LIMIT 3`, [new Date().toISOString()]),
      pool.query(`SELECT fp.title, m.name AS ministry FROM feed_posts fp JOIN ministries m ON m.code = fp.ministry_code
                  WHERE fp.status = 'published' ORDER BY fp.published_at DESC LIMIT 10`),
      pool.query(`SELECT title, status FROM feed_posts WHERE ministry_code = $1 AND kind = 'suggestion'
                  ORDER BY created_at DESC LIMIT 8`, [ministry.code]),
    ]);

    const lines = [];
    const c = citizens.rows[0] || {};
    lines.push(`Cidadãos ativos no ILC: ${c.total || 0}. Pontuação média: ${Math.round(Number(c.media) || 5000)}.`);
    lines.push(`Distribuição por faixa: ${tiers.rows.map((t) => `${t.name}: ${t.total}`).join('; ')}.`);
    lines.push(`Eventos de pontuação aguardando aprovação: ${(pending.rows[0] || {}).total || 0}.`);
    if (events.rows.length) {
      lines.push(`Próximos Eventos da Democracia: ${events.rows.map((e) => `"${e.title}" em ${String(e.event_date).slice(0, 10)}${e.location ? ` (${e.location})` : ''}`).join('; ')}.`);
    } else {
      lines.push('Não há Eventos da Democracia agendados.');
    }
    const { day } = localParts();
    lines.push(`Data de hoje: ${day.split('-').reverse().join('/')}.`);
    if (recentPosts.rows.length) {
      lines.push(`Últimas publicações no Diário Oficial (não repita estes assuntos): ${recentPosts.rows.map((p) => `[${p.ministry}] ${p.title}`).join(' | ')}.`);
    }
    if (kind === 'suggestion' && ownSuggestions.rows.length) {
      lines.push(`Sugestões que você já enviou (não repita): ${ownSuggestions.rows.map((s) => `${s.title} (${s.status === 'published' ? 'aprovada' : s.status === 'rejected' ? 'rejeitada' : 'em análise'})`).join(' | ')}.`);
    }
    return lines.join('\n');
  }

  function buildMessages(ministry, kind, context, task) {
    const system = [
      LORE,
      '',
      `Você é o "${ministry.assistant_name}". Competência do ministério: ${ministry.mission}`,
      `Sua personalidade: ${ministry.assistant_persona || 'servidor público dedicado e formal.'}`,
      ...(ministry.assistant_context ? ['', `Diretrizes permanentes do Alto Comando para você (siga sempre): ${ministry.assistant_context}`] : []),
    ].join('\n');

    const instructions = kind === 'post'
      ? [
          `Escreva UMA publicação para o Diário Oficial do app. Formato desta vez: ${POST_ANGLES[Math.floor(Math.random() * POST_ANGLES.length)]}.`,
          'Entre 40 e 120 palavras, direto ao ponto, sem hashtags e sem emojis em excesso (no máximo um).',
        ]
      : [
          'Escreva UMA sugestão interna de melhoria para o governo ou para o app ILC, dentro da área do seu ministério.',
          'Ela será lida por um administrador, que decide se aprova. Diga o que mudar, por que e qual o benefício para os cidadãos. Entre 60 e 150 palavras.',
        ];

    const user = [
      'Situação atual do sistema:',
      context,
      '',
      ...instructions,
      ...(task ? ['', `TAREFA PRIORITÁRIA DO ALTO COMANDO (cumpra nesta resposta): ${task.instructions}`] : []),
      'Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato: {"titulo": "...", "texto": "..."}',
    ].join('\n');

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  // Gera um texto com a IA e grava no feed. Lança erro se a IA falhar (sem texto de reserva).
  // Sem tarefa explícita, usa a tarefa aberta mais antiga desse assistente (do mesmo tipo ou "qualquer").
  async function nextOpenTask(ministryCode, kind) {
    const res = await pool.query(
      `SELECT * FROM assistant_tasks WHERE ministry_code = $1 AND status = 'open' AND kind IN ($2, 'any')
       ORDER BY created_at ASC LIMIT 1`,
      [ministryCode, kind]
    );
    return res.rows[0] || null;
  }

  async function generateFor(ministry, kind, explicitTask) {
    const task = explicitTask === undefined ? await nextOpenTask(ministry.code, kind) : explicitTask;
    const context = await buildContext(ministry, kind);
    const { content, model } = await callOpenRouter(buildMessages(ministry, kind, context, task));
    const { title, body } = parseAiJson(content);
    const status = kind === 'post' ? 'published' : 'draft';
    const now = new Date().toISOString();
    const res = await pool.query(
      `INSERT INTO feed_posts (ministry_code, kind, title, body, status, ai_model, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [ministry.code, kind, title, body, status, model, status === 'published' ? now : null]
    );
    const postId = res.rows[0].id;
    if (task) {
      await pool.query("UPDATE assistant_tasks SET status = 'done', post_id = $1, done_at = $2 WHERE id = $3", [postId, now, task.id]);
    }
    return { id: postId, title, body, status, model, task_id: task ? task.id : null };
  }

  // ------------------------------------------
  // Agendador (cron interno)
  // ------------------------------------------
  let ticking = false;
  let lastMissingKeyWarning = 0;

  async function ensureTodaySchedule() {
    const now = new Date();
    const { day, hour, minute } = localParts(now);
    const nowMinutes = hour * 60 + minute;
    const windowStart = Math.max(WINDOW_START_HOUR * 60, nowMinutes + 2);
    const windowEnd = WINDOW_END_HOUR * 60;

    const ministries = await pool.query(
      'SELECT code, posts_per_day, suggestions_per_day FROM ministries WHERE has_assistant = 1 AND assistant_enabled = 1'
    );
    for (const m of ministries.rows) {
      const existing = await pool.query('SELECT COUNT(*) AS total FROM assistant_runs WHERE day = $1 AND ministry_code = $2', [day, m.code]);
      if (Number(existing.rows[0].total) > 0) continue;
      const plan = [
        ...Array(m.posts_per_day).fill('post'),
        ...Array(m.suggestions_per_day).fill('suggestion'),
      ];
      if (plan.length === 0) continue;
      if (windowStart >= windowEnd) {
        // Já passou do horário: registra o dia como sem rodadas para não reagendar a cada minuto
        await pool.query(
          `INSERT INTO assistant_runs (ministry_code, kind, day, scheduled_for, status, error)
           VALUES ($1, 'post', $2, $3, 'skipped', 'Agenda criada fora do horário de trabalho')`,
          [m.code, day, now.toISOString()]
        );
        continue;
      }
      for (const kind of plan) {
        const minutes = windowStart + Math.floor(Math.random() * (windowEnd - windowStart));
        await pool.query(
          'INSERT INTO assistant_runs (ministry_code, kind, day, scheduled_for) VALUES ($1, $2, $3, $4)',
          [m.code, kind, day, localTime(day, minutes).toISOString()]
        );
      }
    }
  }

  async function executeRun(run) {
    const mRes = await pool.query('SELECT * FROM ministries WHERE code = $1', [run.ministry_code]);
    const ministry = mRes.rows[0];
    if (!ministry || !ministry.has_assistant || !ministry.assistant_enabled) {
      await pool.query("UPDATE assistant_runs SET status = 'skipped', error = 'Assistente desligado', ran_at = $1 WHERE id = $2", [new Date().toISOString(), run.id]);
      return;
    }
    await pool.query("UPDATE assistant_runs SET status = 'running' WHERE id = $1", [run.id]);
    try {
      const post = await generateFor(ministry, run.kind);
      await pool.query("UPDATE assistant_runs SET status = 'done', post_id = $1, ran_at = $2 WHERE id = $3", [post.id, new Date().toISOString(), run.id]);
      await audit(null, 'feed_posts', post.id, run.kind === 'post' ? 'assistant_post' : 'assistant_suggestion', {
        ministry: ministry.code, title: post.title, model: post.model, status: post.status,
      });
      console.log(`🤖 ${ministry.assistant_name}: ${run.kind === 'post' ? 'publicou' : 'sugeriu'} "${post.title}"`);
    } catch (err) {
      await pool.query("UPDATE assistant_runs SET status = 'failed', error = $1, ran_at = $2 WHERE id = $3", [err.message.slice(0, 500), new Date().toISOString(), run.id]);
      await audit(null, 'assistant_runs', run.id, 'assistant_failed', { ministry: ministry.code, kind: run.kind, error: err.message.slice(0, 500) });
      console.warn(`⚠️  ${ministry.assistant_name}: rodada pulada (${err.message})`);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await ensureTodaySchedule();
      const nowIso = new Date().toISOString();
      const staleIso = new Date(Date.now() - STALE_AFTER_MS).toISOString();
      await pool.query(
        "UPDATE assistant_runs SET status = 'skipped', error = 'Horário perdido (servidor desligado)', ran_at = $1 WHERE status = 'pending' AND scheduled_for < $2",
        [nowIso, staleIso]
      );
      const due = await pool.query(
        "SELECT * FROM assistant_runs WHERE status = 'pending' AND scheduled_for <= $1 ORDER BY scheduled_for ASC LIMIT 1",
        [nowIso]
      );
      if (due.rows.length === 0) return;
      if (!process.env.OPENROUTER_API_KEY) {
        if (Date.now() - lastMissingKeyWarning > 60 * 60 * 1000) {
          console.warn('⚠️  Assistentes dos ministérios parados: defina OPENROUTER_API_KEY no servidor.');
          lastMissingKeyWarning = Date.now();
        }
      }
      // Uma rodada por minuto, para respeitar o limite dos modelos gratuitos
      await executeRun(due.rows[0]);
    } catch (err) {
      console.error('❌ Falha no agendador dos assistentes:', err.message);
    } finally {
      ticking = false;
    }
  }

  async function startScheduler() {
    if (process.env.ASSISTANTS_DISABLED === 'true') {
      console.log('⏸️  Assistentes dos ministérios desligados (ASSISTANTS_DISABLED=true).');
      return;
    }
    // Rodadas que estavam em execução quando o servidor caiu
    await pool.query("UPDATE assistant_runs SET status = 'failed', error = 'Servidor reiniciado durante a execução' WHERE status = 'running'");
    setTimeout(tick, 15 * 1000);
    setInterval(tick, TICK_MS);
    console.log(`🤖 Assistentes dos ministérios ativos${process.env.OPENROUTER_API_KEY ? '' : ' (aguardando OPENROUTER_API_KEY)'}.`);
  }

  // ------------------------------------------
  // Rotas: ministérios e Diário Oficial
  // ------------------------------------------
  const serializePost = (row) => ({
    id: row.id,
    ministry_code: row.ministry_code,
    ministry_name: row.ministry_name,
    author: row.assistant_name || row.ministry_name,
    kind: row.kind,
    title: row.title,
    body: row.body,
    status: row.status,
    pinned: !!row.pinned,
    published_at: row.published_at,
    created_at: row.created_at,
    support_count: Number(row.support_count || 0),
    comment_count: Number(row.comment_count || 0),
    supported_by_me: !!row.supported_by_me,
  });

  app.get('/api/ministries', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT code, name, mission, sort_order, has_assistant, assistant_name, assistant_enabled
         FROM ministries ORDER BY sort_order ASC`
      );
      res.json(result.rows.map((m) => ({ ...m, has_assistant: !!m.has_assistant, assistant_enabled: !!m.assistant_enabled })));
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar ministérios: ' + err.message });
    }
  });

  app.get('/api/feed', authenticateToken, async (req, res) => {
    const limit = clampInt(req.query.limit, 1, 50, 20);
    const before = req.query.before ? String(req.query.before) : null;
    const ministry = req.query.ministry ? String(req.query.ministry) : null;
    try {
      const params = [req.user.id];
      let where = "fp.status = 'published'";
      if (ministry) { params.push(ministry); where += ` AND fp.ministry_code = $${params.length}`; }
      if (before) { params.push(before); where += ` AND fp.published_at < $${params.length}`; }
      params.push(limit);
      // Fixados aparecem só no topo da primeira página
      const order = before ? 'fp.published_at DESC' : 'fp.pinned DESC, fp.published_at DESC';
      const result = await pool.query(
        `SELECT fp.*, m.name AS ministry_name, m.assistant_name,
                (SELECT COUNT(*) FROM feed_reactions r WHERE r.post_id = fp.id) AS support_count,
                (SELECT COUNT(*) FROM feed_comments c WHERE c.post_id = fp.id) AS comment_count,
                EXISTS (SELECT 1 FROM feed_reactions r WHERE r.post_id = fp.id AND r.user_id = $1) AS supported_by_me
         FROM feed_posts fp JOIN ministries m ON m.code = fp.ministry_code
         WHERE ${where} ${before ? 'AND fp.pinned = 0' : ''}
         ORDER BY ${order}
         LIMIT $${params.length}`,
        params
      );
      const posts = result.rows.map(serializePost);
      const lastUnpinned = [...posts].reverse().find((p) => !p.pinned);
      res.json({ posts, next_before: posts.length === limit && lastUnpinned ? lastUnpinned.published_at : null });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar o Diário Oficial: ' + err.message });
    }
  });

  app.post('/api/feed/:id/support', authenticateToken, async (req, res) => {
    try {
      const post = await pool.query("SELECT id FROM feed_posts WHERE id = $1 AND status = 'published'", [req.params.id]);
      if (post.rows.length === 0) return res.status(404).json({ error: 'Publicação não encontrada.' });
      const existing = await pool.query('SELECT 1 AS ok FROM feed_reactions WHERE post_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      if (existing.rows.length) {
        await pool.query('DELETE FROM feed_reactions WHERE post_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      } else {
        await pool.query('INSERT INTO feed_reactions (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
      }
      const count = await pool.query('SELECT COUNT(*) AS total FROM feed_reactions WHERE post_id = $1', [req.params.id]);
      res.json({ supported_by_me: !existing.rows.length, support_count: Number(count.rows[0].total) });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao registrar apoio: ' + err.message });
    }
  });

  app.get('/api/feed/:id/comments', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT c.id, c.body, c.created_at, c.user_id, u.username, u.avatar_url, u.hierarchy_title
         FROM feed_comments c JOIN users u ON u.id = c.user_id
         WHERE c.post_id = $1 ORDER BY c.created_at ASC LIMIT 200`,
        [req.params.id]
      );
      res.json(result.rows.map((c) => ({ ...c, mine: c.user_id === req.user.id })));
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar comentários: ' + err.message });
    }
  });

  app.post('/api/feed/:id/comments', authenticateToken, async (req, res) => {
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Escreva um comentário.' });
    if (body.length > COMMENT_MAX) return res.status(400).json({ error: `O comentário pode ter no máximo ${COMMENT_MAX} caracteres.` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const post = await client.query("SELECT id FROM feed_posts WHERE id = $1 AND status = 'published'", [req.params.id]);
      if (post.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Publicação não encontrada.' });
      }
      const inserted = await client.query(
        'INSERT INTO feed_comments (post_id, user_id, body) VALUES ($1, $2, $3) RETURNING id, created_at',
        [req.params.id, req.user.id, body]
      );

      // Primeiro comentário do dia (horário de Brasília) rende pontos de participação
      let reward = null;
      const { day } = localParts();
      const dayStart = localTime(day, 0).toISOString();
      const type = await client.query('SELECT id, points_delta FROM score_event_types WHERE code = $1 AND active = 1', [PARTICIPATION_CODE]);
      const hasAccount = await client.query('SELECT 1 AS ok FROM score_accounts WHERE user_id = $1', [req.user.id]);
      if (type.rows.length && hasAccount.rows.length) {
        const already = await client.query(
          'SELECT 1 AS ok FROM score_events WHERE user_id = $1 AND event_type_id = $2 AND occurred_at >= $3',
          [req.user.id, type.rows[0].id, dayStart]
        );
        if (already.rows.length === 0) {
          const points = type.rows[0].points_delta;
          await client.query(
            `INSERT INTO score_events (user_id, event_type_id, points_delta, description, status, approved_by)
             VALUES ($1, $2, $3, 'Participação no Diário Oficial', 'approved', NULL)`,
            [req.user.id, type.rows[0].id, points]
          );
          const change = await applyScoreChange(client, req.user.id, points, null);
          reward = { points, new_score: change.newScore, unlocked_certificates: change.unlockedCerts };
        }
      }
      await client.query('COMMIT');
      res.json({ id: inserted.rows[0].id, created_at: inserted.rows[0].created_at, reward });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: 'Erro ao comentar: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/feed/comments/:id', authenticateToken, async (req, res) => {
    try {
      const found = await pool.query('SELECT id, user_id, post_id, body FROM feed_comments WHERE id = $1', [req.params.id]);
      if (found.rows.length === 0) return res.status(404).json({ error: 'Comentário não encontrado.' });
      const comment = found.rows[0];
      if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(400).json({ error: 'Você só pode apagar os seus comentários.' }); // 403 desloga no app
      }
      await pool.query('DELETE FROM feed_comments WHERE id = $1', [req.params.id]);
      if (comment.user_id !== req.user.id) {
        await audit(req.user.id, 'feed_comments', comment.id, 'delete_comment', { post_id: comment.post_id }, { body: comment.body, user_id: comment.user_id });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao apagar comentário: ' + err.message });
    }
  });

  // ------------------------------------------
  // Rotas administrativas
  // ------------------------------------------
  app.post('/api/admin/feed/:id/pin', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const pinned = req.body && req.body.pinned ? 1 : 0;
      const result = await pool.query('UPDATE feed_posts SET pinned = $1 WHERE id = $2', [pinned, req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Publicação não encontrada.' });
      await audit(req.user.id, 'feed_posts', req.params.id, pinned ? 'pin_post' : 'unpin_post', { pinned: !!pinned });
      res.json({ success: true, pinned: !!pinned });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao fixar publicação: ' + err.message });
    }
  });

  app.delete('/api/admin/feed/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const found = await pool.query('SELECT id, ministry_code, kind, title, status FROM feed_posts WHERE id = $1', [req.params.id]);
      if (found.rows.length === 0) return res.status(404).json({ error: 'Publicação não encontrada.' });
      await pool.query('UPDATE assistant_runs SET post_id = NULL WHERE post_id = $1', [req.params.id]);
      await pool.query('DELETE FROM feed_posts WHERE id = $1', [req.params.id]);
      await audit(req.user.id, 'feed_posts', req.params.id, 'delete_post', { deleted: true }, found.rows[0]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao apagar publicação: ' + err.message });
    }
  });

  app.get('/api/admin/suggestions', authenticateToken, requireRole(['admin']), async (req, res) => {
    const status = ['draft', 'published', 'rejected'].includes(req.query.status) ? req.query.status : 'draft';
    try {
      const result = await pool.query(
        `SELECT fp.*, m.name AS ministry_name, m.assistant_name, u.username AS reviewed_by_name
         FROM feed_posts fp JOIN ministries m ON m.code = fp.ministry_code
         LEFT JOIN users u ON u.id = fp.reviewed_by
         WHERE fp.kind = 'suggestion' AND fp.status = $1
         ORDER BY COALESCE(fp.reviewed_at, fp.created_at) DESC LIMIT 100`,
        [status]
      );
      res.json(result.rows.map((r) => ({ ...serializePost(r), reviewed_at: r.reviewed_at, reviewed_by_name: r.reviewed_by_name, ai_model: r.ai_model })));
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar sugestões: ' + err.message });
    }
  });

  app.post('/api/admin/suggestions/:id/review', authenticateToken, requireRole(['admin']), async (req, res) => {
    const decision = req.body && req.body.decision;
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Decisão inválida.' });
    try {
      const found = await pool.query("SELECT id, title, status FROM feed_posts WHERE id = $1 AND kind = 'suggestion'", [req.params.id]);
      if (found.rows.length === 0) return res.status(404).json({ error: 'Sugestão não encontrada.' });
      if (found.rows[0].status !== 'draft') return res.status(409).json({ error: 'Esta sugestão já foi analisada.' });
      const now = new Date().toISOString();
      const status = decision === 'approve' ? 'published' : 'rejected';
      await pool.query(
        'UPDATE feed_posts SET status = $1, reviewed_by = $2, reviewed_at = $3, published_at = $4 WHERE id = $5',
        [status, req.user.id, now, status === 'published' ? now : null, req.params.id]
      );
      await audit(req.user.id, 'feed_posts', req.params.id, decision === 'approve' ? 'approve_suggestion' : 'reject_suggestion', { status, title: found.rows[0].title }, { status: 'draft' });
      res.json({ success: true, status });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao analisar sugestão: ' + err.message });
    }
  });

  app.get('/api/admin/assistants', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const { day } = localParts();
      const [ministries, runs, lastFailures, model, drafts, tasks] = await Promise.all([
        pool.query('SELECT * FROM ministries ORDER BY sort_order ASC'),
        pool.query(
          `SELECT r.id, r.ministry_code, r.kind, r.scheduled_for, r.status, r.error, r.ran_at, fp.title AS post_title
           FROM assistant_runs r LEFT JOIN feed_posts fp ON fp.id = r.post_id
           WHERE r.day = $1 ORDER BY r.scheduled_for ASC`,
          [day]
        ),
        pool.query(
          `SELECT ministry_code, error, ran_at FROM assistant_runs
           WHERE status = 'failed' ORDER BY ran_at DESC LIMIT 30`
        ),
        getModelSetting(),
        pool.query("SELECT COUNT(*) AS total FROM feed_posts WHERE kind = 'suggestion' AND status = 'draft'"),
        pool.query(
          `SELECT t.*, fp.title AS post_title, fp.status AS post_status FROM assistant_tasks t
           LEFT JOIN feed_posts fp ON fp.id = t.post_id
           WHERE t.status = 'open' OR t.created_at >= $1
           ORDER BY t.created_at DESC LIMIT 200`,
          [new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()]
        ),
      ]);
      res.json({
        api_key_configured: !!process.env.OPENROUTER_API_KEY,
        scheduler_enabled: process.env.ASSISTANTS_DISABLED !== 'true',
        model,
        default_model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
        window: { start_hour: WINDOW_START_HOUR, end_hour: WINDOW_END_HOUR },
        pending_suggestions: Number(drafts.rows[0].total),
        assistants: ministries.rows.map((m) => ({
          code: m.code,
          ministry_name: m.name,
          mission: m.mission,
          has_assistant: !!m.has_assistant,
          assistant_name: m.assistant_name || `Assistente do ${m.name}`,
          assistant_persona: m.assistant_persona || '',
          assistant_context: m.assistant_context || '',
          assistant_enabled: !!m.assistant_enabled,
          posts_per_day: m.posts_per_day,
          suggestions_per_day: m.suggestions_per_day,
          today: runs.rows.filter((r) => r.ministry_code === m.code && r.error !== 'Agenda criada fora do horário de trabalho'),
          last_failure: lastFailures.rows.find((f) => f.ministry_code === m.code) || null,
          tasks: tasks.rows.filter((t) => t.ministry_code === m.code),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar assistentes: ' + err.message });
    }
  });

  // Ajusta um assistente. has_assistant liga/desliga o assistente de qualquer um dos 6 ministérios.
  app.put('/api/admin/assistants/:code', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM ministries WHERE code = $1', [req.params.code]);
      if (found.rows.length === 0) return res.status(404).json({ error: 'Ministério não encontrado.' });
      const cur = found.rows[0];
      const b = req.body || {};
      const text = (value, fallback, max) => (value === undefined ? fallback : String(value || '').trim().slice(0, max));
      const next = {
        has_assistant: b.has_assistant === undefined ? cur.has_assistant : (b.has_assistant ? 1 : 0),
        assistant_enabled: b.assistant_enabled === undefined ? cur.assistant_enabled : (b.assistant_enabled ? 1 : 0),
        posts_per_day: b.posts_per_day === undefined ? cur.posts_per_day : clampInt(b.posts_per_day, 0, 12, cur.posts_per_day),
        suggestions_per_day: b.suggestions_per_day === undefined ? cur.suggestions_per_day : clampInt(b.suggestions_per_day, 0, 6, cur.suggestions_per_day),
        assistant_name: text(b.assistant_name, cur.assistant_name, 120) || `Assistente do ${cur.name}`,
        assistant_persona: text(b.assistant_persona, cur.assistant_persona, 1000),
        assistant_context: text(b.assistant_context, cur.assistant_context, 3000) || null,
      };
      if (next.has_assistant && !next.assistant_persona) {
        return res.status(400).json({ error: 'Descreva a personalidade do assistente antes de ativá-lo.' });
      }
      await pool.query(
        `UPDATE ministries SET has_assistant = $1, assistant_enabled = $2, posts_per_day = $3, suggestions_per_day = $4,
                assistant_name = $5, assistant_persona = $6, assistant_context = $7 WHERE code = $8`,
        [next.has_assistant, next.assistant_enabled, next.posts_per_day, next.suggestions_per_day,
          next.assistant_name, next.assistant_persona || null, next.assistant_context, req.params.code]
      );
      // Desligar cancela as rodadas que ainda iam acontecer hoje
      if (!next.has_assistant || !next.assistant_enabled) {
        await pool.query("UPDATE assistant_runs SET status = 'skipped', error = 'Assistente desligado' WHERE ministry_code = $1 AND status = 'pending'", [req.params.code]);
      }
      await audit(req.user.id, 'ministries', req.params.code, 'update_assistant', next, {
        has_assistant: cur.has_assistant, assistant_enabled: cur.assistant_enabled, posts_per_day: cur.posts_per_day,
        suggestions_per_day: cur.suggestions_per_day, assistant_name: cur.assistant_name,
        assistant_persona: cur.assistant_persona, assistant_context: cur.assistant_context,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao salvar assistente: ' + err.message });
    }
  });

  // Tarefas: o admin direciona um assistente; a próxima rodada dele cumpre a tarefa
  app.post('/api/admin/assistant-tasks', authenticateToken, requireRole(['admin']), async (req, res) => {
    const b = req.body || {};
    const instructions = String(b.instructions || '').trim().slice(0, 2000);
    const kind = ['any', 'post', 'suggestion'].includes(b.kind) ? b.kind : 'any';
    if (!instructions) return res.status(400).json({ error: 'Descreva a tarefa.' });
    try {
      const m = await pool.query('SELECT code, has_assistant FROM ministries WHERE code = $1', [b.ministry_code]);
      if (m.rows.length === 0) return res.status(404).json({ error: 'Ministério não encontrado.' });
      if (!m.rows[0].has_assistant) return res.status(400).json({ error: 'Este ministério não tem assistente ativo.' });
      const ins = await pool.query(
        'INSERT INTO assistant_tasks (ministry_code, kind, instructions, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [b.ministry_code, kind, instructions, req.user.id]
      );
      await audit(req.user.id, 'assistant_tasks', ins.rows[0].id, 'create_task', { ministry: b.ministry_code, kind, instructions });
      res.json({ success: true, id: ins.rows[0].id });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao criar tarefa: ' + err.message });
    }
  });

  app.delete('/api/admin/assistant-tasks/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const result = await pool.query("UPDATE assistant_tasks SET status = 'cancelled', done_at = $1 WHERE id = $2 AND status = 'open'", [new Date().toISOString(), req.params.id]);
      if (result.rowCount === 0) return res.status(404).json({ error: 'Tarefa não encontrada ou já concluída.' });
      await audit(req.user.id, 'assistant_tasks', req.params.id, 'cancel_task', { status: 'cancelled' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao cancelar tarefa: ' + err.message });
    }
  });

  // Cumpre a tarefa agora, sem esperar o próximo horário do assistente
  app.post('/api/admin/assistant-tasks/:id/run', authenticateToken, requireRole(['admin']), async (req, res) => {
    let task;
    try {
      const t = await pool.query("SELECT * FROM assistant_tasks WHERE id = $1 AND status = 'open'", [req.params.id]);
      if (t.rows.length === 0) return res.status(404).json({ error: 'Tarefa não encontrada ou já concluída.' });
      task = t.rows[0];
      const m = await pool.query('SELECT * FROM ministries WHERE code = $1 AND has_assistant = 1', [task.ministry_code]);
      if (m.rows.length === 0) return res.status(400).json({ error: 'Este ministério não tem assistente ativo.' });
      const kind = task.kind === 'suggestion' ? 'suggestion' : 'post';
      const post = await generateFor(m.rows[0], kind, task);
      await audit(req.user.id, 'feed_posts', post.id, kind === 'post' ? 'assistant_post_manual' : 'assistant_suggestion_manual', {
        ministry: task.ministry_code, title: post.title, model: post.model, status: post.status, task_id: task.id,
      });
      res.json({ success: true, post });
    } catch (err) {
      if (task) await audit(req.user.id, 'assistant_tasks', task.id, 'assistant_failed', { error: err.message.slice(0, 500), manual: true });
      res.status(502).json({ error: err.message });
    }
  });

  app.put('/api/admin/assistants-settings', authenticateToken, requireRole(['admin']), async (req, res) => {
    const model = String((req.body && req.body.model) || '').trim().slice(0, 400);
    try {
      const old = await getModelSetting();
      if (model) {
        await pool.query(
          "INSERT INTO app_settings (key, value) VALUES ('openrouter_model', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          [model]
        );
      } else {
        await pool.query("DELETE FROM app_settings WHERE key = 'openrouter_model'");
      }
      await audit(req.user.id, 'app_settings', 'openrouter_model', 'update_setting', { model: model || '(padrão)' }, { model: old });
      res.json({ success: true, model: await getModelSetting() });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao salvar o modelo: ' + err.message });
    }
  });

  // Executa o assistente agora (botão de teste do painel). Não altera a agenda do dia.
  app.post('/api/admin/assistants/:code/run', authenticateToken, requireRole(['admin']), async (req, res) => {
    const kind = req.body && req.body.kind === 'suggestion' ? 'suggestion' : 'post';
    try {
      const found = await pool.query('SELECT * FROM ministries WHERE code = $1 AND has_assistant = 1', [req.params.code]);
      if (found.rows.length === 0) return res.status(404).json({ error: 'Assistente não encontrado.' });
      const post = await generateFor(found.rows[0], kind);
      await audit(req.user.id, 'feed_posts', post.id, kind === 'post' ? 'assistant_post_manual' : 'assistant_suggestion_manual', {
        ministry: req.params.code, title: post.title, model: post.model, status: post.status,
      });
      res.json({ success: true, post });
    } catch (err) {
      await audit(req.user.id, 'ministries', req.params.code, 'assistant_failed', { kind, error: err.message.slice(0, 500), manual: true });
      res.status(502).json({ error: err.message });
    }
  });

  return { startScheduler };
}

module.exports = { createMinisterios };
