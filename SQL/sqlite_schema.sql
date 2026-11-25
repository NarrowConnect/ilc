-- ==========================================
-- SCHEMA SQLITE DO SISTEMA ILC (banco embutido)
-- ==========================================
-- Executado automaticamente a cada inicialização do servidor (idempotente).
-- IDs: UUID v4 em TEXT. Datas: ISO 8601 UTC em TEXT (ex.: 2026-11-07T12:00:00.000Z).
-- JSON: TEXT. Booleanos: INTEGER 0/1.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    celular TEXT UNIQUE,
    google_id TEXT UNIQUE,
    password_hash TEXT,
    hierarchy_title TEXT DEFAULT 'Usuário',
    avatar_url TEXT,
    rank_title TEXT DEFAULT 'Recruta',
    rank_emblem_url TEXT,
    reset_code TEXT,
    reset_expires TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'blocked')),
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    name TEXT NOT NULL UNIQUE,
    description TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT unique_user_role UNIQUE (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS score_accounts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    started_score INTEGER NOT NULL DEFAULT 5000,
    current_score INTEGER NOT NULL DEFAULT 5000 CHECK (current_score >= 0 AND current_score <= 10000),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS score_tiers (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    name TEXT NOT NULL UNIQUE,
    min_score INTEGER NOT NULL,
    max_score INTEGER NOT NULL,
    color TEXT NOT NULL,
    description TEXT,
    privileges TEXT
);

CREATE TABLE IF NOT EXISTS score_event_types (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK (category IN ('reward', 'penalty')),
    points_delta INTEGER NOT NULL,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS score_events (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type_id TEXT NOT NULL REFERENCES score_event_types(id),
    points_delta INTEGER NOT NULL,
    description TEXT NOT NULL,
    evidence_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS merit_certificates (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    name TEXT NOT NULL UNIQUE,
    points_required INTEGER NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS user_certificates (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    certificate_id TEXT NOT NULL REFERENCES merit_certificates(id) ON DELETE CASCADE,
    granted_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT unique_user_cert UNIQUE (user_id, certificate_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    entity_name TEXT NOT NULL,
    entity_id TEXT,
    action TEXT NOT NULL,
    old_data TEXT,
    new_data TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS democracy_events (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    title TEXT NOT NULL,
    description TEXT,
    location TEXT,
    event_date TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'cívico',
    status TEXT NOT NULL DEFAULT 'planejado',
    max_participants INTEGER,
    registration_url TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS democracy_event_participants (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    event_id TEXT NOT NULL REFERENCES democracy_events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    registered_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT unique_event_participant UNIQUE (event_id, user_id)
);

-- Índices para as consultas mais frequentes
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_score_events_user ON score_events(user_id, status);
CREATE INDEX IF NOT EXISTS idx_score_events_occurred ON score_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_user_certificates_user ON user_certificates(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_democracy_events_date ON democracy_events(event_date);
CREATE INDEX IF NOT EXISTS idx_dep_event ON democracy_event_participants(event_id);

-- ==========================================
-- MINISTÉRIOS, DIÁRIO OFICIAL E ASSISTENTES (IA)
-- ==========================================
-- Os 6 ministérios existem no app. Os assistentes (tabela assistants) são movidos a IA (OpenRouter),
-- publicam no Diário Oficial e enviam sugestões para aprovação. As colunas assistant_* de ministries
-- só servem de semente para os 4 assistentes iniciais.

CREATE TABLE IF NOT EXISTS ministries (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    mission TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    has_assistant INTEGER NOT NULL DEFAULT 0,
    assistant_name TEXT,
    assistant_persona TEXT,
    assistant_context TEXT,
    assistant_enabled INTEGER NOT NULL DEFAULT 1,
    posts_per_day INTEGER NOT NULL DEFAULT 3 CHECK (posts_per_day BETWEEN 0 AND 12),
    suggestions_per_day INTEGER NOT NULL DEFAULT 1 CHECK (suggestions_per_day BETWEEN 0 AND 6)
);

-- Assistentes: não são usuários (não fazem login, não têm carteira). Cada um trabalha para um ministério.
-- As colunas assistant_id de feed_posts/assistant_runs/assistant_tasks são criadas em ministerios.js (migração).
CREATE TABLE IF NOT EXISTS assistants (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    ministry_code TEXT NOT NULL REFERENCES ministries(code),
    name TEXT NOT NULL,
    persona TEXT NOT NULL,
    context TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    posts_per_day INTEGER NOT NULL DEFAULT 3 CHECK (posts_per_day BETWEEN 0 AND 12),
    suggestions_per_day INTEGER NOT NULL DEFAULT 1 CHECK (suggestions_per_day BETWEEN 0 AND 6),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS feed_posts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    ministry_code TEXT NOT NULL REFERENCES ministries(code),
    kind TEXT NOT NULL CHECK (kind IN ('post', 'suggestion')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('published', 'draft', 'rejected')),
    pinned INTEGER NOT NULL DEFAULT 0,
    ai_model TEXT,
    reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    published_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS feed_reactions (
    post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS feed_comments (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Agenda diária dos assistentes: horários sorteados, executados pelo agendador do servidor
CREATE TABLE IF NOT EXISTS assistant_runs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    ministry_code TEXT NOT NULL REFERENCES ministries(code) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('post', 'suggestion')),
    day TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
    error TEXT,
    post_id TEXT REFERENCES feed_posts(id) ON DELETE SET NULL,
    ran_at TEXT
);

-- Tarefas que o admin passa para um assistente: usadas na próxima rodada dele
CREATE TABLE IF NOT EXISTS assistant_tasks (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
    ministry_code TEXT NOT NULL REFERENCES ministries(code) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'any' CHECK (kind IN ('any', 'post', 'suggestion')),
    instructions TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
    post_id TEXT REFERENCES feed_posts(id) ON DELETE SET NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    done_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assistant_tasks_open ON assistant_tasks(ministry_code, status, created_at);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_feed_posts_status ON feed_posts(status, published_at);
CREATE INDEX IF NOT EXISTS idx_feed_comments_post ON feed_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assistant_runs_due ON assistant_runs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_assistant_runs_day ON assistant_runs(day, ministry_code);

-- Ministérios: inseridos também em bancos já existentes (INSERT OR IGNORE não altera o que o admin mudou)
INSERT OR IGNORE INTO ministries (code, name, mission, sort_order, has_assistant, assistant_name, assistant_persona) VALUES
('verdade', 'Ministério da Verdade',
 'Comunicação oficial do Estado, Diário Oficial, transparência das informações e supervisão administrativa do ILC.', 1, 1,
 'Assistente do Ministério da Verdade',
 'Porta-voz oficial, solene e preciso. Escreve comunicados, notas oficiais e boletins do Diário Oficial. Valoriza a informação verificada, a ordem e a confiança no Estado.'),
('prosperidade', 'Ministério da Prosperidade',
 'Economia, trabalho, produção e recompensas cívicas. Administra os pontos, benefícios e incentivos da carteira do cidadão.', 2, 1,
 'Assistente do Ministério da Prosperidade',
 'Gestor otimista e pragmático. Fala de produção, trabalho, metas, benefícios e conquistas econômicas, sempre com números redondos e tom motivador.'),
('defesa', 'Ministério da Defesa',
 'Segurança nacional, ordem pública, disciplina e aplicação das penalidades cívicas.', 3, 1,
 'Assistente do Ministério da Defesa',
 'Oficial disciplinado e direto. Escreve avisos de segurança, ordens do dia e alertas de conduta, com linguagem militar, firme e respeitosa.'),
('educacao', 'Ministério da Educação',
 'Formação cívica, exames, quizzes e programas de conhecimento sobre a Constituição e os deveres do cidadão.', 4, 1,
 'Assistente do Ministério da Educação',
 'Professor cívico paciente e entusiasmado. Escreve curiosidades sobre a Constituição, convites para exames e desafios de conhecimento.'),
('saude', 'Ministério da Saúde',
 'Políticas nacionais de saúde, campanhas de vacinação e bem-estar da população.', 5, 0, NULL, NULL),
('ciencia', 'Ministério da Ciência e Tecnologia',
 'Pesquisa, inovação e infraestrutura tecnológica do Estado.', 6, 0, NULL, NULL);

-- Recompensa por participar do Diário Oficial (primeiro comentário do dia)
INSERT OR IGNORE INTO score_event_types (code, name, category, points_delta, requires_approval) VALUES
('participacao_diario', 'Participação no Diário Oficial', 'reward', 10, 0);

-- @@SEEDS@@
-- ==========================================
-- SEMENTES (aplicadas só em banco novo: PRAGMA user_version = 0)
-- ==========================================

INSERT OR IGNORE INTO roles (name, description) VALUES
('admin', 'Acesso administrativo total ao sistema'),
('usuario', 'Acesso padrão de usuário/cidadão ao sistema');

INSERT OR IGNORE INTO score_tiers (name, min_score, max_score, color, description, privileges) VALUES
('Vigilância Máxima', 0, 1999, '#8A3D2F', 'Cidadão com lealdade cívica crítica. Sob suspeita constante do Estado.', 'Proibição de trânsito intermunicipal, restrição de acesso à internet pública e banimento de cargos civis.'),
('Restrito', 2000, 3999, '#4E6E8E', 'Cidadão sob regime de advertência cívica e limitações sociais.', 'Acesso limitado a serviços bancários públicos, fila de prioridade suspensa no sistema de saúde e restrições de viagens.'),
('Cidadão Comum', 4000, 5999, '#B9B19A', 'Cidadão regular com deveres e direitos civis fundamentais.', 'Direitos de tráfego normais, acesso a linhas de crédito convencionais e serviços públicos regulares.'),
('Cidadão Exemplar', 6000, 7999, '#556B2F', 'Cidadão em dia com a Pátria e prestativo com a comunidade.', 'Fura-fila burocrático de 15% em órgãos públicos, prioridade em exames cívicos e acesso à biblioteca oficial.'),
('Herói Cívico', 8000, 9499, '#73B33A', 'Exemplo notável de lealdade, serviço e conduta estatal.', 'Isenção de 5% em impostos de serviços locais, transporte público gratuito e assentos reservados em solenidades.'),
('Alto Comando Honorário', 9500, 10000, '#B08A47', 'A mais alta estirpe de lealdade cívica. Elite patriota honorária.', 'Acesso direto ao conselho administrativo regional, passaporte cívico diplomático e medalha de ouro de honra.');

INSERT OR IGNORE INTO score_event_types (code, name, category, points_delta, requires_approval) VALUES
('eleicao', 'Participação ativa em eleições nacionais', 'reward', 100, 0),
('servico_militar', 'Serviço militar obrigatório concluído', 'reward', 500, 0),
('trabalho_voluntario', 'Trabalho voluntário credenciado', 'reward', 200, 0),
('doacao_sangue', 'Doação voluntária de sangue', 'reward', 100, 0),
('exame_civico', 'Aprovação com excelência em exame de educação cívica', 'reward', 250, 0),
('campanha_nacional', 'Participação ativa em campanhas estatais', 'reward', 150, 0),
('denuncia_crime', 'Denúncia comprovada de atividade ilícita ou corrupção', 'reward', 300, 1),
('medalha_oficial', 'Concessão de medalha de honra cívica oficial', 'reward', 1000, 1),
('multa_transito', 'Multa de trânsito de natureza gravíssima', 'penalty', -150, 0),
('falta_servico_obrigatorio', 'Falta injustificada a dever civil obrigatório', 'penalty', -300, 0),
('condenacao_criminal', 'Sentença judicial condenatória criminal transitada', 'penalty', -1000, 1),
('corrupcao_cargo', 'Prática de corrupção ou suborno em cargo público', 'penalty', -2000, 1),
('seguranca_nacional', 'Ato hostil ou crime contra a segurança da Pátria', 'penalty', -5000, 1);

INSERT OR IGNORE INTO merit_certificates (name, points_required, description) VALUES
('Mérito Cívico', 100, 'Concedido ao cidadão que atinge seus primeiros 100 pontos acumulados em atos de cooperação social.'),
('Serviço Distinto', 500, 'Reconhecimento oficial por 500 pontos acumulados em atividades de apoio e valor militar/cívico.'),
('Excelência Nacional', 1000, 'Diploma solene outorgado por expressiva contribuição cívica nacional, somando 1.000 pontos.'),
('Honra Suprema', 5000, 'Ordem máxima da lealdade nacional. Reservado para cidadãos que dedicaram 5.000 pontos em mérito cívico.');

PRAGMA user_version = 1;
