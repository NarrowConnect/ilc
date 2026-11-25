// ==========================================
// MINISTÉRIOS, DIÁRIO OFICIAL E ASSISTENTES DE IA
// ==========================================
// - Diário Oficial: feed com as publicações dos ministérios. Cidadãos apoiam e comentam.
// - Assistentes (tabela assistants): não são usuários. Cada um trabalha para um ministério e,
//   em horários sorteados ao longo do dia, escreve publicações (vão direto ao feed) e
//   sugestões de melhoria (ficam como rascunho até um admin aprovar). Começam 4 (Verdade,
//   Prosperidade, Defesa, Educação) e o admin cria ou exclui outros pelo painel.
// - Todo texto dos assistentes vem da IA (OpenRouter). Não há textos prontos de reserva:
//   se a IA falhar, a rodada é pulada e a falha fica no log de auditoria.
//
// Variáveis de ambiente:
//   OPENROUTER_API_KEY   chave da API (obrigatória para os assistentes funcionarem)
//   OPENROUTER_MODEL     modelo(s), separados por vírgula; o primeiro é o principal e os
//                        outros são reserva do próprio OpenRouter. O painel admin pode trocar.
//   ASSISTANTS_DISABLED  "true" desliga o agendador (ex.: em desenvolvimento)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DB_PATH } = require('./db');

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

  async function callOpenRouter(messages, { maxTokens = 700, temperature = 0.9 } = {}) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY não configurada no servidor.');
    const models = (await getModelSetting()).split(',').map((m) => m.trim()).filter(Boolean);
    const body = {
      model: models[0],
      messages,
      temperature,
      max_tokens: maxTokens,
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
  // Migração: assistentes separados dos ministérios
  // ------------------------------------------
  // Assistentes não são usuários: não fazem login nem têm carteira. Os 4 iniciais vêm das
  // colunas assistant_* da tabela ministries (com id igual ao código do ministério).
  async function columnExists(table, column) {
    const res = await pool.query(`SELECT name FROM pragma_table_info('${table}') WHERE name = $1`, [column]);
    return res.rows.length > 0;
  }

  // Bancos de antes dos posts de cidadão: feed_posts tinha ministry_code obrigatório e kind só
  // post/suggestion. SQLite não altera CHECK/NOT NULL, então a tabela é reconstruída com a
  // definição atual do SQL/sqlite_schema.sql, mantendo os dados, apoios e comentários.
  async function rebuildFeedPostsIfNeeded() {
    const cur = await pool.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'feed_posts'");
    if (!cur.rows.length || cur.rows[0].sql.includes("'citizen'")) return;
    const schema = fs.readFileSync(path.join(__dirname, 'SQL', 'sqlite_schema.sql'), 'utf8');
    const match = schema.match(/CREATE TABLE IF NOT EXISTS feed_posts \([\s\S]*?\n\);/);
    if (!match) throw new Error('Definição de feed_posts não encontrada no schema.');
    const ddl = match[0].replace('CREATE TABLE IF NOT EXISTS feed_posts', 'CREATE TABLE feed_posts_new');
    const oldCols = (await pool.query("SELECT name FROM pragma_table_info('feed_posts')")).rows.map((r) => r.name);

    // Com foreign_keys ligado, apagar a tabela antiga apagaria apoios e comentários em cascata
    await pool.query('PRAGMA foreign_keys = OFF');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(ddl);
      const newCols = (await client.query("SELECT name FROM pragma_table_info('feed_posts_new')")).rows.map((r) => r.name);
      const cols = oldCols.filter((c) => newCols.includes(c)).join(', ');
      await client.query(`INSERT INTO feed_posts_new (${cols}) SELECT ${cols} FROM feed_posts`);
      await client.query('DROP TABLE feed_posts');
      await client.query('ALTER TABLE feed_posts_new RENAME TO feed_posts');
      await client.query('CREATE INDEX IF NOT EXISTS idx_feed_posts_status ON feed_posts(status, published_at)');
      await client.query('COMMIT');
      console.log('🗞️  Diário Oficial preparado para publicações dos cidadãos.');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
      await pool.query('PRAGMA foreign_keys = ON');
    }
  }

  async function migrate() {
    await rebuildFeedPostsIfNeeded();
    await pool.query('CREATE INDEX IF NOT EXISTS idx_feed_posts_user ON feed_posts(user_id)');
    const add = async (table, column, ddl) => {
      if (!(await columnExists(table, column))) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    await add('feed_posts', 'assistant_id', 'assistant_id TEXT REFERENCES assistants(id) ON DELETE SET NULL');
    await add('feed_posts', 'author_name', 'author_name TEXT');
    await add('assistant_runs', 'assistant_id', 'assistant_id TEXT REFERENCES assistants(id) ON DELETE CASCADE');
    await add('assistant_tasks', 'assistant_id', 'assistant_id TEXT REFERENCES assistants(id) ON DELETE CASCADE');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_assistant_runs_assistant ON assistant_runs(day, assistant_id)');

    const done = await pool.query("SELECT value FROM app_settings WHERE key = 'migration_assistants_v1'");
    if (done.rows.length) return;
    await pool.query(
      `INSERT OR IGNORE INTO assistants (id, ministry_code, name, persona, context, enabled, posts_per_day, suggestions_per_day)
       SELECT code, code, COALESCE(assistant_name, 'Assistente do ' || name), assistant_persona, assistant_context,
              assistant_enabled, posts_per_day, suggestions_per_day
       FROM ministries WHERE has_assistant = 1 AND assistant_persona IS NOT NULL`
    );
    await pool.query('UPDATE feed_posts SET assistant_id = ministry_code WHERE assistant_id IS NULL AND ministry_code IN (SELECT id FROM assistants)');
    await pool.query(`UPDATE feed_posts SET author_name = (SELECT name FROM assistants a WHERE a.id = feed_posts.assistant_id)
                      WHERE author_name IS NULL AND assistant_id IS NOT NULL`);
    await pool.query('UPDATE assistant_runs SET assistant_id = ministry_code WHERE assistant_id IS NULL AND ministry_code IN (SELECT id FROM assistants)');
    await pool.query('UPDATE assistant_tasks SET assistant_id = ministry_code WHERE assistant_id IS NULL AND ministry_code IN (SELECT id FROM assistants)');
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('migration_assistants_v1', $1)", [new Date().toISOString()]);
    console.log('🤖 Assistentes migrados para a tabela própria.');
  }

  const ready = migrate().catch((err) => {
    console.error('❌ Falha na migração dos assistentes:', err.message);
  });

  const ASSISTANT_SELECT = `SELECT a.*, m.name AS ministry_name, m.mission
                            FROM assistants a JOIN ministries m ON m.code = a.ministry_code`;

  async function loadAssistant(id) {
    const res = await pool.query(`${ASSISTANT_SELECT} WHERE a.id = $1`, [id]);
    return res.rows[0] || null;
  }

  // ------------------------------------------
  // Contexto que o assistente lê antes de escrever
  // ------------------------------------------
  async function buildContext(assistant, kind) {
    const [citizens, tiers, pending, events, recentPosts, ownSuggestions, colleagues] = await Promise.all([
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
      pool.query(`SELECT title, status FROM feed_posts WHERE assistant_id = $1 AND kind = 'suggestion'
                  ORDER BY created_at DESC LIMIT 8`, [assistant.id]),
      pool.query('SELECT name FROM assistants WHERE ministry_code = $1 AND id != $2 AND enabled = 1', [assistant.ministry_code, assistant.id]),
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
    if (colleagues.rows.length) {
      lines.push(`Colegas de ministério: ${colleagues.rows.map((x) => x.name).join(', ')}.`);
    }
    if (recentPosts.rows.length) {
      lines.push(`Últimas publicações no Diário Oficial (não repita estes assuntos): ${recentPosts.rows.map((p) => `[${p.ministry}] ${p.title}`).join(' | ')}.`);
    }
    if (kind === 'suggestion' && ownSuggestions.rows.length) {
      lines.push(`Sugestões que você já enviou (não repita): ${ownSuggestions.rows.map((s) => `${s.title} (${s.status === 'published' ? 'aprovada' : s.status === 'rejected' ? 'rejeitada' : 'em análise'})`).join(' | ')}.`);
    }
    return lines.join('\n');
  }

  function buildMessages(assistant, kind, context, task) {
    const system = [
      LORE,
      '',
      `Você é "${assistant.name}", assistente do ${assistant.ministry_name}. Competência do ministério: ${assistant.mission}`,
      `Sua personalidade: ${assistant.persona || 'servidor público dedicado e formal.'}`,
      ...(assistant.context ? ['', `Diretrizes permanentes do Alto Comando para você (siga sempre): ${assistant.context}`] : []),
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

  // Sem tarefa explícita, usa a tarefa aberta mais antiga desse assistente (do mesmo tipo ou "qualquer").
  async function nextOpenTask(assistantId, kind) {
    const res = await pool.query(
      `SELECT * FROM assistant_tasks WHERE assistant_id = $1 AND status = 'open' AND kind IN ($2, 'any')
       ORDER BY created_at ASC LIMIT 1`,
      [assistantId, kind]
    );
    return res.rows[0] || null;
  }

  // Gera um texto com a IA e grava no feed. Lança erro se a IA falhar (sem texto de reserva).
  async function generateFor(assistant, kind, explicitTask) {
    const task = explicitTask === undefined ? await nextOpenTask(assistant.id, kind) : explicitTask;
    const context = await buildContext(assistant, kind);
    const { content, model } = await callOpenRouter(buildMessages(assistant, kind, context, task));
    const { title, body } = parseAiJson(content);
    const status = kind === 'post' ? 'published' : 'draft';
    const now = new Date().toISOString();
    const res = await pool.query(
      `INSERT INTO feed_posts (ministry_code, assistant_id, author_name, kind, title, body, status, ai_model, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [assistant.ministry_code, assistant.id, assistant.name, kind, title, body, status, model, status === 'published' ? now : null]
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

    const assistants = await pool.query('SELECT id, ministry_code, posts_per_day, suggestions_per_day FROM assistants WHERE enabled = 1');
    for (const a of assistants.rows) {
      const existing = await pool.query('SELECT COUNT(*) AS total FROM assistant_runs WHERE day = $1 AND assistant_id = $2', [day, a.id]);
      if (Number(existing.rows[0].total) > 0) continue;
      const plan = [
        ...Array(a.posts_per_day).fill('post'),
        ...Array(a.suggestions_per_day).fill('suggestion'),
      ];
      if (plan.length === 0) continue;
      if (windowStart >= windowEnd) {
        // Já passou do horário: registra o dia como sem rodadas para não reagendar a cada minuto
        await pool.query(
          `INSERT INTO assistant_runs (ministry_code, assistant_id, kind, day, scheduled_for, status, error)
           VALUES ($1, $2, 'post', $3, $4, 'skipped', 'Agenda criada fora do horário de trabalho')`,
          [a.ministry_code, a.id, day, now.toISOString()]
        );
        continue;
      }
      for (const kind of plan) {
        const minutes = windowStart + Math.floor(Math.random() * (windowEnd - windowStart));
        await pool.query(
          'INSERT INTO assistant_runs (ministry_code, assistant_id, kind, day, scheduled_for) VALUES ($1, $2, $3, $4, $5)',
          [a.ministry_code, a.id, kind, day, localTime(day, minutes).toISOString()]
        );
      }
    }
  }

  async function executeRun(run) {
    const assistant = run.assistant_id ? await loadAssistant(run.assistant_id) : null;
    if (!assistant || !assistant.enabled) {
      await pool.query("UPDATE assistant_runs SET status = 'skipped', error = 'Assistente desligado', ran_at = $1 WHERE id = $2", [new Date().toISOString(), run.id]);
      return;
    }
    await pool.query("UPDATE assistant_runs SET status = 'running' WHERE id = $1", [run.id]);
    try {
      const post = await generateFor(assistant, run.kind);
      await pool.query("UPDATE assistant_runs SET status = 'done', post_id = $1, ran_at = $2 WHERE id = $3", [post.id, new Date().toISOString(), run.id]);
      await audit(null, 'feed_posts', post.id, run.kind === 'post' ? 'assistant_post' : 'assistant_suggestion', {
        assistant: assistant.name, ministry: assistant.ministry_code, title: post.title, model: post.model, status: post.status,
      });
      console.log(`🤖 ${assistant.name}: ${run.kind === 'post' ? 'publicou' : 'sugeriu'} "${post.title}"`);
    } catch (err) {
      await pool.query("UPDATE assistant_runs SET status = 'failed', error = $1, ran_at = $2 WHERE id = $3", [err.message.slice(0, 500), new Date().toISOString(), run.id]);
      await audit(null, 'assistant_runs', run.id, 'assistant_failed', { assistant: assistant.name, ministry: assistant.ministry_code, kind: run.kind, error: err.message.slice(0, 500) });
      console.warn(`⚠️  ${assistant.name}: rodada pulada (${err.message})`);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await ready;
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
    await ready;
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

  // As rotas abaixo esperam a migração terminar (só importa no primeiro segundo após o boot)
  const awaitReady = (req, res, next) => { ready.then(() => next(), next); };
  app.use(['/api/feed', '/api/ministries', '/api/admin/feed', '/api/admin/suggestions', '/api/admin/assistants', '/api/admin/assistant-tasks', '/api/admin/assistants-settings'], awaitReady);

  // ------------------------------------------
  // Rotas: ministérios e Diário Oficial
  // ------------------------------------------
  const serializePost = (row, viewerId) => ({
    id: row.id,
    ministry_code: row.ministry_code,
    ministry_name: row.ministry_name,
    author_type: row.kind === 'citizen' ? 'citizen' : 'assistant',
    author: row.kind === 'citizen' ? (row.username || 'cidadão') : (row.assistant_name || row.ministry_name),
    author_title: row.kind === 'citizen' ? (row.user_title || null) : null,
    author_avatar: row.kind === 'citizen' ? (row.user_avatar || null) : null,
    mine: row.kind === 'citizen' && !!viewerId && row.user_id === viewerId,
    image_url: row.image_path ? `/api/feed-images/${row.image_path}` : null,
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
        `SELECT m.code, m.name, m.mission, m.sort_order,
                (SELECT COUNT(*) FROM assistants a WHERE a.ministry_code = m.code AND a.enabled = 1) AS active_assistants
         FROM ministries m ORDER BY m.sort_order ASC`
      );
      res.json(result.rows.map((m) => ({ ...m, active_assistants: Number(m.active_assistants) })));
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
      if (ministry === 'cidadaos') where += " AND fp.kind = 'citizen'";
      else if (ministry) { params.push(ministry); where += ` AND fp.ministry_code = $${params.length}`; }
      if (before) { params.push(before); where += ` AND fp.published_at < $${params.length}`; }
      params.push(limit);
      // Fixados aparecem só no topo da primeira página
      const order = before ? 'fp.published_at DESC' : 'fp.pinned DESC, fp.published_at DESC';
      const result = await pool.query(
        `SELECT fp.*, m.name AS ministry_name, fp.author_name AS assistant_name,
                u.username, u.avatar_url AS user_avatar, u.hierarchy_title AS user_title,
                (SELECT COUNT(*) FROM feed_reactions r WHERE r.post_id = fp.id) AS support_count,
                (SELECT COUNT(*) FROM feed_comments c WHERE c.post_id = fp.id) AS comment_count,
                EXISTS (SELECT 1 FROM feed_reactions r WHERE r.post_id = fp.id AND r.user_id = $1) AS supported_by_me
         FROM feed_posts fp
         LEFT JOIN ministries m ON m.code = fp.ministry_code
         LEFT JOIN users u ON u.id = fp.user_id
         WHERE ${where} ${before ? 'AND fp.pinned = 0' : ''}
         ORDER BY ${order}
         LIMIT $${params.length}`,
        params
      );
      const posts = result.rows.map((r) => serializePost(r, req.user.id));
      const lastUnpinned = [...posts].reverse().find((p) => !p.pinned);
      res.json({ posts, next_before: posts.length === limit && lastUnpinned ? lastUnpinned.published_at : null });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar o Diário Oficial: ' + err.message });
    }
  });

  // ------------------------------------------
  // Publicações dos cidadãos (texto e foto), sem limite por dia
  // ------------------------------------------
  const IMAGE_DIR = path.join(path.dirname(DB_PATH), 'uploads', 'feed');
  const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
  const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const IMAGE_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
  const POST_MAX = 2200;

  // Confere a assinatura do arquivo, não só o que o navegador disse
  function detectImageType(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
  }

  function saveImage(dataUrl) {
    const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
    if (!m) throw Object.assign(new Error('Formato de imagem inválido.'), { status: 400 });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > IMAGE_MAX_BYTES) throw Object.assign(new Error('A foto é grande demais (máximo 6 MB).'), { status: 400 });
    const type = detectImageType(buf);
    if (!type) throw Object.assign(new Error('Envie uma foto JPG, PNG ou WEBP.'), { status: 400 });
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const name = `${crypto.randomUUID()}.${IMAGE_TYPES[type]}`;
    fs.writeFileSync(path.join(IMAGE_DIR, name), buf);
    return name;
  }

  // Tira do disco a foto de uma publicação apagada
  function discardImage(name) {
    if (!name || !IMAGE_NAME.test(name)) return;
    fs.promises.rm(path.join(IMAGE_DIR, name), { force: true }).catch(() => {});
  }

  // Fotos servidas sem token (a tag <img> não manda cabeçalho); o nome é aleatório e não dá para listar
  app.get('/api/feed-images/:file', (req, res) => {
    const file = String(req.params.file);
    if (!IMAGE_NAME.test(file)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(path.join(IMAGE_DIR, file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  app.post('/api/feed', authenticateToken, async (req, res) => {
    const body = String((req.body && req.body.body) || '').trim();
    const image = req.body && req.body.image;
    if (!body && !image) return res.status(400).json({ error: 'Escreva algo ou escolha uma foto.' });
    if (body.length > POST_MAX) return res.status(400).json({ error: `A publicação pode ter no máximo ${POST_MAX} caracteres.` });
    let imageName = null;
    try {
      if (image) imageName = saveImage(image);
      const now = new Date().toISOString();
      const ins = await pool.query(
        `INSERT INTO feed_posts (user_id, kind, body, image_path, status, published_at)
         VALUES ($1, 'citizen', $2, $3, 'published', $4) RETURNING id`,
        [req.user.id, body, imageName, now]
      );
      const row = await pool.query(
        `SELECT fp.*, NULL AS ministry_name, NULL AS assistant_name, u.username, u.avatar_url AS user_avatar, u.hierarchy_title AS user_title,
                0 AS support_count, 0 AS comment_count, 0 AS supported_by_me
         FROM feed_posts fp JOIN users u ON u.id = fp.user_id WHERE fp.id = $1`,
        [ins.rows[0].id]
      );
      res.json({ success: true, post: serializePost(row.rows[0], req.user.id) });
    } catch (err) {
      discardImage(imageName);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro ao publicar: ' + err.message });
    }
  });

  // O autor apaga a própria publicação; o admin apaga qualquer uma
  app.delete('/api/feed/:id', authenticateToken, async (req, res) => {
    try {
      const found = await pool.query('SELECT id, user_id, kind, ministry_code, title, body, image_path FROM feed_posts WHERE id = $1', [req.params.id]);
      if (found.rows.length === 0) return res.status(404).json({ error: 'Publicação não encontrada.' });
      const post = found.rows[0];
      const isOwner = post.kind === 'citizen' && post.user_id === req.user.id;
      // 400 e não 403: o app desloga em qualquer 403
      if (!isOwner && req.user.role !== 'admin') return res.status(400).json({ error: 'Você só pode apagar as suas publicações.' });
      await pool.query('UPDATE assistant_runs SET post_id = NULL WHERE post_id = $1', [post.id]);
      await pool.query('UPDATE assistant_tasks SET post_id = NULL WHERE post_id = $1', [post.id]);
      await pool.query('DELETE FROM feed_posts WHERE id = $1', [post.id]);
      discardImage(post.image_path);
      if (!isOwner) {
        await audit(req.user.id, 'feed_posts', post.id, 'delete_post', { deleted: true }, {
          kind: post.kind, user_id: post.user_id, ministry: post.ministry_code, title: post.title, body: String(post.body).slice(0, 500),
        });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao apagar publicação: ' + err.message });
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
      const found = await pool.query('SELECT id, ministry_code, kind, title, status, user_id, image_path FROM feed_posts WHERE id = $1', [req.params.id]);
      if (found.rows.length === 0) return res.status(404).json({ error: 'Publicação não encontrada.' });
      await pool.query('UPDATE assistant_runs SET post_id = NULL WHERE post_id = $1', [req.params.id]);
      await pool.query('UPDATE assistant_tasks SET post_id = NULL WHERE post_id = $1', [req.params.id]);
      await pool.query('DELETE FROM feed_posts WHERE id = $1', [req.params.id]);
      discardImage(found.rows[0].image_path);
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
        `SELECT fp.*, m.name AS ministry_name, fp.author_name AS assistant_name, u.username AS reviewed_by_name
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

  const MAX_ASSISTANTS = 20;

  const assistantBody = (b, cur = {}) => {
    const text = (value, fallback, max) => (value === undefined ? fallback : String(value || '').trim().slice(0, max));
    return {
      name: text(b.name, cur.name, 120),
      ministry_code: b.ministry_code === undefined ? cur.ministry_code : String(b.ministry_code),
      persona: text(b.persona, cur.persona, 1000),
      context: text(b.context, cur.context, 3000) || null,
      enabled: b.enabled === undefined ? (cur.enabled === undefined ? 1 : cur.enabled) : (b.enabled ? 1 : 0),
      posts_per_day: b.posts_per_day === undefined ? (cur.posts_per_day ?? 3) : clampInt(b.posts_per_day, 0, 12, cur.posts_per_day ?? 3),
      suggestions_per_day: b.suggestions_per_day === undefined ? (cur.suggestions_per_day ?? 1) : clampInt(b.suggestions_per_day, 0, 6, cur.suggestions_per_day ?? 1),
    };
  };

  async function validateAssistant(next) {
    if (!next.name) return 'Dê um nome ao assistente.';
    if (!next.persona) return 'Descreva a personalidade do assistente.';
    const m = await pool.query('SELECT code FROM ministries WHERE code = $1', [next.ministry_code]);
    if (m.rows.length === 0) return 'Escolha um ministério válido.';
    return null;
  }

  app.get('/api/admin/assistants', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const { day } = localParts();
      const [ministries, assistants, runs, lastFailures, model, drafts, tasks] = await Promise.all([
        pool.query('SELECT code, name, mission FROM ministries ORDER BY sort_order ASC'),
        pool.query(`${ASSISTANT_SELECT} ORDER BY m.sort_order ASC, a.created_at ASC`),
        pool.query(
          `SELECT r.id, r.assistant_id, r.kind, r.scheduled_for, r.status, r.error, r.ran_at, fp.title AS post_title
           FROM assistant_runs r LEFT JOIN feed_posts fp ON fp.id = r.post_id
           WHERE r.day = $1 ORDER BY r.scheduled_for ASC`,
          [day]
        ),
        pool.query(
          `SELECT assistant_id, error, ran_at FROM assistant_runs
           WHERE status = 'failed' ORDER BY ran_at DESC LIMIT 50`
        ),
        getModelSetting(),
        pool.query("SELECT COUNT(*) AS total FROM feed_posts WHERE kind = 'suggestion' AND status = 'draft'"),
        pool.query(
          `SELECT t.*, fp.title AS post_title, fp.status AS post_status FROM assistant_tasks t
           LEFT JOIN feed_posts fp ON fp.id = t.post_id
           WHERE t.status = 'open' OR t.created_at >= $1
           ORDER BY t.created_at DESC LIMIT 300`,
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
        max_assistants: MAX_ASSISTANTS,
        ministries: ministries.rows,
        assistants: assistants.rows.map((a) => ({
          id: a.id,
          name: a.name,
          ministry_code: a.ministry_code,
          ministry_name: a.ministry_name,
          mission: a.mission,
          persona: a.persona,
          context: a.context || '',
          enabled: !!a.enabled,
          posts_per_day: a.posts_per_day,
          suggestions_per_day: a.suggestions_per_day,
          created_at: a.created_at,
          today: runs.rows.filter((r) => r.assistant_id === a.id && r.error !== 'Agenda criada fora do horário de trabalho'),
          last_failure: lastFailures.rows.find((f) => f.assistant_id === a.id) || null,
          tasks: tasks.rows.filter((t) => t.assistant_id === a.id),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar assistentes: ' + err.message });
    }
  });

  // Cria um assistente: não é usuário (sem login, sem carteira), só escreve em nome de um ministério
  app.post('/api/admin/assistants', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const count = await pool.query('SELECT COUNT(*) AS total FROM assistants');
      if (Number(count.rows[0].total) >= MAX_ASSISTANTS) {
        return res.status(400).json({ error: `Limite de ${MAX_ASSISTANTS} assistentes atingido (para não estourar a cota gratuita da IA).` });
      }
      const next = assistantBody(req.body || {});
      const invalid = await validateAssistant(next);
      if (invalid) return res.status(400).json({ error: invalid });
      const ins = await pool.query(
        `INSERT INTO assistants (ministry_code, name, persona, context, enabled, posts_per_day, suggestions_per_day, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [next.ministry_code, next.name, next.persona, next.context, next.enabled, next.posts_per_day, next.suggestions_per_day, req.user.id]
      );
      await audit(req.user.id, 'assistants', ins.rows[0].id, 'create_assistant', next);
      res.json({ success: true, id: ins.rows[0].id });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao criar assistente: ' + err.message });
    }
  });

  app.put('/api/admin/assistants/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM assistants WHERE id = $1', [req.params.id]);
      if (found.rows.length === 0) return res.status(404).json({ error: 'Assistente não encontrado.' });
      const cur = found.rows[0];
      const next = assistantBody(req.body || {}, cur);
      const invalid = await validateAssistant(next);
      if (invalid) return res.status(400).json({ error: invalid });
      await pool.query(
        `UPDATE assistants SET ministry_code = $1, name = $2, persona = $3, context = $4, enabled = $5,
                posts_per_day = $6, suggestions_per_day = $7 WHERE id = $8`,
        [next.ministry_code, next.name, next.persona, next.context, next.enabled, next.posts_per_day, next.suggestions_per_day, req.params.id]
      );
      // Desligar cancela as rodadas que ainda iam acontecer hoje
      if (!next.enabled) {
        await pool.query("UPDATE assistant_runs SET status = 'skipped', error = 'Assistente desligado' WHERE assistant_id = $1 AND status = 'pending'", [req.params.id]);
      } else if (next.ministry_code !== cur.ministry_code) {
        await pool.query('UPDATE assistant_runs SET ministry_code = $1 WHERE assistant_id = $2 AND status = $3', [next.ministry_code, req.params.id, 'pending']);
      }
      const { created_by, created_at, id, ...old } = cur;
      await audit(req.user.id, 'assistants', req.params.id, 'update_assistant', next, old);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao salvar assistente: ' + err.message });
    }
  });

  // Excluir mantém as publicações já feitas (com o nome do assistente) e cancela agenda e tarefas
  app.delete('/api/admin/assistants/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM assistants WHERE id = $1', [req.params.id]);
      if (found.rows.length === 0) return res.status(404).json({ error: 'Assistente não encontrado.' });
      await pool.query('UPDATE feed_posts SET assistant_id = NULL WHERE assistant_id = $1', [req.params.id]);
      await pool.query('DELETE FROM assistant_runs WHERE assistant_id = $1', [req.params.id]);
      await pool.query('DELETE FROM assistant_tasks WHERE assistant_id = $1', [req.params.id]);
      await pool.query('DELETE FROM assistants WHERE id = $1', [req.params.id]);
      const { created_by, created_at, ...old } = found.rows[0];
      await audit(req.user.id, 'assistants', req.params.id, 'delete_assistant', { deleted: true }, old);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao excluir assistente: ' + err.message });
    }
  });

  // Tarefas: o admin direciona um assistente; a próxima rodada dele cumpre a tarefa
  app.post('/api/admin/assistant-tasks', authenticateToken, requireRole(['admin']), async (req, res) => {
    const b = req.body || {};
    const instructions = String(b.instructions || '').trim().slice(0, 2000);
    const kind = ['any', 'post', 'suggestion'].includes(b.kind) ? b.kind : 'any';
    if (!instructions) return res.status(400).json({ error: 'Descreva a tarefa.' });
    try {
      const assistant = await loadAssistant(b.assistant_id);
      if (!assistant) return res.status(404).json({ error: 'Assistente não encontrado.' });
      const ins = await pool.query(
        'INSERT INTO assistant_tasks (ministry_code, assistant_id, kind, instructions, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [assistant.ministry_code, assistant.id, kind, instructions, req.user.id]
      );
      await audit(req.user.id, 'assistant_tasks', ins.rows[0].id, 'create_task', { assistant: assistant.name, kind, instructions });
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
      const assistant = await loadAssistant(task.assistant_id);
      if (!assistant) return res.status(404).json({ error: 'Assistente não encontrado.' });
      const kind = task.kind === 'suggestion' ? 'suggestion' : 'post';
      const post = await generateFor(assistant, kind, task);
      await audit(req.user.id, 'feed_posts', post.id, kind === 'post' ? 'assistant_post_manual' : 'assistant_suggestion_manual', {
        assistant: assistant.name, title: post.title, model: post.model, status: post.status, task_id: task.id,
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
  app.post('/api/admin/assistants/:id/run', authenticateToken, requireRole(['admin']), async (req, res) => {
    const kind = req.body && req.body.kind === 'suggestion' ? 'suggestion' : 'post';
    try {
      const assistant = await loadAssistant(req.params.id);
      if (!assistant) return res.status(404).json({ error: 'Assistente não encontrado.' });
      const post = await generateFor(assistant, kind);
      await audit(req.user.id, 'feed_posts', post.id, kind === 'post' ? 'assistant_post_manual' : 'assistant_suggestion_manual', {
        assistant: assistant.name, title: post.title, model: post.model, status: post.status,
      });
      res.json({ success: true, post });
    } catch (err) {
      await audit(req.user.id, 'assistants', req.params.id, 'assistant_failed', { kind, error: err.message.slice(0, 500), manual: true });
      res.status(502).json({ error: err.message });
    }
  });

  // Usado pelos jogos (jogos.js): mesma IA, auditoria e assistentes
  return {
    startScheduler,
    ready,
    audit,
    callOpenRouter,
    loadAssistant,
    LORE,
    localParts,
    localTime,
  };
}

module.exports = { createMinisterios };
