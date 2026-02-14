import { createStorage, type Storage } from "unstorage";
import fsDriver from "unstorage/drivers/fs";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import path from "path";
import { LibSqlKeyValueStorage, LibSqlListStorage } from "./storage.js";
import { logger } from './logger.js';
import memoryDriver from 'unstorage/drivers/memory';


// --- COMPACTION CONFIG ---
const COMPACT_THRESHOLD = 25;  // Trigger compaction when history reaches this many items
const COMPACT_RANGE = 10;      // Number of messages to summarize (items 1..10, skipping system prompt at 0)

export class AgentMemory {
  // 1. Secrets (libSQL - file:secrets.db)
  public secrets: LibSqlKeyValueStorage;

  // 2. History (libSQL - file:history.db)
  public history: LibSqlListStorage<ModelMessage>;

  // 3. Workspace (Unstorage - ./workspace)
  public workspace: Storage;

  private constructor(secrets: LibSqlKeyValueStorage, history: LibSqlListStorage<ModelMessage>, workspace: Storage) {
    this.secrets = secrets;
    this.history = history;
    this.workspace = workspace
  }

  static async createInMemory() {
    return new AgentMemory(
      await LibSqlKeyValueStorage.create(':memory:'),
      await LibSqlListStorage.create<ModelMessage>(':memory:'),
      createStorage({ driver: memoryDriver() })
    );
  }

  static async create() {
    return new AgentMemory(
      await LibSqlKeyValueStorage.create(
        process.env.SECRETS_DB_URL || "file:secrets.db", 
        process.env.SECRETS_AUTH_TOKEN
      ),
      await LibSqlListStorage.create<ModelMessage>(
        process.env.HISTORY_DB_URL || "file:history.db",
        process.env.HISTORY_AUTH_TOKEN
      ),
      createStorage({
        driver: fsDriver({ base: path.join(process.cwd(), "workspace") })
      })
    );
  }


  /**
   * Compacts history when it reaches COMPACT_THRESHOLD items.
   * Summarizes items 1..COMPACT_RANGE (the system prompt is not included) into a single message
   * using the LLM, then replaces in-memory + persisted history.
   * Result: summary message + remaining messages.
   */
  async compactHistory(name:string, model: LanguageModel): Promise<ModelMessage[]> {
    const messages = await this.history.getAll(name);
    if (messages.length < COMPACT_THRESHOLD) return messages;

    logger.info({count: messages.length}, `messages to be compacted.`);

    const toSummarize = messages.slice(0, COMPACT_RANGE); 
    const remaining = messages.slice(COMPACT_RANGE);

    // Build a transcript for the LLM to summarize
    const transcript = toSummarize.map(m => {
      const role = m.role ?? 'unknown';
      const content = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content);
      return `[${role}]: ${content}`;
    }).join('\n\n');

    try {
      const { text: summary } = await generateText({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a conversation summarizer. Summarize the following conversation transcript concisely, preserving key facts, decisions, tool results, and context that would be needed to continue the conversation. Be factual and dense. Do not add commentary.',
          },
          {
            role: 'user',
            content: `Summarize this conversation transcript:\n\n${transcript}`,
          },
        ],
        temperature: 0.3,
      });

      const summaryMessage: ModelMessage = {
        role: 'assistant',
        content: `[Conversation Summary — compacted ${COMPACT_RANGE} messages]\n\n${summary}`,
      };

      // Rebuild in-memory messages: summary + remaining
      const compactedMessages = [summaryMessage, ...remaining];

      // Persist: clear DB and re-write all messages
      await this.history.replaceAll(name, compactedMessages);

      logger.info({count: compactedMessages}, `  Compacted messages.`);
      return compactedMessages;
    } catch (e) {
      logger.error({ err: e }, 'Compaction failed, keeping original history');
      await this.history.replaceAll(name, messages);
      return messages;
    }
  }
  
}
