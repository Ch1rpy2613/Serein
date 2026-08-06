import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'serein.db');
const LEGACY_DB_PATH = join(DATA_DIR, 'atmos.db');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

/** 旧版文件名 atmos.db → serein.db（含 WAL/SHM） */
function migrateLegacyDbFiles(): void {
  if (existsSync(DB_PATH) || !existsSync(LEGACY_DB_PATH)) return;
  renameSync(LEGACY_DB_PATH, DB_PATH);
  for (const suffix of ['-wal', '-shm'] as const) {
    const from = `${LEGACY_DB_PATH}${suffix}`;
    const to = `${DB_PATH}${suffix}`;
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  }
  console.info('[db] renamed legacy atmos.db → serein.db');
}

let db: Database.Database | null = null;

function ensureMigrationsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function appliedIds(database: Database.Database): Set<string> {
  const rows = database.prepare('SELECT id FROM _migrations').all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** 按文件名顺序执行尚未记录的迁移 */
export function runMigrations(database: Database.Database): void {
  ensureMigrationsTable(database);
  const done = appliedIds(database);
  const insert = database.prepare(
    'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
  );

  for (const file of listMigrationFiles()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const apply = database.transaction(() => {
      database.exec(sql);
      insert.run(file, Date.now());
    });
    apply();
    console.info(`[db] applied migration ${file}`);
  }
}

/** 打开 SQLite（自动建 data/），跑迁移，返回单例连接 */
export function openDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  migrateLegacyDbFiles();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not open; call openDb() first');
  return db;
}

export function closeDb(): void {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    console.warn('[db] close failed', err);
  }
  db = null;
}

export function dbPath(): string {
  return DB_PATH;
}
