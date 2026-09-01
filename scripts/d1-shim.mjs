// A D1 shim over node:sqlite, so the Worker can be exercised in plain Node
// without wrangler. Implements the slice of the D1 API the Worker uses:
// prepare().bind().first()/all()/run(), and batch() as a real transaction.
//
// This is test scaffolding, not production code.

import { DatabaseSync } from 'node:sqlite';

class Stmt {
  constructor(db, sql, binds = []) {
    this.db = db;
    this.sql = sql;
    this.binds = binds;
  }

  bind(...values) {
    return new Stmt(this.db, this.sql, values);
  }

  // node:sqlite rejects undefined and booleans; D1 accepts null.
  get _args() {
    return this.binds.map((v) => {
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    });
  }

  async first(column) {
    const row = this.db.prepare(this.sql).get(...this._args);
    if (!row) return null;
    return column ? row[column] : row;
  }

  async all() {
    const results = this.db.prepare(this.sql).all(...this._args);
    return { results, success: true, meta: {} };
  }

  async run() {
    const r = this.db.prepare(this.sql).run(...this._args);
    return {
      success: true,
      meta: {
        changes: Number(r.changes ?? 0),
        last_row_id: Number(r.lastInsertRowid ?? 0),
      },
    };
  }
}

export class D1Shim {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql) {
    return new Stmt(this.db, sql);
  }

  exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** All-or-nothing, like D1. A failure rolls back and rethrows. */
  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = [];
      for (const s of statements) {
        const isRead = /^\s*select/i.test(s.sql);
        out.push(isRead ? await s.all() : await s.run());
      }
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }
}

/** Minimal KV: get(key, 'arrayBuffer'). */
export class KVShim {
  constructor(map = new Map()) { this.map = map; }
  put(key, value) { this.map.set(key, value); }
  async get(key, type) {
    const v = this.map.get(key);
    if (v == null) return null;
    if (type === 'arrayBuffer') {
      return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    }
    return new TextDecoder().decode(v);
  }
}
