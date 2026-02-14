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
  private tableName = 'list_items';

  constructor(url: string, authToken?: string) {
    this.client = authToken ? createClient({ url, authToken }) : createClient({ url });
    this.init();
  }

  private async init() {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        item TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async push(name: string, item: T): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO ${this.tableName} (name, item) VALUES (?, ?)`,
      args: [name, JSON.stringify(item)]
    });
  }

  async pushMany(name: string, items: T[]): Promise<void> {
    const tx = await this.client.transaction();
    try {
        for (const item of items) {
            await tx.execute({
                sql: `INSERT INTO ${this.tableName} (name, item) VALUES (?, ?)`,
                args: [name, JSON.stringify(item)]
            });
        }
        await tx.commit();
    } catch (e) {
        await tx.rollback();
        throw e;
    }
  }

  async replaceAll(name: string, items: T[]): Promise<void> {
    const tx = await this.client.transaction();
    try {
        await tx.execute({
            sql: `DELETE FROM ${this.tableName} WHERE name = ?`,
            args: [name],
        });
        for (const item of items) {
            await tx.execute({
                sql: `INSERT INTO ${this.tableName} (name, item) VALUES (?, ?)`,
                args: [name, JSON.stringify(item)]
            });
        }
        await tx.commit();
    } catch (e) {
        await tx.rollback();
        throw e;
    }
  }

  async getAll(name: string): Promise<T[]> {
    const rs = await this.client.execute({
      sql: `SELECT item FROM ${this.tableName} WHERE name = ? ORDER BY id ASC`,
      args: [name]
    });
    return rs.rows.map(row => JSON.parse(row.item as string));
  }
  
  async count(name: string): Promise<number> {
    const rs = await this.client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ${this.tableName} WHERE name = ?`,
      args: [name]
    });
    return Number(rs.rows[0]?.cnt ?? 0);
  }

  async clear(name: string): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM ${this.tableName} WHERE name = ?`,
      args: [name]
    });
  }
}


export class LibSqlFiFoStorage<T> {
    private client: Client;
    private tableName = 'queue_items';

    constructor(url: string, authToken?: string) {
        this.client = authToken ? createClient({ url, authToken }) : createClient({ url });
        this.init();
    }

    private async init(): Promise<void> {
        await this.client.execute(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                queue_name TEXT NOT NULL,
                value TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
    }

    public async push(queue: string, item: T): Promise<void> {
        await this.client.execute({
            sql: `INSERT INTO ${this.tableName} (queue_name, value) VALUES (?, ?)`,
            args: [queue, JSON.stringify(item)],
        });
    }

    public async pushMany(queue: string, items: T[]): Promise<void> {
        const tx = await this.client.transaction();
        try {
            for (const item of items) {
                await tx.execute({
                    sql: `INSERT INTO ${this.tableName} (queue_name, value) VALUES (?, ?)`,
                    args: [queue, JSON.stringify(item)],
                });
            }
            await tx.commit();
        } catch (e) {
            await tx.rollback();
            throw e;
        }
    }

    public async empty(queue: string): Promise<boolean> {
        return (await this.count(queue)) === 0;
    }

    public async pop(queue: string): Promise<T | null> {
        const tx = await this.client.transaction();
        try {
            const rs = await tx.execute({
                sql: `SELECT id, value FROM ${this.tableName} WHERE queue_name = ? ORDER BY id ASC LIMIT 1`,
                args: [queue],
            });

            if (rs.rows.length === 0) {
                await tx.commit();
                return null;
            }

            const row = rs.rows[0] as any;
            const id = row.id;

            await tx.execute({
                sql: `DELETE FROM ${this.tableName} WHERE id = ?`,
                args: [id!],
            });

            await tx.commit();

            return JSON.parse(row.value as string) as T;
        } catch (e) {
            await tx.rollback();
            throw e;
        }
    }

    public async count(queue: string): Promise<number> {
        const rs = await this.client.execute({
            sql: `SELECT COUNT(*) as count FROM ${this.tableName} WHERE queue_name = ?`,
            args: [queue],
        });
        return (rs.rows[0]?.count as number) ?? 0;
    }

    public async clear(queue: string): Promise<void> {
        await this.client.execute({
            sql: `DELETE FROM ${this.tableName} WHERE queue_name = ?`,
            args: [queue],
        });
    }
}
