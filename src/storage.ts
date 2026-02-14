import { createClient, type Client } from '@libsql/client';

// --- A. Key-Value Storage (für Secrets/Config) ---
export class LibSqlKeyValueStorage {
  private client: Client;
  private tableName: string;

  constructor(url: string, authToken?: string, tableName = 'kv_store') {
    this.tableName = tableName;
    this.client = authToken ? createClient({ url, authToken }) : createClient({ url });
    this.init();
  }

  private async init() {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
  }

  async set(key: string, value: string) {
    // Upsert (Insert or Replace)
    await this.client.execute({
      sql: `INSERT INTO ${this.tableName} (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [key, value]
    });
  }

  async get(key: string): Promise<string | null> {
    const rs = await this.client.execute({
      sql: `SELECT value FROM ${this.tableName} WHERE key = ?`,
      args: [key]
    });
    return (rs.rows[0]?.value as string) || null;
  }

  async has(key: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `SELECT 1 FROM ${this.tableName} WHERE key = ? LIMIT 1`,
      args: [key]
    });
    return rs.rows.length > 0;
  }

  async delete(key: string) {
    await this.client.execute({
      sql: `DELETE FROM ${this.tableName} WHERE key = ?`,
      args: [key]
    });
  }

  async listKeys(): Promise<string[]> {
    const rs = await this.client.execute(`SELECT key FROM ${this.tableName}`);
    return rs.rows.map(row => row.key as string);
  }
}

// --- B. List Storage (für History/Logs) ---
export class LibSqlListStorage<T = any> {
  private client: Client;
  private tableName: string;

  constructor(url: string, authToken?: string, tableName = 'list_store') {
    this.tableName = tableName;
    this.client = authToken ? createClient({ url, authToken }) : createClient({ url });
    this.init();
  }

  private async init() {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async push(item: T) {
    await this.client.execute({
      sql: `INSERT INTO ${this.tableName} (item) VALUES (?)`,
      args: [JSON.stringify(item)]
    });
  }

  // Bulk Insert für Performance
  async pushMany(items: T[]) {
    const promises = items.map(item => this.client.execute({
        sql: `INSERT INTO ${this.tableName} (item) VALUES (?)`,
        args: [JSON.stringify(item)]
    }));
    await Promise.all(promises);
  }

  async getAll(): Promise<T[]> {
    const rs = await this.client.execute(
      `SELECT item FROM ${this.tableName} ORDER BY id ASC`
    );
    return rs.rows.map(row => JSON.parse(row.item as string));
  }
  
  // Optional: Nur die letzten N Nachrichten holen (Kontext-Fenster!)
  async getRecent(limit: number): Promise<T[]> {
     // Trick: Erst sortieren DESC (neueste), limitieren, dann wieder ASC sortieren
     const rs = await this.client.execute({
        sql: `SELECT * FROM (
                SELECT item, id FROM ${this.tableName} ORDER BY id DESC LIMIT ?
              ) ORDER BY id ASC`,
        args: [limit]
     });
     return rs.rows.map(row => JSON.parse(row.item as string));
  }

  async count(): Promise<number> {
    const rs = await this.client.execute(
      `SELECT COUNT(*) as cnt FROM ${this.tableName}`
    );
    return Number(rs.rows[0]?.cnt ?? 0);
  }

  async clear() {
    await this.client.execute(`DELETE FROM ${this.tableName}`);
    // Reset autoincrement so IDs stay clean
    await this.client.execute(
      `DELETE FROM sqlite_sequence WHERE name = '${this.tableName}'`
    );
  }
}

// --- C. Skill History Storage (single table, partitioned by skill name) ---
export class SkillHistoryStorage<T = any> {
  private client: Client;

  constructor(url: string, authToken?: string) {
    this.client = createClient({ url, authToken });
    this.init();
  }

  private async init() {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS skill_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        item TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async push(name: string, item: T) {
    await this.client.execute({
      sql: `INSERT INTO skill_history (name, item) VALUES (?, ?)`,
      args: [name, JSON.stringify(item)]
    });
  }

  async pushMany(name: string, items: T[]) {
    const promises = items.map(item => this.client.execute({
      sql: `INSERT INTO skill_history (name, item) VALUES (?, ?)`,
      args: [name, JSON.stringify(item)]
    }));
    await Promise.all(promises);
  }

  async getAll(name: string): Promise<T[]> {
    const rs = await this.client.execute({
      sql: `SELECT item FROM skill_history WHERE name = ? ORDER BY id ASC`,
      args: [name]
    });
    return rs.rows.map(row => JSON.parse(row.item as string));
  }

  async clear(name: string) {
    await this.client.execute({
      sql: `DELETE FROM skill_history WHERE name = ?`,
      args: [name]
    });
  }

  async count(name: string): Promise<number> {
    const rs = await this.client.execute({
      sql: `SELECT COUNT(*) as cnt FROM skill_history WHERE name = ?`,
      args: [name]
    });
    return Number(rs.rows[0]?.cnt ?? 0);
  }
}
