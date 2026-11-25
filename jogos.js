// ==========================================
// JOGOS: missões diárias, quiz da Constituição, despacho de processos e memória dos emblemas
// ==========================================
// - Missões diárias: os assistentes propõem, o admin aprova e o servidor sorteia até 3 por dia.
//   O progresso vem do que o cidadão já faz no app (apoiar, comentar, publicar, jogar).
// - Quiz da Constituição: o assistente da Educação escreve perguntas com base nos fatos oficiais
//   do Estado (faixas, eventos cívicos, ministérios). O admin revisa. O celular guarda o banco de
//   perguntas e joga offline; as respostas sincronizam depois, com limite de pontos por dia.
// - Despacho de processos: Defesa e Verdade escrevem casos fictícios; o cidadão defere ou
//   indefere dentro do tempo. Precisa de internet (o tempo é conferido no servidor).
// - Memória dos emblemas: 100% no aparelho, sem IA. Só a pontuação sincroniza.
// Nada de texto pronto de reserva: sem IA, os jogos esperam conteúdo novo (a memória sempre funciona).

const crypto = require('crypto');

const GEN_TICK_MS = 10 * 60 * 1000;
const GEN_MAX_PER_DAY = 12; // chamadas automáticas por dia (modelos gratuitos têm limite)
const GEN_BACKOFF_MS = 30 * 60 * 1000;

const MISSIONS_PER_DAY = 3;
const QUIZ_POINTS = 5;
const QUIZ_DAILY_CAP = 10; // acertos que rendem pontos por dia
const CASE_POINTS = 8;
const CASE_DAILY_CAP = 10; // processos por dia
const CASE_SECONDS = 45;
const CASE_GRACE_MS = 4000; // rede lenta
const MEMORY_POINTS = 10;
const MEMORY_DAILY_CAP = 3;
const OFFLINE_MAX_AGE_DAYS = 7;

// Ação da missão: limites de quantidade e pontos por unidade
const MISSION_ACTIONS = {
  apoiar: { label: 'apoiar publicações no Diário Oficial', min: 1, max: 5, per: 4 },
  comentar: { label: 'comentar publicações no Diário Oficial', min: 1, max: 3, per: 8 },
  publicar: { label: 'fazer uma publicação no Diário Oficial', min: 1, max: 1, per: 20 },
  quiz: { label: 'responder perguntas do Quiz da Constituição', min: 3, max: 10, per: 3 },
  despacho: { label: 'despachar processos no Despacho de processos', min: 1, max: 5, per: 6 },
  memoria: { label: 'completar partidas da Memória dos emblemas', min: 1, max: 2, per: 12 },
};

const SCORE_CODES = { missao: 'jogo_missao', quiz: 'jogo_quiz', despacho: 'jogo_despacho', memoria: 'jogo_memoria' };

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseJsonBlock(content) {
  const cleaned = String(content).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('A IA não respondeu no formato esperado (JSON).');
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    throw new Error('A IA respondeu um JSON inválido.');
  }
}

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function createJogos({ app, pool, authenticateToken, requireRole, applyScoreChange, ministerios }) {
  const { audit, callOpenRouter, LORE, localParts, localTime } = ministerios;

  const today = () => localParts().day;
  const dayStartIso = (day = today()) => localTime(day, 0).toISOString();

  // ------------------------------------------
  // Pontos: um evento cívico aprovado + recálculo da carteira
  // ------------------------------------------
  async function grantPoints(client, userId, game, points, description) {
    if (!points) return null;
    const type = await client.query('SELECT id FROM score_event_types WHERE code = $1 AND active = 1', [SCORE_CODES[game]]);
    const account = await client.query('SELECT 1 AS ok FROM score_accounts WHERE user_id = $1', [userId]);
    if (!type.rows.length || !account.rows.length) return null; // admin sem carteira joga sem pontos
    await client.query(
      `INSERT INTO score_events (user_id, event_type_id, points_delta, description, status, approved_by)
       VALUES ($1, $2, $3, $4, 'approved', NULL)`,
      [userId, type.rows[0].id, points, description]
    );
    const change = await applyScoreChange(client, userId, points, null);
    return { points, new_score: change.newScore, unlocked_certificates: change.unlockedCerts };
  }

  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Dia (Brasília) de algo feito offline; datas absurdas viram hoje
  function dayOf(isoString) {
    const t = Date.parse(isoString);
    const now = Date.now();
    if (Number.isNaN(t) || t > now + 5 * 60 * 1000 || t < now - OFFLINE_MAX_AGE_DAYS * 86400000) return today();
    return localParts(new Date(t)).day;
  }

  // ------------------------------------------
  // Assistentes que escrevem para os jogos
  // ------------------------------------------
  async function pickAssistant(ministryCodes) {
    const params = [];
    let where = 'a.enabled = 1';
    if (ministryCodes) {
      where += ` AND a.ministry_code IN (${ministryCodes.map((c) => { params.push(c); return `$${params.length}`; }).join(', ')})`;
    }
    const res = await pool.query(
      `SELECT a.*, m.name AS ministry_name, m.mission FROM assistants a JOIN ministries m ON m.code = a.ministry_code WHERE ${where}`,
      params
    );
    if (!res.rows.length) return null;
    return res.rows[Math.floor(Math.random() * res.rows.length)];
  }

  function systemFor(assistant) {
    return [
      LORE,
      '',
      `Você é "${assistant.name}", assistente do ${assistant.ministry_name}. Competência do ministério: ${assistant.mission}`,
      `Sua personalidade: ${assistant.persona || 'servidor público dedicado e formal.'}`,
      ...(assistant.context ? ['', `Diretrizes permanentes do Alto Comando para você (siga sempre): ${assistant.context}`] : []),
    ].join('\n');
  }

  // Fatos oficiais do Estado, tirados do banco: base do quiz (assim as perguntas têm resposta certa)
  async function officialFacts() {
    const [tiers, events, ministries] = await Promise.all([
      pool.query('SELECT name, min_score, max_score, description, privileges FROM score_tiers ORDER BY min_score'),
      pool.query("SELECT name, category, points_delta, requires_approval FROM score_event_types WHERE active = 1 AND code NOT LIKE 'jogo_%' ORDER BY category, points_delta DESC"),
      pool.query('SELECT name, mission FROM ministries ORDER BY sort_order'),
    ]);
    return [
      'Lema nacional: "Soberania, Ordem e Prosperidade". O Estado é dirigido pelo Líder Supremo e pelo Alto Comando.',
      'Todo cidadão tem uma carteira cívica com pontuação de 0 a 10.000; começa em 5.000.',
      'Faixas de lealdade cívica:',
      ...tiers.rows.map((t) => `- ${t.name}: de ${t.min_score} a ${t.max_score} pontos. ${t.description || ''} Privilégios/restrições: ${t.privileges || '-'}`),
      'Eventos cívicos (pontos que somam ou tiram da carteira):',
      ...events.rows.map((e) => `- ${e.name}: ${e.points_delta > 0 ? '+' : ''}${e.points_delta} pontos${e.requires_approval ? ' (exige aprovação)' : ''}`),
      'Ministérios:',
      ...ministries.rows.map((m) => `- ${m.name}: ${m.mission}`),
      'Outros órgãos: Banco Central Democrata (autoridade monetária) e Serviço de Inteligência do Estado.',
    ].join('\n');
  }

  // ------------------------------------------
  // Geração com IA
  // ------------------------------------------
  const genState = { day: null, calls: 0, lastFailAt: 0, lastFailure: null, running: false };

  async function generateMissions() {
    const assistant = await pickAssistant(null);
    if (!assistant) throw new Error('Nenhum assistente ativo para propor missões.');
    const actions = Object.entries(MISSION_ACTIONS).map(([k, v]) => `- "${k}": ${v.label} (quantidade de ${v.min} a ${v.max})`).join('\n');
    const recent = await pool.query("SELECT title FROM game_missions WHERE status <> 'rejected' ORDER BY created_at DESC LIMIT 15");
    const user = [
      'Proponha 3 missões diárias para os cidadãos cumprirem dentro do app ILC, com o tom do seu ministério.',
      'Cada missão usa exatamente UMA destas ações (use a chave entre aspas):',
      actions,
      'Use ações diferentes nas 3 missões. Título curto e chamativo (até 60 caracteres); descrição de uma ou duas frases dizendo o que fazer e por que isso serve à Pátria.',
      ...(recent.rows.length ? ['Não repita estas missões já existentes:', ...recent.rows.map((r) => `- ${r.title}`)] : []),
      'Responda SOMENTE com JSON válido: {"missoes": [{"acao": "apoiar", "quantidade": 3, "titulo": "...", "descricao": "..."}]}',
    ].join('\n');
    const { content } = await callOpenRouter([{ role: 'system', content: systemFor(assistant) }, { role: 'user', content: user }], { maxTokens: 900 });
    const data = parseJsonBlock(content);
    const list = Array.isArray(data.missoes) ? data.missoes : [];
    let saved = 0;
    for (const m of list.slice(0, 5)) {
      const action = String(m.acao || '').toLowerCase().trim();
      const spec = MISSION_ACTIONS[action];
      const title = clip(m.titulo, 80);
      if (!spec || !title) continue;
      const target = Math.max(spec.min, Math.min(spec.max, parseInt(m.quantidade, 10) || spec.min));
      const points = Math.max(10, Math.min(50, spec.per * target));
      await pool.query(
        `INSERT INTO game_missions (assistant_id, ministry_code, author_name, title, description, action, target, points)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [assistant.id, assistant.ministry_code, assistant.name, title, clip(m.descricao, 300), action, target, points]
      );
      saved++;
    }
    if (!saved) throw new Error('A IA não propôs nenhuma missão válida.');
    return { saved, assistant: assistant.name };
  }

  async function generateQuiz() {
    const assistant = await pickAssistant(['educacao']);
    if (!assistant) throw new Error('Crie ou ative um assistente do Ministério da Educação para escrever o quiz.');
    const facts = await officialFacts();
    const recent = await pool.query("SELECT question FROM game_quiz_questions WHERE status <> 'rejected' ORDER BY created_at DESC LIMIT 40");
    const user = [
      'Escreva 5 perguntas de múltipla escolha para o "Quiz da Constituição" do app.',
      'Use SOMENTE os fatos oficiais abaixo (eles são a Constituição Cívica do Estado). Toda pergunta precisa ter resposta certa comprovável por esses fatos.',
      '',
      facts,
      '',
      'Cada pergunta tem 4 alternativas curtas, só uma correta, e uma explicação de uma frase citando o fato. Varie os temas (faixas, pontos de eventos, ministérios, lema).',
      ...(recent.rows.length ? ['Não repita estas perguntas já existentes:', ...recent.rows.map((r) => `- ${r.question}`)] : []),
      'Responda SOMENTE com JSON válido: {"perguntas": [{"pergunta": "...", "alternativas": ["...", "...", "...", "..."], "correta": 0, "explicacao": "..."}]} (correta = índice de 0 a 3)',
    ].join('\n');
    const { content } = await callOpenRouter([{ role: 'system', content: systemFor(assistant) }, { role: 'user', content: user }], { maxTokens: 1600, temperature: 0.7 });
    const data = parseJsonBlock(content);
    const list = Array.isArray(data.perguntas) ? data.perguntas : [];
    let saved = 0;
    for (const q of list.slice(0, 8)) {
      const question = clip(q.pergunta, 300);
      const options = Array.isArray(q.alternativas) ? q.alternativas.map((o) => clip(o, 140)).filter(Boolean) : [];
      const correct = parseInt(q.correta, 10);
      if (!question || options.length !== 4 || !(correct >= 0 && correct < 4) || new Set(options).size !== 4) continue;
      // Embaralha para a certa não ficar sempre na mesma posição
      const order = shuffle([0, 1, 2, 3]);
      await pool.query(
        `INSERT INTO game_quiz_questions (assistant_id, author_name, question, options, correct_index, explanation)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [assistant.id, assistant.name, question, JSON.stringify(order.map((i) => options[i])), order.indexOf(correct), clip(q.explicacao, 400)]
      );
      saved++;
    }
    if (!saved) throw new Error('A IA não escreveu nenhuma pergunta válida.');
    return { saved, assistant: assistant.name };
  }

  async function generateCases() {
    // Alterna entre Defesa e Verdade pelo que tem menos processos
    const counts = await pool.query("SELECT ministry_code, COUNT(*) AS total FROM game_cases WHERE status <> 'rejected' GROUP BY ministry_code");
    const byCode = Object.fromEntries(counts.rows.map((r) => [r.ministry_code, Number(r.total)]));
    const order = ['defesa', 'verdade'].sort((a, b) => (byCode[a] || 0) - (byCode[b] || 0));
    let assistant = await pickAssistant([order[0]]);
    if (!assistant) assistant = await pickAssistant([order[1]]);
    if (!assistant) throw new Error('Crie ou ative um assistente da Defesa ou da Verdade para escrever processos.');
    const recent = await pool.query("SELECT title FROM game_cases WHERE status <> 'rejected' ORDER BY created_at DESC LIMIT 20");
    const user = [
      `Escreva 3 processos administrativos fictícios que chegaram à mesa do ${assistant.ministry_name} e que um cidadão-despachante vai deferir ou indeferir em 45 segundos.`,
      'Cada processo: título curto (até 70 caracteres), resumo de 35 a 80 palavras com quem pede, o quê e por quê (pessoas e lugares inventados, sem nomes reais).',
      'A decisão correta segue a doutrina do Estado e a competência do ministério, e precisa ser deduzível pelo resumo. Misture deferimentos e indeferimentos.',
      'Inclua a justificativa oficial da decisão em uma frase.',
      ...(recent.rows.length ? ['Não repita estes processos já existentes:', ...recent.rows.map((r) => `- ${r.title}`)] : []),
      'Responda SOMENTE com JSON válido: {"processos": [{"titulo": "...", "resumo": "...", "decisao": "deferir", "justificativa": "..."}]} (decisao = "deferir" ou "indeferir")',
    ].join('\n');
    const { content } = await callOpenRouter([{ role: 'system', content: systemFor(assistant) }, { role: 'user', content: user }], { maxTokens: 1400 });
    const data = parseJsonBlock(content);
    const list = Array.isArray(data.processos) ? data.processos : [];
    let saved = 0;
    for (const c of list.slice(0, 5)) {
      const title = clip(c.titulo, 100);
      const summary = clip(c.resumo, 900);
      const decision = String(c.decisao || '').toLowerCase().trim();
      if (!title || !summary || !['deferir', 'indeferir'].includes(decision)) continue;
      await pool.query(
        `INSERT INTO game_cases (assistant_id, ministry_code, author_name, title, summary, correct_decision, rationale)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [assistant.id, assistant.ministry_code, assistant.name, title, summary, decision, clip(c.justificativa, 400)]
      );
      saved++;
    }
    if (!saved) throw new Error('A IA não escreveu nenhum processo válido.');
    return { saved, assistant: assistant.name };
  }

  const GENERATORS = { missions: generateMissions, quiz: generateQuiz, cases: generateCases };
  const GEN_LABEL = { missions: 'missões', quiz: 'perguntas do quiz', cases: 'processos' };

  async function runGeneration(kind, actorId = null) {
    try {
      const out = await GENERATORS[kind]();
      await audit(actorId, 'games', kind, 'generate_game_content', out);
      return out;
    } catch (err) {
      genState.lastFailAt = Date.now();
      genState.lastFailure = { at: new Date().toISOString(), kind, error: err.message };
      await audit(actorId, 'games', kind, 'generate_game_content_failed', { error: err.message });
      throw err;
    }
  }

  // Quanto falta em cada banco de conteúdo
  async function stock() {
    const [m, q, c] = await Promise.all([
      pool.query(`SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                         SUM(CASE WHEN status = 'approved' AND day IS NULL THEN 1 ELSE 0 END) AS ready,
                         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
                  FROM game_missions`),
      pool.query(`SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved FROM game_quiz_questions`),
      pool.query(`SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved FROM game_cases`),
    ]);
    const n = (v) => Number(v || 0);
    return {
      missions: { pending: n(m.rows[0].pending), ready: n(m.rows[0].ready), approved: n(m.rows[0].approved) },
      quiz: { pending: n(q.rows[0].pending), approved: n(q.rows[0].approved) },
      cases: { pending: n(c.rows[0].pending), approved: n(c.rows[0].approved) },
    };
  }

  // A cada 10 min (7h–22h): completa o banco que estiver mais vazio. Uma chamada por vez.
  async function genTick() {
    if (genState.running || !process.env.OPENROUTER_API_KEY) return;
    const { day, hour } = localParts();
    if (hour < 7 || hour >= 22) return;
    if (genState.day !== day) { genState.day = day; genState.calls = 0; }
    if (genState.calls >= GEN_MAX_PER_DAY || Date.now() - genState.lastFailAt < GEN_BACKOFF_MS) return;
    const s = await stock();
    let kind = null;
    if (s.missions.ready + s.missions.pending < 6 && s.missions.pending < 6) kind = 'missions';
    else if (s.quiz.approved + s.quiz.pending < 40 && s.quiz.pending < 10) kind = 'quiz';
    else if (s.cases.approved + s.cases.pending < 30 && s.cases.pending < 9) kind = 'cases';
    if (!kind) return;
    genState.running = true;
    genState.calls++;
    try {
      const out = await runGeneration(kind);
      console.log(`🎮 ${out.assistant} escreveu ${out.saved} ${GEN_LABEL[kind]} para revisão.`);
    } catch (err) {
      console.error(`🎮 Falha ao gerar ${GEN_LABEL[kind]}:`, err.message);
    } finally {
      genState.running = false;
    }
  }

  async function startGenerator() {
    await ministerios.ready;
    if (process.env.ASSISTANTS_DISABLED === 'true') return;
    setTimeout(() => genTick().catch(() => {}), 90 * 1000);
    setInterval(() => genTick().catch((err) => console.error('🎮 Erro no gerador dos jogos:', err.message)), GEN_TICK_MS);
  }

  // ------------------------------------------
  // Missões do dia
  // ------------------------------------------
  async function ensureTodayMissions() {
    const day = today();
    const existing = await pool.query("SELECT COUNT(*) AS total FROM game_missions WHERE day = $1 AND status = 'approved'", [day]);
    if (Number(existing.rows[0].total) > 0) return;
    // Sorteia até 3 aprovadas que ainda não foram usadas, de ações diferentes
    const pool_ = await pool.query("SELECT id, action FROM game_missions WHERE status = 'approved' AND day IS NULL ORDER BY created_at");
    const chosen = [];
    const used = new Set();
    for (const m of shuffle(pool_.rows)) {
      if (chosen.length >= MISSIONS_PER_DAY) break;
      if (used.has(m.action)) continue;
      used.add(m.action);
      chosen.push(m.id);
    }
    for (const id of chosen) {
      await pool.query('UPDATE game_missions SET day = $1 WHERE id = $2 AND day IS NULL', [day, id]);
    }
  }

  async function progressFor(userId, action, day, db = pool) {
    const since = dayStartIso(day);
    const queries = {
      apoiar: ['SELECT COUNT(*) AS n FROM feed_reactions WHERE user_id = $1 AND created_at >= $2', [userId, since]],
      comentar: ['SELECT COUNT(*) AS n FROM feed_comments WHERE user_id = $1 AND created_at >= $2', [userId, since]],
      publicar: ["SELECT COUNT(*) AS n FROM feed_posts WHERE user_id = $1 AND kind = 'citizen' AND created_at >= $2", [userId, since]],
      quiz: ["SELECT COUNT(*) AS n FROM game_plays WHERE user_id = $1 AND game = 'quiz' AND day = $2", [userId, day]],
      despacho: ["SELECT COUNT(*) AS n FROM game_plays WHERE user_id = $1 AND game = 'despacho' AND status = 'done' AND day = $2", [userId, day]],
      memoria: ["SELECT COUNT(*) AS n FROM game_plays WHERE user_id = $1 AND game = 'memoria' AND day = $2", [userId, day]],
    };
    const [sql, params] = queries[action];
    const res = await db.query(sql, params);
    return Number(res.rows[0].n);
  }

  async function missionsFor(userId) {
    await ensureTodayMissions();
    const day = today();
    const res = await pool.query(
      `SELECT gm.*, m.name AS ministry_name, c.claimed_at
       FROM game_missions gm
       LEFT JOIN ministries m ON m.code = gm.ministry_code
       LEFT JOIN game_mission_claims c ON c.mission_id = gm.id AND c.user_id = $1
       WHERE gm.day = $2 AND gm.status = 'approved' ORDER BY gm.points`,
      [userId, day]
    );
    const out = [];
    for (const m of res.rows) {
      const progress = await progressFor(userId, m.action, day);
      out.push({
        id: m.id,
        title: m.title,
        description: m.description,
        action: m.action,
        target: m.target,
        points: m.points,
        progress: Math.min(progress, m.target),
        done: progress >= m.target,
        claimed: !!m.claimed_at,
        ministry_code: m.ministry_code,
        ministry_name: m.ministry_name,
        author: m.author_name,
      });
    }
    return out;
  }

  // ------------------------------------------
  // Rotas do cidadão
  // ------------------------------------------
  const awaitReady = (req, res, next) => { ministerios.ready.then(() => next(), next); };
  app.use(['/api/games', '/api/admin/games'], awaitReady);

  // Painel inicial dos jogos: missões, limites do dia e quanto conteúdo existe
  app.get('/api/games', authenticateToken, async (req, res) => {
    try {
      const day = today();
      const [missions, plays, s] = await Promise.all([
        missionsFor(req.user.id),
        pool.query(
          `SELECT game, COUNT(*) AS total, SUM(CASE WHEN points > 0 THEN 1 ELSE 0 END) AS rewarded, COALESCE(SUM(points), 0) AS points
           FROM game_plays WHERE user_id = $1 AND day = $2 AND status <> 'served' GROUP BY game`,
          [req.user.id, day]
        ),
        stock(),
      ]);
      const byGame = Object.fromEntries(plays.rows.map((r) => [r.game, { total: Number(r.total), rewarded: Number(r.rewarded), points: Number(r.points) }]));
      const g = (k) => byGame[k] || { total: 0, rewarded: 0, points: 0 };
      res.json({
        day,
        missions,
        quiz: { ...g('quiz'), cap: QUIZ_DAILY_CAP, points_each: QUIZ_POINTS, available: s.quiz.approved },
        despacho: { ...g('despacho'), cap: CASE_DAILY_CAP, points_each: CASE_POINTS, seconds: CASE_SECONDS, available: s.cases.approved },
        memoria: { ...g('memoria'), cap: MEMORY_DAILY_CAP, points_each: MEMORY_POINTS },
      });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar os jogos: ' + err.message });
    }
  });

  app.post('/api/games/missions/:id/claim', authenticateToken, async (req, res) => {
    try {
      const out = await withTx(async (client) => {
        const found = await client.query("SELECT * FROM game_missions WHERE id = $1 AND status = 'approved' AND day = $2", [req.params.id, today()]);
        if (!found.rows.length) return { status: 404, error: 'Esta missão não vale mais hoje.' };
        const m = found.rows[0];
        const already = await client.query('SELECT 1 AS ok FROM game_mission_claims WHERE mission_id = $1 AND user_id = $2', [m.id, req.user.id]);
        if (already.rows.length) return { status: 400, error: 'Você já resgatou esta missão.' };
        const progress = await progressFor(req.user.id, m.action, m.day, client);
        if (progress < m.target) return { status: 400, error: `Falta pouco: ${progress} de ${m.target}.` };
        await client.query('INSERT INTO game_mission_claims (mission_id, user_id, points) VALUES ($1, $2, $3)', [m.id, req.user.id, m.points]);
        const reward = await grantPoints(client, req.user.id, 'missao', m.points, `Missão diária: ${m.title}`);
        return { reward };
      });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ success: true, reward: out.reward });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao resgatar a missão: ' + err.message });
    }
  });

  // Banco de perguntas aprovadas: o celular guarda e joga offline
  app.get('/api/games/quiz/bank', authenticateToken, async (req, res) => {
    try {
      const [questions, rewarded] = await Promise.all([
        pool.query("SELECT id, question, options, correct_index, explanation FROM game_quiz_questions WHERE status = 'approved' ORDER BY created_at"),
        pool.query("SELECT DISTINCT ref_id FROM game_plays WHERE user_id = $1 AND game = 'quiz' AND correct = 1", [req.user.id]),
      ]);
      res.json({
        questions: questions.rows.map((q) => ({ ...q, options: JSON.parse(q.options) })),
        answered_ids: rewarded.rows.map((r) => r.ref_id),
        cap: QUIZ_DAILY_CAP,
        points_each: QUIZ_POINTS,
        synced_at: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar o quiz: ' + err.message });
    }
  });

  // Respostas feitas offline. Cada acerto inédito rende pontos, até o limite do dia em que foi respondido.
  app.post('/api/games/quiz/sync', authenticateToken, async (req, res) => {
    const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers.slice(0, 200) : [];
    try {
      const out = await withTx(async (client) => {
        let accepted = 0;
        let points = 0;
        let correctCount = 0;
        const rewardedByDay = {};
        for (const a of answers) {
          const clientId = clip(a.client_id, 64);
          if (!clientId) continue;
          const dup = await client.query("SELECT 1 AS ok FROM game_plays WHERE user_id = $1 AND game = 'quiz' AND client_id = $2", [req.user.id, clientId]);
          if (dup.rows.length) { accepted++; continue; } // já sincronizada antes
          const q = await client.query("SELECT id, correct_index FROM game_quiz_questions WHERE id = $1 AND status = 'approved'", [a.question_id]);
          if (!q.rows.length) continue;
          const day = dayOf(a.answered_at);
          const correct = parseInt(a.chosen, 10) === q.rows[0].correct_index ? 1 : 0;
          let pts = 0;
          if (correct) {
            correctCount++;
            const before = await client.query(
              "SELECT 1 AS ok FROM game_plays WHERE user_id = $1 AND game = 'quiz' AND ref_id = $2 AND correct = 1", [req.user.id, q.rows[0].id]
            );
            if (rewardedByDay[day] === undefined) {
              const cnt = await client.query(
                "SELECT COUNT(*) AS n FROM game_plays WHERE user_id = $1 AND game = 'quiz' AND day = $2 AND points > 0", [req.user.id, day]
              );
              rewardedByDay[day] = Number(cnt.rows[0].n);
            }
            if (!before.rows.length && rewardedByDay[day] < QUIZ_DAILY_CAP) {
              pts = QUIZ_POINTS;
              rewardedByDay[day]++;
            }
          }
          await client.query(
            `INSERT INTO game_plays (user_id, game, ref_id, client_id, day, status, correct, points, served_at)
             VALUES ($1, 'quiz', $2, $3, $4, 'done', $5, $6, $7)`,
            [req.user.id, q.rows[0].id, clientId, day, correct, pts, clip(a.answered_at, 40) || null]
          );
          accepted++;
          points += pts;
        }
        const reward = await grantPoints(client, req.user.id, 'quiz', points, `Quiz da Constituição: ${correctCount} acerto(s)`);
        return { accepted, points, reward };
      });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao sincronizar o quiz: ' + err.message });
    }
  });

  // Despacho: um processo por vez, com o relógio no servidor
  async function expireOldCases(userId) {
    const limit = new Date(Date.now() - CASE_SECONDS * 1000 - CASE_GRACE_MS).toISOString();
    await pool.query(
      "UPDATE game_plays SET status = 'expired' WHERE user_id = $1 AND game = 'despacho' AND status = 'served' AND served_at < $2",
      [userId, limit]
    );
  }

  function caseView(row, play) {
    const elapsed = (Date.now() - Date.parse(play.served_at)) / 1000;
    return {
      play_id: play.id,
      seconds: CASE_SECONDS,
      remaining: Math.max(0, Math.round(CASE_SECONDS - elapsed)),
      case: {
        id: row.id,
        title: row.title,
        summary: row.summary,
        ministry_code: row.ministry_code,
        ministry_name: row.ministry_name,
        author: row.author_name,
      },
    };
  }

  app.post('/api/games/despacho/next', authenticateToken, async (req, res) => {
    try {
      await expireOldCases(req.user.id);
      const day = today();
      const open = await pool.query(
        `SELECT gp.*, gc.title, gc.summary, gc.ministry_code, gc.author_name, m.name AS ministry_name
         FROM game_plays gp JOIN game_cases gc ON gc.id = gp.ref_id LEFT JOIN ministries m ON m.code = gc.ministry_code
         WHERE gp.user_id = $1 AND gp.game = 'despacho' AND gp.status = 'served' ORDER BY gp.served_at LIMIT 1`,
        [req.user.id]
      );
      if (open.rows.length) {
        const r = open.rows[0];
        return res.json(caseView({ id: r.ref_id, title: r.title, summary: r.summary, ministry_code: r.ministry_code, ministry_name: r.ministry_name, author_name: r.author_name }, r));
      }
      const done = await pool.query("SELECT COUNT(*) AS n FROM game_plays WHERE user_id = $1 AND game = 'despacho' AND day = $2", [req.user.id, day]);
      if (Number(done.rows[0].n) >= CASE_DAILY_CAP) return res.json({ finished: true, reason: 'limit' });
      const next = await pool.query(
        `SELECT gc.*, m.name AS ministry_name FROM game_cases gc LEFT JOIN ministries m ON m.code = gc.ministry_code
         WHERE gc.status = 'approved' AND gc.id NOT IN (SELECT ref_id FROM game_plays WHERE user_id = $1 AND game = 'despacho')
         ORDER BY RANDOM() LIMIT 1`,
        [req.user.id]
      );
      if (!next.rows.length) return res.json({ finished: true, reason: 'empty' });
      const servedAt = new Date().toISOString();
      const ins = await pool.query(
        `INSERT INTO game_plays (user_id, game, ref_id, client_id, day, status, served_at)
         VALUES ($1, 'despacho', $2, $3, $4, 'served', $5) RETURNING id, served_at`,
        [req.user.id, next.rows[0].id, crypto.randomUUID(), day, servedAt]
      );
      res.json(caseView(next.rows[0], ins.rows[0]));
    } catch (err) {
      res.status(500).json({ error: 'Erro ao buscar processo: ' + err.message });
    }
  });

  app.post('/api/games/despacho/:playId/decide', authenticateToken, async (req, res) => {
    const decision = String((req.body && req.body.decision) || '');
    // timeout: o relógio do celular zerou; o processo é arquivado e a resposta certa aparece
    if (!['deferir', 'indeferir', 'timeout'].includes(decision)) return res.status(400).json({ error: 'Escolha deferir ou indeferir.' });
    try {
      const out = await withTx(async (client) => {
        const found = await client.query(
          `SELECT gp.*, gc.correct_decision, gc.rationale, gc.title FROM game_plays gp JOIN game_cases gc ON gc.id = gp.ref_id
           WHERE gp.id = $1 AND gp.user_id = $2 AND gp.game = 'despacho'`,
          [req.params.playId, req.user.id]
        );
        if (!found.rows.length) return { status: 404, error: 'Processo não encontrado.' };
        const p = found.rows[0];
        if (p.status !== 'served') return { status: 400, error: 'Este processo já foi despachado ou expirou.' };
        const late = decision === 'timeout' || Date.now() - Date.parse(p.served_at) > CASE_SECONDS * 1000 + CASE_GRACE_MS;
        const correct = !late && decision === p.correct_decision ? 1 : 0;
        const pts = correct ? CASE_POINTS : 0;
        await client.query(
          "UPDATE game_plays SET status = $1, correct = $2, points = $3, data = $4 WHERE id = $5",
          [late ? 'expired' : 'done', correct, pts, JSON.stringify({ decision }), p.id]
        );
        const reward = await grantPoints(client, req.user.id, 'despacho', pts, `Despacho correto: ${p.title}`);
        return { late, correct: !!correct, correct_decision: p.correct_decision, rationale: p.rationale, points: pts, reward };
      });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao despachar: ' + err.message });
    }
  });

  // Memória: partidas jogadas offline
  app.post('/api/games/memoria/sync', authenticateToken, async (req, res) => {
    const games = Array.isArray(req.body && req.body.games) ? req.body.games.slice(0, 50) : [];
    try {
      const out = await withTx(async (client) => {
        let points = 0;
        let accepted = 0;
        const rewardedByDay = {};
        for (const g of games) {
          const clientId = clip(g.client_id, 64);
          const pairs = parseInt(g.pairs, 10);
          const moves = parseInt(g.moves, 10);
          const seconds = parseInt(g.seconds, 10);
          if (!clientId || !(pairs >= 4 && pairs <= 12) || !(moves >= pairs) || !(seconds >= 3)) continue;
          const dup = await client.query("SELECT 1 AS ok FROM game_plays WHERE user_id = $1 AND game = 'memoria' AND client_id = $2", [req.user.id, clientId]);
          if (dup.rows.length) { accepted++; continue; }
          const day = dayOf(g.played_at);
          if (rewardedByDay[day] === undefined) {
            const cnt = await client.query("SELECT COUNT(*) AS n FROM game_plays WHERE user_id = $1 AND game = 'memoria' AND day = $2 AND points > 0", [req.user.id, day]);
            rewardedByDay[day] = Number(cnt.rows[0].n);
          }
          const pts = rewardedByDay[day] < MEMORY_DAILY_CAP ? MEMORY_POINTS : 0;
          if (pts) rewardedByDay[day]++;
          await client.query(
            `INSERT INTO game_plays (user_id, game, client_id, day, status, correct, points, data, served_at)
             VALUES ($1, 'memoria', $2, $3, 'done', 1, $4, $5, $6)`,
            [req.user.id, clientId, day, pts, JSON.stringify({ pairs, moves, seconds }), clip(g.played_at, 40) || null]
          );
          accepted++;
          points += pts;
        }
        const reward = await grantPoints(client, req.user.id, 'memoria', points, 'Memória dos emblemas');
        return { accepted, points, reward };
      });
      res.json({ success: true, ...out });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao sincronizar a memória: ' + err.message });
    }
  });

  // ------------------------------------------
  // Admin: revisão do conteúdo escrito pelos assistentes
  // ------------------------------------------
  const TABLES = { missions: 'game_missions', quiz: 'game_quiz_questions', cases: 'game_cases' };

  app.get('/api/admin/games', authenticateToken, requireRole(['admin']), async (req, res) => {
    try {
      const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
      const [s, missions, quiz, cases] = await Promise.all([
        stock(),
        pool.query(`SELECT gm.*, m.name AS ministry_name FROM game_missions gm LEFT JOIN ministries m ON m.code = gm.ministry_code
                    WHERE gm.status = $1 ORDER BY gm.created_at DESC LIMIT 60`, [status]),
        pool.query('SELECT * FROM game_quiz_questions WHERE status = $1 ORDER BY created_at DESC LIMIT 60', [status]),
        pool.query(`SELECT gc.*, m.name AS ministry_name FROM game_cases gc LEFT JOIN ministries m ON m.code = gc.ministry_code
                    WHERE gc.status = $1 ORDER BY gc.created_at DESC LIMIT 60`, [status]),
      ]);
      res.json({
        status,
        stock: s,
        generator: {
          api_key_configured: !!process.env.OPENROUTER_API_KEY,
          enabled: process.env.ASSISTANTS_DISABLED !== 'true',
          calls_today: genState.day === today() ? genState.calls : 0,
          max_per_day: GEN_MAX_PER_DAY,
          last_failure: genState.lastFailure,
        },
        missions: missions.rows,
        quiz: quiz.rows.map((q) => ({ ...q, options: JSON.parse(q.options) })),
        cases: cases.rows,
      });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao carregar o conteúdo dos jogos: ' + err.message });
    }
  });

  app.post('/api/admin/games/review', authenticateToken, requireRole(['admin']), async (req, res) => {
    const { type, ids, decision } = req.body || {};
    const table = TABLES[type];
    if (!table || !Array.isArray(ids) || !ids.length || !['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'Revisão inválida.' });
    }
    try {
      const status = decision === 'approve' ? 'approved' : 'rejected';
      let changed = 0;
      for (const id of ids.slice(0, 100)) {
        const r = await pool.query(`UPDATE ${table} SET status = $1, reviewed_by = $2 WHERE id = $3 AND status = 'pending' RETURNING id`, [status, req.user.id, id]);
        changed += r.rows.length;
      }
      await audit(req.user.id, table, ids.length === 1 ? ids[0] : null, decision === 'approve' ? 'approve_game_content' : 'reject_game_content', { count: changed, type });
      res.json({ success: true, changed });
    } catch (err) {
      res.status(500).json({ error: 'Erro na revisão: ' + err.message });
    }
  });

  // Correção rápida antes de aprovar (texto, resposta certa, decisão)
  app.put('/api/admin/games/:type/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
    const b = req.body || {};
    try {
      if (req.params.type === 'missions') {
        await pool.query('UPDATE game_missions SET title = $1, description = $2 WHERE id = $3', [clip(b.title, 80), clip(b.description, 300), req.params.id]);
      } else if (req.params.type === 'quiz') {
        const options = Array.isArray(b.options) ? b.options.map((o) => clip(o, 140)) : [];
        const ci = parseInt(b.correct_index, 10);
        if (options.length !== 4 || options.some((o) => !o) || !(ci >= 0 && ci < 4)) return res.status(400).json({ error: 'A pergunta precisa de 4 alternativas e uma correta.' });
        await pool.query('UPDATE game_quiz_questions SET question = $1, options = $2, correct_index = $3, explanation = $4 WHERE id = $5',
          [clip(b.question, 300), JSON.stringify(options), ci, clip(b.explanation, 400), req.params.id]);
      } else if (req.params.type === 'cases') {
        if (!['deferir', 'indeferir'].includes(b.correct_decision)) return res.status(400).json({ error: 'Decisão inválida.' });
        await pool.query('UPDATE game_cases SET title = $1, summary = $2, correct_decision = $3, rationale = $4 WHERE id = $5',
          [clip(b.title, 100), clip(b.summary, 900), b.correct_decision, clip(b.rationale, 400), req.params.id]);
      } else {
        return res.status(400).json({ error: 'Tipo inválido.' });
      }
      await audit(req.user.id, TABLES[req.params.type], req.params.id, 'edit_game_content', b);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Erro ao salvar: ' + err.message });
    }
  });

  // Pede conteúdo novo agora (sem esperar o gerador automático)
  app.post('/api/admin/games/generate', authenticateToken, requireRole(['admin']), async (req, res) => {
    const kind = req.body && req.body.type;
    if (!GENERATORS[kind]) return res.status(400).json({ error: 'Tipo inválido.' });
    if (genState.running) return res.status(400).json({ error: 'Já tem um assistente escrevendo. Tente em instantes.' });
    genState.running = true;
    try {
      const out = await runGeneration(kind, req.user.id);
      res.json({ success: true, ...out, label: GEN_LABEL[kind] });
    } catch (err) {
      res.status(400).json({ error: err.message });
    } finally {
      genState.running = false;
    }
  });

  return { startGenerator };
}

module.exports = { createJogos };
