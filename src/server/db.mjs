import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@libsql/client';

export const DEFAULT_CATEGORIES = [
  ['Food & dining', '#c2a46d', 'utensils'], ['Groceries', '#8a9467', 'basket'],
  ['Transport', '#7ea9b8', 'train'], ['Shopping', '#bc8a78', 'bag'],
  ['Education', '#8d91bf', 'book'], ['Entertainment', '#ba81ad', 'sparkles'],
  ['Health', '#d47c78', 'heart'], ['Housing', '#8c9a83', 'home'],
  ['Bills', '#9b9ca5', 'receipt'], ['Travel', '#719f98', 'plane'],
  ['Personal care', '#c497a3', 'flower'], ['Investments', '#88a879', 'chart'],
  ['Savings', '#9eae67', 'piggy-bank'], ['Other', '#93948a', 'circle']
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#8a9467', icon TEXT NOT NULL DEFAULT 'circle',
    created_at TEXT NOT NULL, UNIQUE(user_id, name COLLATE NOCASE)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('expense','income')),
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    description TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', merchant TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL DEFAULT 'Cash', date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual', recurrence_id TEXT, created_at TEXT NOT NULL,
    FOREIGN KEY(recurrence_id) REFERENCES recurring_transactions(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS transactions_user_date_idx ON transactions(user_id, date DESC);
  CREATE INDEX IF NOT EXISTS transactions_user_category_idx ON transactions(user_id, category_id, date DESC);
  CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    period TEXT NOT NULL CHECK(period IN ('weekly','monthly')), start_date TEXT NOT NULL,
    warn_percent INTEGER NOT NULL DEFAULT 80 CHECK(warn_percent BETWEEN 1 AND 99), created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS budgets_user_idx ON budgets(user_id, period, start_date);
  CREATE TABLE IF NOT EXISTS bills (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0), due_date TEXT NOT NULL,
    recurrence TEXT NOT NULL DEFAULT 'none' CHECK(recurrence IN ('none','weekly','monthly','yearly')),
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, notes TEXT NOT NULL DEFAULT '',
    completed INTEGER NOT NULL DEFAULT 0, last_paid_at TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bills_user_due_idx ON bills(user_id, due_date);
  CREATE TABLE IF NOT EXISTS recurring_transactions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('expense','income')), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, description TEXT NOT NULL,
    merchant TEXT NOT NULL DEFAULT '', payment_method TEXT NOT NULL DEFAULT 'Cash', frequency TEXT NOT NULL
      CHECK(frequency IN ('weekly','monthly','yearly')), next_date TEXT NOT NULL, end_date TEXT,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS recurring_user_date_idx ON recurring_transactions(user_id, active, next_date);
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, target_cents INTEGER NOT NULL CHECK(target_cents > 0),
    current_cents INTEGER NOT NULL DEFAULT 0 CHECK(current_cents >= 0), target_date TEXT,
    description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contributions (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), date TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, message TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'info',
    dedupe_key TEXT, read_at TEXT, created_at TEXT NOT NULL, UNIQUE(user_id, dedupe_key)
  );
  CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'olive', currency TEXT NOT NULL DEFAULT 'INR',
    date_format TEXT NOT NULL DEFAULT 'DD MMM YYYY', privacy_mode INTEGER NOT NULL DEFAULT 0,
    notify_budgets INTEGER NOT NULL DEFAULT 1, notify_bills INTEGER NOT NULL DEFAULT 1,
    notify_goals INTEGER NOT NULL DEFAULT 1, notify_cash INTEGER NOT NULL DEFAULT 1,
    motion INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
  );
`;

export function openDatabase(filePath = process.env.SPENDWISE_DB_PATH || path.resolve('data/spendwise.sqlite')) {
  if (filePath !== ':memory:') mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  db.exec(SCHEMA);
  const settingsColumns = new Set(db.prepare('PRAGMA table_info(settings)').all().map(column => column.name));
  if (!settingsColumns.has('notify_cash')) db.exec('ALTER TABLE settings ADD COLUMN notify_cash INTEGER NOT NULL DEFAULT 1');
  if (filePath !== ':memory:' && process.platform !== 'win32') {
    const databaseFile = path.resolve(filePath);
    for (const file of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
      try { chmodSync(file, 0o600); } catch {}
    }
  }
  return db;
}

function remoteAdapter(executor) {
  const rowObject = (result, row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]]));
  return {
    isTurso: true,
    prepare(sql) {
      return {
        async get(...args) {
          const result = await executor.execute({ sql, args });
          return result.rows[0] ? rowObject(result, result.rows[0]) : undefined;
        },
        async all(...args) {
          const result = await executor.execute({ sql, args });
          return result.rows.map(row => rowObject(result, row));
        },
        async run(...args) {
          const result = await executor.execute({ sql, args });
          return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
        }
      };
    },
    async exec(sql) {
      if (typeof executor.executeMultiple === 'function') return executor.executeMultiple(sql);
      for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) {
        await executor.execute(statement);
      }
    }
  };
}

export async function openTursoDatabase({ url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN } = {}) {
  if (!url) throw new Error('TURSO_DATABASE_URL is required to use the hosted database.');
  if (!url.startsWith('file:') && !authToken) throw new Error('TURSO_AUTH_TOKEN is required to use the hosted database.');
  const client = createClient({ url, authToken, intMode: 'number' });
  const db = remoteAdapter(client);
  try {
    await client.execute('PRAGMA foreign_keys = ON');
    await db.exec(SCHEMA);
    const settingsColumns = new Set((await db.prepare('PRAGMA table_info(settings)').all()).map(column => column.name));
    if (!settingsColumns.has('notify_cash')) {
      try {
        await db.exec('ALTER TABLE settings ADD COLUMN notify_cash INTEGER NOT NULL DEFAULT 1');
      } catch (error) {
        if (!String(error?.message || error).toLowerCase().includes('duplicate column')) throw error;
      }
    }
    db.transaction = async callback => {
      const transaction = await client.transaction('write');
      const transactionDb = remoteAdapter(transaction);
      try {
        const result = await callback(transactionDb);
        await transaction.commit();
        return result;
      } catch (error) {
        try { await transaction.rollback(); } catch {}
        throw error;
      } finally {
        transaction.close();
      }
    };
    db.close = () => client.close();
    return db;
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function seedCategories(db, userId, now) {
  const insert = db.prepare('INSERT INTO categories(id,user_id,name,color,icon,created_at) VALUES(?,?,?,?,?,?)');
  for (const [name, color, icon] of DEFAULT_CATEGORIES) {
    await insert.run(cryptoId(), userId, name, color, icon, now);
  }
}

function cryptoId() { return globalThis.crypto.randomUUID(); }
