import { createStorage, type Storage } from "unstorage";
import fsDriver from "unstorage/drivers/fs";
import { type ModelMessage } from "ai";
import path from "path";
import { LibSqlKeyValueStorage, LibSqlListStorage, SkillHistoryStorage } from "./storage.js";

export class AgentMemory {
  // 1. Secrets (libSQL - file:secrets.db)
  public secrets: LibSqlKeyValueStorage;

  // 2. History (libSQL - file:history.db)
  public history: LibSqlListStorage<ModelMessage>;

  // 3. Skill History (libSQL - file:history.db, table: skill_history)
  public skillHistory: SkillHistoryStorage<ModelMessage>;

  // 4. Workspace (Unstorage - ./workspace)
  public workspace: Storage;

  constructor() {
    // A. Init Secrets DB
    // In Production: process.env.SECRETS_DB_URL (libsql://...)
    this.secrets = new LibSqlKeyValueStorage(
      process.env.SECRETS_DB_URL || "file:secrets.db", 
      process.env.SECRETS_AUTH_TOKEN
    );

    // B. Init History DB
    // In Production: process.env.HISTORY_DB_URL (libsql://...)
    this.history = new LibSqlListStorage<ModelMessage>(
      process.env.HISTORY_DB_URL || "file:history.db",
      process.env.HISTORY_AUTH_TOKEN
    );

    // C. Init Skill History (same DB as history, different table)
    this.skillHistory = new SkillHistoryStorage<ModelMessage>(
      process.env.HISTORY_DB_URL || "file:history.db",
      process.env.HISTORY_AUTH_TOKEN
    );

    // D. Init Workspace (Filesystem)
    // Unstorage abstrahiert hier nur das "Wie", aber es bleibt lokal im Ordner.
    this.workspace = createStorage({
      driver: fsDriver({ base: path.join(process.cwd(), "workspace") })
    });
  }
}
