// ==========================================
// BANCO DE DADOS EMBUTIDO (SQLite via node:sqlite)
// ==========================================
// Camada de compatibilidade que imita a API do driver `pg` usada no server.js:
//   pool.query(sql, params) -> { rows, rowCount }
//   const client = await pool.connect(); client.query(...); client.release();
// Assim as queries existentes (com $1, $2...) continuam funcionando sobre um
// arquivo SQLite local, sem precisar de um servidor Postgres/Supabase.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'ilc.db');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP || '7', 10);
const SCHEMA_PATH = path.join(__dirname, 'SQL', 'sqlite_schema.sql');

const BACKUP_KEEP_MONTHLY = parseInt(process.env.BACKUP_KEEP_MONTHLY || '12', 10);
const STARTUP_BACKUP_KEEP = 5;
// Coloque um arquivo com este nome na pasta de dados e reinicie para restaurar
const RESTORE_PATH = path.join(path.dirname(DB_PATH), 'restaurar.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ------------------------------------------
// Verificações de backup (usadas antes de abrir o banco principal)
// ------------------------------------------

// Abre um arquivo .db em modo leitura e confirma que está íntegro e é do ILC
function verifyBackupFile(file) {
  let check;
  try {
    const fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (header.toString('latin1') !== 'SQLite format 3\0') {
      return { ok: false, error: 'não é um arquivo SQLite' };
    }
    check = new DatabaseSync(file, { readOnly: true });
    const integrity = check.prepare('PRAGMA integrity_check').get();
    const result = Object.values(integrity)[0];
    if (result !== 'ok') return { ok: false, error: `integridade: ${result}` };
    const hasUsers = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!hasUsers) return { ok: false, error: 'tabela users ausente (não é um banco do ILC)' };
    const users = check.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    return { ok: true, users };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (check) check.close();
  }
}

// A pasta de dados precisa ser um volume montado; sem isso o banco some a cada deploy
function isDataDirMounted() {
  try {
    const dir = path.resolve(path.dirname(DB_PATH));
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
    return mounts.some((line) => line.split(' ')[4] === dir);
  } catch {
    return null; // fora do Linux (ex.: desenvolvimento no Windows) não dá para saber
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pruneBackups(pattern, keep) {
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => pattern.test(f)).sort();
  while (files.length > keep) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
}

// Restauração: se existir data/restaurar.db, ele vira o banco ativo nesta inicialização.
// O banco atual é guardado antes em backups/antes-da-restauracao-*.db.
function applyPendingRestore() {
  if (!fs.existsSync(RESTORE_PATH)) return;
  const check = verifyBackupFile(RESTORE_PATH);
  if (!check.ok) {
    const rejected = `${RESTORE_PATH}.invalido-${timestamp()}`;
    fs.renameSync(RESTORE_PATH, rejected);
    console.error(`❌ Restauração cancelada (${check.error}). Arquivo movido para ${rejected}. O banco atual foi mantido.`);
    return;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    const current = new DatabaseSync(DB_PATH);
    const saved = path.join(BACKUP_DIR, `antes-da-restauracao-${timestamp()}.db`);
    current.exec(`VACUUM INTO '${saved.replace(/'/g, "''")}'`);
    current.close();
    console.log(`💾 Banco anterior guardado em ${saved}`);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(DB_PATH + suffix)) fs.unlinkSync(DB_PATH + suffix);
  }
  fs.renameSync(RESTORE_PATH, DB_PATH);
  console.log(`♻️  Banco restaurado a partir de restaurar.db (${check.users} usuários).`);
}

// Cópia de segurança a cada inicialização, antes das migrações do schema
function startupBackup() {
  if (!fs.existsSync(DB_PATH) || fs.statSync(DB_PATH).size === 0) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const target = path.join(BACKUP_DIR, `inicio-${timestamp()}.db`);
    const conn = new DatabaseSync(DB_PATH);
    conn.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    conn.close();
    pruneBackups(/^inicio-.*\.db$/, STARTUP_BACKUP_KEEP);
    console.log(`💾 Backup de inicialização salvo em ${target}`);
  } catch (err) {
    console.error('❌ Falha no backup de inicialização:', err.message);
  }
}

applyPendingRestore();
startupBackup();

const MOUNTED = isDataDirMounted();
if (MOUNTED === false) {
  console.error('');
  console.error('🚨🚨🚨 ATENÇÃO: a pasta do banco NÃO é um volume montado:', path.dirname(DB_PATH));
  console.error('🚨 Os dados e backups serão PERDIDOS no próximo deploy.');
  console.error('🚨 No Easypanel: serviço -> Mounts -> Add Volume -> Mount Path /usr/src/app/data');
  console.error('');
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// Funções SQL equivalentes às do Postgres
db.function('now', { deterministic: false }, () => new Date().toISOString());
db.function('gen_uuid', { deterministic: false }, () => crypto.randomUUID());
// Comparação sem diferenciar maiúsculas/acentos (substitui o ILIKE)
db.function('unaccent_lower', { deterministic: true }, (value) => {
  if (value === null || value === undefined) return null;
  return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
});

// ------------------------------------------
// Tradução de SQL estilo Postgres -> SQLite
// ------------------------------------------
const translationCache = new Map();

function translate(sql) {
  let cached = translationCache.get(sql);
  if (cached) return cached;

  const trimmed = sql.trim().replace(/;$/, '').trim();
  const upper = trimmed.toUpperCase();

  if (upper === 'BEGIN' || upper === 'BEGIN TRANSACTION') {
    cached = { kind: 'begin' };
  } else if (upper === 'COMMIT' || upper === 'END') {
    cached = { kind: 'commit' };
  } else if (upper === 'ROLLBACK') {
    cached = { kind: 'rollback' };
  } else {
    const text = trimmed
      .replace(/\$(\d+)/g, '?$1') // placeholders $1 -> ?1
      .replace(/\s+FOR\s+UPDATE\b/gi, ''); // SQLite bloqueia o banco inteiro na transação
    cached = { kind: 'statement', text };
  }

  translationCache.set(sql, cached);
  return cached;
}

const statementCache = new Map();
function getStatement(text) {
  let stmt = statementCache.get(text);
  if (!stmt) {
    stmt = db.prepare(text);
    if (statementCache.size > 500) statementCache.clear();
    statementCache.set(text, stmt);
  }
  return stmt;
}

function convertParam(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

const JSON_COLUMNS = new Set(['old_data', 'new_data']);
// Colunas que o Postgres devolvia como true/false (SQLite devolve 0/1)
const BOOLEAN_COLUMNS = new Set(['is_registered', 'requires_approval', 'active']);

function normalizeRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    let value = row[key];
    let name = key;
    // pg nomeia COUNT(*) como "count"
    if (/^count\(.*\)$/i.test(key)) name = 'count';
    if (JSON_COLUMNS.has(name) && typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { /* mantém texto */ }
    } else if (BOOLEAN_COLUMNS.has(name) && typeof value === 'number') {
      value = value !== 0;
    }
    out[name] = value;
  }
  return out;
}

function execute(text, params) {
  const stmt = getStatement(text);
  const args = (params || []).map(convertParam);
  if (stmt.columns().length > 0) {
    const rows = stmt.all(...args).map(normalizeRow);
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...args);
  return { rows: [], rowCount: Number(info.changes) };
}

// ------------------------------------------
// Lock assíncrono: uma transação por vez
// ------------------------------------------
// O SQLite tem uma conexão só. Enquanto uma requisição está entre BEGIN e
// COMMIT (com awaits no meio), as outras precisam esperar para não caírem
// dentro da transação alheia.
let lockOwner = null;
const waiters = [];

function acquireLock(owner) {
  if (lockOwner === null) {
    lockOwner = owner;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push({ owner, resolve }));
}

function releaseLock(owner) {
  if (lockOwner !== owner) return;
  const next = waiters.shift();
  if (next) {
    lockOwner = next.owner;
    next.resolve();
  } else {
    lockOwner = null;
  }
}

async function waitIdle(owner) {
  // Queries soltas só precisam esperar se outra transação estiver aberta
  if (lockOwner === null || lockOwner === owner) return false;
  await acquireLock(owner);
  return true;
}

class Client {
  constructor() {
    this.inTransaction = false;
    this.released = false;
  }

  async query(sql, params) {
    const t = translate(sql);

    if (t.kind === 'begin') {
      if (this.inTransaction) return { rows: [], rowCount: 0 };
      await acquireLock(this);
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (err) {
        releaseLock(this);
        throw err;
      }
      this.inTransaction = true;
      return { rows: [], rowCount: 0 };
    }

    if (t.kind === 'commit' || t.kind === 'rollback') {
      // pg apenas avisa quando não há transação; replicamos sem erro
      if (!this.inTransaction) return { rows: [], rowCount: 0 };
      try {
        if (db.isTransaction) db.exec(t.kind === 'commit' ? 'COMMIT' : 'ROLLBACK');
      } finally {
        this.inTransaction = false;
        releaseLock(this);
      }
      return { rows: [], rowCount: 0 };
    }

    if (this.inTransaction) return execute(t.text, params);

    const locked = await waitIdle(this);
    try {
      return execute(t.text, params);
    } finally {
      if (locked) releaseLock(this);
    }
  }

  release() {
    if (this.released) return;
    this.released = true;
    // Rotas que fazem "return res.status(...)" no meio da transação:
    // desfaz automaticamente para não travar o banco.
    if (this.inTransaction) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch (err) {
        console.error('⚠️  Falha ao desfazer transação pendente:', err.message);
      }
      this.inTransaction = false;
      releaseLock(this);
    }
  }
}

const pool = {
  async query(sql, params) {
    const client = new Client();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  },
  async connect() {
    return new Client();
  }
};

// ------------------------------------------
// Schema e backups
// ------------------------------------------
function getUserVersion() {
  return db.prepare('PRAGMA user_version').get().user_version;
}

// Cria as tabelas (idempotente). As sementes só entram em banco novo, para
// não recriar registros que o admin tenha apagado/renomeado depois.
function initSchema() {
  const [tables, seeds] = fs.readFileSync(SCHEMA_PATH, 'utf8').split('-- @@SEEDS@@');
  db.exec(tables);
  if (getUserVersion() === 0 && seeds) {
    db.exec('BEGIN');
    try {
      db.exec(seeds);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log('🌱 Sementes iniciais (papéis, faixas, tipos de evento, certificados) aplicadas.');
  }
}

function backupFileName(date = new Date()) {
  return `ilc-${date.toISOString().slice(0, 10)}.db`;
}

// Gera uma cópia consistente do banco (VACUUM INTO) no caminho informado
async function snapshotTo(targetPath) {
  const owner = {};
  await acquireLock(owner);
  try {
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  } finally {
    releaseLock(owner);
  }
  return targetPath;
}

// Backup diário verificado + 1 cópia mensal. Retenção: BACKUP_KEEP diários e BACKUP_KEEP_MONTHLY mensais.
async function runDailyBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, backupFileName());
    if (!fs.existsSync(target)) {
      await snapshotTo(target);
      const check = verifyBackupFile(target);
      if (!check.ok) {
        fs.unlinkSync(target);
        throw new Error(`cópia gerada não passou na verificação (${check.error})`);
      }
      console.log(`💾 Backup diário do banco salvo em ${target} (${check.users} usuários, verificado)`);
    }
    const monthly = path.join(BACKUP_DIR, `ilc-mensal-${today.slice(0, 7)}.db`);
    if (!fs.existsSync(monthly)) fs.copyFileSync(target, monthly);
    pruneBackups(/^ilc-\d{4}-\d{2}-\d{2}\.db$/, BACKUP_KEEP);
    pruneBackups(/^ilc-mensal-\d{4}-\d{2}\.db$/, BACKUP_KEEP_MONTHLY);
  } catch (err) {
    console.error('❌ Falha no backup diário do banco:', err.message);
  }
}

function scheduleBackups() {
  setTimeout(runDailyBackup, 60 * 1000).unref();
  setInterval(runDailyBackup, 60 * 60 * 1000).unref(); // verifica de hora em hora; grava 1 por dia
}

// Resumo para o painel/admin: volume montado e lista de backups
function getBackupStatus() {
  let files = [];
  if (fs.existsSync(BACKUP_DIR)) {
    files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, bytes: st.size, modifiedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
  const daily = files.filter((f) => /^ilc-\d{4}-\d{2}-\d{2}\.db$/.test(f.file));
  return {
    volumeMounted: MOUNTED,
    dbPath: DB_PATH,
    dbBytes: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0,
    backupDir: BACKUP_DIR,
    keepDaily: BACKUP_KEEP,
    keepMonthly: BACKUP_KEEP_MONTHLY,
    lastDailyBackup: daily[0] || null,
    offsiteConfigured: Boolean(process.env.BACKUP_TOKEN),
    files
  };
}

module.exports = {
  pool,
  db,
  DB_PATH,
  BACKUP_DIR,
  initSchema,
  getUserVersion,
  snapshotTo,
  scheduleBackups,
  verifyBackupFile,
  getBackupStatus,
  isDataDirMounted: () => MOUNTED,
  RESTORE_PATH
};
