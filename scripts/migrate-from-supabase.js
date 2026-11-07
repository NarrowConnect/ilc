#!/usr/bin/env node
// ==========================================
// MIGRAÇÃO ÚNICA: Supabase (Postgres) -> SQLite embutido
// ==========================================
// Uso (local ou no console do container no EasyPanel):
//   SUPABASE_DATABASE_URL="postgresql://..." node scripts/migrate-from-supabase.js --confirm
//
// O que faz:
//   1. Faz uma cópia de segurança do SQLite atual em data/backups/pre-migracao-*.db
//   2. Apaga TODO o conteúdo do SQLite (inclusive o admin/sementes criados no 1º boot)
//   3. Copia todas as tabelas do Postgres mantendo os mesmos IDs (UUID)
//   4. Compara a contagem de linhas de cada tabela e imprime o relatório
//
// Depois de rodar, reinicie o app no EasyPanel.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const { db, initSchema, snapshotTo, BACKUP_DIR } = require('../db');

// Ordem respeitando as chaves estrangeiras
const TABLES = [
  'roles',
  'users',
  'user_roles',
  'score_tiers',
  'score_event_types',
  'merit_certificates',
  'score_accounts',
  'score_events',
  'user_certificates',
  'democracy_events',
  'democracy_event_participants',
  'audit_logs'
];

function toSqliteValue(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') return JSON.stringify(value); // JSONB
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function sqliteColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

async function main() {
  const connectionString = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ Defina SUPABASE_DATABASE_URL com a connection string do Postgres do Supabase.');
    process.exit(1);
  }
  if (!process.argv.includes('--confirm')) {
    console.error('⚠️  Este script APAGA o conteúdo atual do banco SQLite e o substitui pelos dados do Supabase.');
    console.error('    Rode novamente com --confirm para prosseguir.');
    process.exit(1);
  }

  initSchema();

  // 1. Cópia de segurança do estado atual do SQLite
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const preBackup = path.join(BACKUP_DIR, `pre-migracao-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await snapshotTo(preBackup);
  console.log(`💾 Backup do SQLite atual salvo em ${preBackup}`);

  const pg = new Client({
    connectionString,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });
  await pg.connect();
  console.log('🔌 Conectado ao Postgres do Supabase.');

  const existingRes = await pg.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const pgTables = new Set(existingRes.rows.map((r) => r.table_name));

  // 2. Ler todos os dados do Postgres antes de mexer no SQLite
  const data = {};
  for (const table of TABLES) {
    if (!pgTables.has(table)) {
      console.warn(`⚠️  Tabela ${table} não existe no Supabase — será deixada vazia.`);
      data[table] = [];
      continue;
    }
    const res = await pg.query(`SELECT * FROM ${table}`);
    data[table] = res.rows;
    console.log(`📥 ${table}: ${res.rows.length} linhas lidas`);
  }
  await pg.end();

  // 3. Substituir o conteúdo do SQLite numa única transação
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of [...TABLES].reverse()) {
      db.exec(`DELETE FROM ${table}`);
    }

    for (const table of TABLES) {
      const rows = data[table];
      if (rows.length === 0) continue;
      const targetCols = new Set(sqliteColumns(table));
      const cols = Object.keys(rows[0]).filter((c) => targetCols.has(c));
      const ignored = Object.keys(rows[0]).filter((c) => !targetCols.has(c));
      if (ignored.length) console.warn(`⚠️  ${table}: colunas ignoradas (não existem no SQLite): ${ignored.join(', ')}`);

      const stmt = db.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      );
      for (const row of rows) {
        stmt.run(...cols.map((c) => toSqliteValue(row[c])));
      }
    }

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      console.error('❌ Violações de chave estrangeira encontradas:', violations.slice(0, 20));
      throw new Error(`${violations.length} violações de chave estrangeira — migração desfeita.`);
    }

    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    console.error('❌ Migração cancelada, nada foi alterado:', err.message);
    process.exit(1);
  }
  db.exec('PRAGMA foreign_keys = ON');

  // 4. Relatório de conferência
  console.log('\n📊 Conferência (Supabase -> SQLite):');
  let ok = true;
  for (const table of TABLES) {
    const sqliteCount = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const pgCount = data[table].length;
    const match = sqliteCount === pgCount;
    if (!match) ok = false;
    console.log(`  ${match ? '✅' : '❌'} ${table.padEnd(30)} ${String(pgCount).padStart(6)} -> ${String(sqliteCount).padStart(6)}`);
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(ok
    ? '\n✅ Migração concluída. Reinicie o app no EasyPanel.'
    : '\n⚠️  Migração concluída com divergências — confira as tabelas marcadas com ❌.');
}

main().catch((err) => {
  console.error('❌ Erro inesperado na migração:', err);
  process.exit(1);
});
