import { createClient, type Client } from '@libsql/client';

// --- A. Key-Value Storage (für Secrets/Config) ---
export class LibSqlKeyValueStorage {
  private client: Client;
  private tableName: string;


  private constructor(url: string, authToken?: string, tableName = 'kv_store') {
    this.client = authToken ? createClient({ url, authToken }) : createClient({ url });
    this.tableName = tableName;
  }

  static async create<T>(url: string, authToken?: string, tableName = 'kv_store') {
    const s = new LibSqlKeyValueStorage(url, authToken, tableName);
    await s.init();
    return s;
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

  private constructor(url: string, authToken?: string) {
    this.client = authToken ? createClient({ url, authToken }) : createClient({ url });
  }

  static async create<T>(url: string, authToken?: string) {
    const s = new LibSqlListStorage(url, authToken);
    await s.init();
    return s;
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
    for (const item of items) {
      this.push(name, item);
    }
  }

  async replaceAll(name: string, items: T[]): Promise<void> {
    this.clear(name);
    this.pushMany(name, items);
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

    private constructor(url: string, authToken?: string) {
        this.client = authToken ? createClient({ url, authToken }) : createClient({ url });
    }

    static async create<T>(url: string, authToken?: string): Promise<LibSqlFiFoStorage<T>> {
        const storage = new LibSqlFiFoStorage<T>(url, authToken);
        await storage.init();
        return storage;
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
      for (const item of items) {
        this.push(queue, item);
      }
    }

    public async empty(queue: string): Promise<boolean> {
        return (await this.count(queue)) === 0;
    }

    public async pop(queue: string): Promise<T | null> {
      const rs = await this.client.execute({
          sql: `SELECT id, value FROM ${this.tableName} WHERE queue_name = ? ORDER BY id ASC LIMIT 1`,
          args: [queue],
      });

      if (rs.rows.length === 0) {
          return null;
      }

      const row = rs.rows[0] as any;
      const id = row.id;

      await this.client.execute({
          sql: `DELETE FROM ${this.tableName} WHERE id = ?`,
          args: [id!],
      });

      return JSON.parse(row.value as string) as T;
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


// --- D. Knowledge Storage (FTS + Graph Index) ---

export interface KnowledgeSearchResult {
  path: string;
  content: string;
  score: number;
}

export interface KnowledgeEdge {
  source_path: string;
  target_path: string;
  relation_type: string;
}

export interface KnowledgeRelation {
  target: string;
  type: string;
}

export class LibSqlKnowledgeStorage {
  private client: Client;

  private constructor(url: string, authToken?: string) {
    this.client = authToken ? createClient({ url, authToken }) : createClient({ url });
  }

  static async create(url: string, authToken?: string): Promise<LibSqlKnowledgeStorage> {
    const s = new LibSqlKnowledgeStorage(url, authToken);
    await s.init();
    return s;
  }

  private async init(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS knowledge_entries (
        path TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.client.execute(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts
        USING fts5(path, content)
    `);

    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS knowledge_edges (
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        PRIMARY KEY (source_path, target_path, relation_type)
      )
    `);

    await this.client.execute(`
      CREATE INDEX IF NOT EXISTS knowledge_edges_target_idx
        ON knowledge_edges (target_path)
    `);
  }

  async upsert(path: string, content: string, relations?: KnowledgeRelation[]): Promise<void> {
    // 1. Upsert main entry
    await this.client.execute({
      sql: `INSERT INTO knowledge_entries (path, content, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(path) DO UPDATE SET
              content = excluded.content,
              updated_at = excluded.updated_at`,
      args: [path, content]
    });

    // 2. Sync FTS (delete old, insert new)
    await this.client.execute({
      sql: `DELETE FROM knowledge_fts WHERE path = ?`,
      args: [path]
    });
    await this.client.execute({
      sql: `INSERT INTO knowledge_fts (path, content) VALUES (?, ?)`,
      args: [path, content]
    });

    // 3. Sync edges (delete old outgoing, insert new)
    await this.client.execute({
      sql: `DELETE FROM knowledge_edges WHERE source_path = ?`,
      args: [path]
    });

    if (relations && relations.length > 0) {
      for (const rel of relations) {
        await this.client.execute({
          sql: `INSERT OR IGNORE INTO knowledge_edges (source_path, target_path, relation_type)
                VALUES (?, ?, ?)`,
          args: [path, rel.target, rel.type]
        });
      }
    }
  }

  async remove(path: string): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM knowledge_fts WHERE path = ?`,
      args: [path]
    });
    await this.client.execute({
      sql: `DELETE FROM knowledge_edges WHERE source_path = ? OR target_path = ?`,
      args: [path, path]
    });
    await this.client.execute({
      sql: `DELETE FROM knowledge_entries WHERE path = ?`,
      args: [path]
    });
  }

  async searchFulltext(query: string, limit: number = 10): Promise<KnowledgeSearchResult[]> {
    const rs = await this.client.execute({
      sql: `SELECT path, content, bm25(knowledge_fts) as score
            FROM knowledge_fts
            WHERE knowledge_fts MATCH ?
            ORDER BY score
            LIMIT ?`,
      args: [query, limit]
    });
    return rs.rows.map(row => ({
      path: row.path as string,
      content: row.content as string,
      score: row.score as number,
    }));
  }

  async getRelated(
    path: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
    relationType?: string
  ): Promise<KnowledgeEdge[]> {
    let sql: string;
    const args: string[] = [];

    if (direction === 'outgoing') {
      sql = `SELECT source_path, target_path, relation_type FROM knowledge_edges WHERE source_path = ?`;
      args.push(path);
    } else if (direction === 'incoming') {
      sql = `SELECT source_path, target_path, relation_type FROM knowledge_edges WHERE target_path = ?`;
      args.push(path);
    } else {
      sql = `SELECT source_path, target_path, relation_type FROM knowledge_edges WHERE source_path = ? OR target_path = ?`;
      args.push(path, path);
    }

    if (relationType) {
      sql += ` AND relation_type = ?`;
      args.push(relationType);
    }

    const rs = await this.client.execute({ sql, args });
    return rs.rows.map(row => ({
      source_path: row.source_path as string,
      target_path: row.target_path as string,
      relation_type: row.relation_type as string,
    }));
  }

  async list(): Promise<Array<{ path: string }>> {
    const rs = await this.client.execute(`SELECT path FROM knowledge_entries ORDER BY path`);
    return rs.rows.map(row => ({ path: row.path as string }));
  }

  async searchTemporal(
    startDate: string,
    endDate: string,
    typeFilter?: string
  ): Promise<KnowledgeSearchResult[]> {
    const startTs = `${startDate}T00:00:00`;
    const endTs = `${endDate}T23:59:59`;

    let sql = `SELECT path, content, updated_at FROM knowledge_entries
               WHERE updated_at BETWEEN ? AND ?`;
    const args: (string)[] = [startTs, endTs];

    if (typeFilter) {
      sql += ` AND path LIKE ?`;
      args.push(`${typeFilter}:%`);
    }

    sql += ` ORDER BY updated_at DESC`;

    const rs = await this.client.execute({ sql, args });
    return rs.rows.map(row => ({
      path: row.path as string,
      content: row.content as string,
      score: 0,
    }));
  }

  async searchConflicts(
    assertion: string,
    targetCategory: string,
    limit: number = 3
  ): Promise<KnowledgeSearchResult[]> {
    // Use FTS to find entries in the target category that are semantically close to the assertion
    // FTS5 tokenizes the assertion and matches against content
    const tokens = assertion
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 2);

    if (tokens.length === 0) return [];

    // Build an OR query so any overlapping term surfaces potential conflicts
    const ftsQuery = tokens.join(' OR ');

    const rs = await this.client.execute({
      sql: `SELECT path, content, bm25(knowledge_fts) as score
            FROM knowledge_fts
            WHERE knowledge_fts MATCH ? AND path LIKE ?
            ORDER BY score
            LIMIT ?`,
      args: [ftsQuery, `${targetCategory}:%`, limit]
    });
    return rs.rows.map(row => ({
      path: row.path as string,
      content: row.content as string,
      score: row.score as number,
    }));
  }

  async graphTraverse(
    startNode: string,
    direction: 'outbound' | 'inbound' | 'both' = 'both',
    maxDepth: number = 1,
    relationshipType?: string
  ): Promise<Array<{ path: string; depth: number; relation_type: string }>> {
    // For depth 1, use a simple query; for depth > 1, use a recursive CTE
    if (maxDepth <= 1) {
      return this.graphTraverseSimple(startNode, direction, relationshipType);
    }

    // Recursive CTE for multi-hop traversal
    let cte: string;
    const args: string[] = [];

    if (direction === 'outbound') {
      cte = `
        WITH RECURSIVE traverse(node, depth, relation_type) AS (
          SELECT target_path, 1, relation_type FROM knowledge_edges
            WHERE source_path = ?${relationshipType ? ' AND relation_type = ?' : ''}
          UNION ALL
          SELECT e.target_path, t.depth + 1, e.relation_type
            FROM knowledge_edges e
            JOIN traverse t ON e.source_path = t.node
            WHERE t.depth < ?${relationshipType ? ' AND e.relation_type = ?' : ''}
        )
        SELECT DISTINCT node as path, depth, relation_type FROM traverse ORDER BY depth, path`;
      args.push(startNode);
      if (relationshipType) args.push(relationshipType);
      args.push(String(maxDepth));
      if (relationshipType) args.push(relationshipType);
    } else if (direction === 'inbound') {
      cte = `
        WITH RECURSIVE traverse(node, depth, relation_type) AS (
          SELECT source_path, 1, relation_type FROM knowledge_edges
            WHERE target_path = ?${relationshipType ? ' AND relation_type = ?' : ''}
          UNION ALL
          SELECT e.source_path, t.depth + 1, e.relation_type
            FROM knowledge_edges e
            JOIN traverse t ON e.target_path = t.node
            WHERE t.depth < ?${relationshipType ? ' AND e.relation_type = ?' : ''}
        )
        SELECT DISTINCT node as path, depth, relation_type FROM traverse ORDER BY depth, path`;
      args.push(startNode);
      if (relationshipType) args.push(relationshipType);
      args.push(String(maxDepth));
      if (relationshipType) args.push(relationshipType);
    } else {
      // Both directions
      cte = `
        WITH RECURSIVE traverse(node, depth, relation_type) AS (
          SELECT target_path, 1, relation_type FROM knowledge_edges
            WHERE source_path = ?${relationshipType ? ' AND relation_type = ?' : ''}
          UNION ALL
          SELECT source_path, 1, relation_type FROM knowledge_edges
            WHERE target_path = ?${relationshipType ? ' AND relation_type = ?' : ''}
          UNION ALL
          SELECT CASE WHEN e.source_path = t.node THEN e.target_path ELSE e.source_path END,
                 t.depth + 1, e.relation_type
            FROM knowledge_edges e
            JOIN traverse t ON (e.source_path = t.node OR e.target_path = t.node)
            WHERE t.depth < ?${relationshipType ? ' AND e.relation_type = ?' : ''}
        )
        SELECT DISTINCT node as path, depth, relation_type FROM traverse WHERE node != ? ORDER BY depth, path`;
      args.push(startNode);
      if (relationshipType) args.push(relationshipType);
      args.push(startNode);
      if (relationshipType) args.push(relationshipType);
      args.push(String(maxDepth));
      if (relationshipType) args.push(relationshipType);
      args.push(startNode); // exclude startNode from results
    }

    const rs = await this.client.execute({ sql: cte, args });
    return rs.rows.map(row => ({
      path: row.path as string,
      depth: Number(row.depth),
      relation_type: row.relation_type as string,
    }));
  }

  private async graphTraverseSimple(
    startNode: string,
    direction: 'outbound' | 'inbound' | 'both',
    relationshipType?: string
  ): Promise<Array<{ path: string; depth: number; relation_type: string }>> {
    let sql: string;
    const args: string[] = [];

    if (direction === 'outbound') {
      sql = `SELECT target_path as path, relation_type FROM knowledge_edges WHERE source_path = ?`;
      args.push(startNode);
    } else if (direction === 'inbound') {
      sql = `SELECT source_path as path, relation_type FROM knowledge_edges WHERE target_path = ?`;
      args.push(startNode);
    } else {
      sql = `SELECT CASE WHEN source_path = ? THEN target_path ELSE source_path END as path, relation_type
             FROM knowledge_edges WHERE source_path = ? OR target_path = ?`;
      args.push(startNode, startNode, startNode);
    }

    if (relationshipType) {
      sql += ` AND relation_type = ?`;
      args.push(relationshipType);
    }

    sql += ` ORDER BY path`;

    const rs = await this.client.execute({ sql, args });
    return rs.rows.map(row => ({
      path: row.path as string,
      depth: 1,
      relation_type: row.relation_type as string,
    }));
  }
}
