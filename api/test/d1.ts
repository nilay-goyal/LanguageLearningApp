// A stand-in for Cloudflare D1 backed by Node's built-in SQLite, so the tests run the real
// SQL in schema.sql and in the endpoints.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Param = string | number | null;

class Statement {
  constructor(private db: DatabaseSync, readonly sql: string, private params: Param[] = []) {}
  bind(...params: Param[]) {
    return new Statement(this.db, this.sql, params);
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }
  async first<T>(column?: string) {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async run() {
    this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: {} };
  }
}

export function createD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    exec: async (sql: string) => {
      db.exec(sql);
    },
  } as unknown as D1Database;
}
