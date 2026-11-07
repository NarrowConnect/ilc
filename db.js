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

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

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

async function runDailyBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const target = path.join(BACKUP_DIR, backupFileName());
    if (fs.existsSync(target)) return;
    await snapshotTo(target);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^ilc-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
    console.log(`💾 Backup diário do banco salvo em ${target}`);
  } catch (err) {
    console.error('❌ Falha no backup diário do banco:', err.message);
  }
}

function scheduleBackups() {
  setTimeout(runDailyBackup, 60 * 1000).unref();
  setInterval(runDailyBackup, 60 * 60 * 1000).unref(); // verifica de hora em hora; grava 1 por dia
}

module.exports = {
  pool,
  db,
  DB_PATH,
  BACKUP_DIR,
  initSchema,
  getUserVersion,
  snapshotTo,
  scheduleBackups
};
