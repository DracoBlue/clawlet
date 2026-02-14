import {
  streamText,
  generateText,
  stepCountIs,
  type ModelMessage,
  type LanguageModel,
} from 'ai';
import 'dotenv/config';
import { AgentMemory } from './memory.js';
import { readFile, copyFile, access, mkdir } from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { createTools } from './tools.js';

// Resolve the package root directory (where template/ lives), independent of cwd
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const GENERATE_TEXT_TEMPERATURE = 0.6;
const GENERATE_TEXT_TOP_P = 0.95;
const GENERATE_TEXT_MAX_OUTPUT_TOKENS = 16384;
const GENERATE_TEXT_MAX_STEPS = 30;

// --- ADAPTER INTERFACES ---

export interface InputAdapter {
  onMessage(handler: (text: string, label: string) => void): void;
  start(): void;
}

export interface OutputAdapter {
  onAgentStart(label: string): void;
  onResponseChunk(chunk: string): void;
  onResponseEnd(fullResponse: string): void;
  onError(error: Error): void;
}

// --- HELPERS ---

function getTodayString(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

// --- SYSTEM PROMPT BUILDER ---

async function buildSystemPrompt(memory: AgentMemory): Promise<string> {
  // Read AGENTS.md from workspace
  let agentsDoc = "CRITICAL WARNING: AGENTS.md not found. Operate with caution.";
  try {
    const doc = await memory.workspace.getItem('AGENTS.md');
    if (doc) agentsDoc = String(doc);
  } catch {}

  // Read SOUL.md from workspace (if it exists)
  let soulDoc = "";
  try {
    const doc = await memory.workspace.getItem('SOUL.md');
    if (doc) soulDoc = String(doc);
  } catch {}

  // Read IDENTITY.md from workspace (if it exists)
  let identityDoc = "";
  try {
    const doc = await memory.workspace.getItem('IDENTITY.md');
    if (doc) identityDoc = String(doc);
  } catch {}

  // List all workspace files
  let workspaceFiles = "No workspace files found.";
  try {
    const keys = await memory.workspace.getKeys();
    if (keys.length > 0) workspaceFiles = keys.filter((key:string) => !key.startsWith('.trash/')).join('\n');
  } catch {}

  // Build identity section from SOUL.md and IDENTITY.md
  let identitySection = `# IDENTITY: Clawlet
You are "Clawlet", an autonomous agent defined by the file \`AGENTS.md\`.`;

  if (identityDoc) {
    identitySection += `\n\n## Identity Definition (IDENTITY.md)\n${identityDoc}`;
  }
  if (soulDoc) {
    identitySection += `\n\n## Soul & Behavioral Guidelines (SOUL.md)\n${soulDoc}`;
  }

  return `
${identitySection}

# PRIME DIRECTIVE
This is your main session. Your core behavior, ethics, and operational protocols are strictly defined in **AGENTS.md** below.
You must obey these rules above all else.

# OPERATIONAL PROTOCOL (The "Every Session" Loop)
1. **INITIALIZE**:
   - Read \`AGENTS.md\` (provided below).
   - Check \`available_workspace\` list. The entries prefixed with skills/ are skills.
   - **MANDATORY**: Check for today's memory file (\`memory:${getTodayString()}.md\`).
   - IF it todays memory file exists -> Read it using \`fs.readFile\` to get context.
   - IF todays mmemory file does NOT exist -> Create it using \`fs.writeFile\` (start fresh).

2. **AUTH CHECK**:
   - Before external API calls, check \`connection.list\` for available connections.
   - If the connection is missing, use \`connection.create\` to register and store credentials.
   - Use \`connection.request\` for authenticated API calls (Bearer token is auto-injected).

3. **EXECUTION**:
   - Use \`fs.readFile\` and \`fs.writeFile\` to log *significant* events to append oday's memory file (as per AGENTS.md rules).
   - **Text > Brain**: If you learn something, write it down immediately.

# AVAILABLE WORKSPACE (Files)
${workspaceFiles}

# CORE RULES (AGENTS.md)
${agentsDoc}
`;
}

// --- AGENT RUNNER ---

async function runAgent(
  input: string,
  memory: AgentMemory,
  model: LanguageModel,
  messages: ModelMessage[],
  tools: ReturnType<typeof createTools>,
  onResponseChunk?: (chunk: string) => void
): Promise<ModelMessage[]> {
  const message : ModelMessage = { role: 'user', content: input };
  messages.push(message);

  try {
    let overallInputTokens = 0;
    let overallOutputTokens = 0;
    let overallSteps = 0;
    const result = await streamText({
      model,
      system: await buildSystemPrompt(memory),
      messages,
      tools,
      temperature: GENERATE_TEXT_TEMPERATURE,
      topP: GENERATE_TEXT_TOP_P,
      maxOutputTokens: GENERATE_TEXT_MAX_OUTPUT_TOKENS,
      stopWhen: stepCountIs(GENERATE_TEXT_MAX_STEPS),

      onStepFinish: (step) => {
        if (step.toolCalls.length > 0) {
          const names = step.toolCalls.map(t => t.toolName).join(', ');
          logger.debug({ tools: names, tokens: step.usage.totalTokens }, 'Agent executed tools');
        } else {
          logger.debug({ tokens: step.usage.totalTokens }, 'Agent finalized step');
        }
        overallSteps += 1;
        overallInputTokens += step.usage.inputTokens || 0;
        overallOutputTokens += step.usage.outputTokens || 0
      },
    });

    let fullResponse = "";

    for await (const delta of result.textStream) {
      fullResponse += delta;
      if (onResponseChunk) {
        onResponseChunk(delta);
      }
    }

    const inputTokenPrice = process.env.AI_GATEWAY_INPUT_TOKEN_PRICE;
    const outputTokenPrice = process.env.AI_GATEWAY_OUTPUT_TOKEN_PRICE;
    if (inputTokenPrice && outputTokenPrice) {
      const price = (parseFloat(inputTokenPrice) * overallInputTokens + parseFloat(outputTokenPrice) * overallOutputTokens) / 1000000;
      logger.info({ steps: overallSteps, inputTokens: overallInputTokens, outputTokens: overallOutputTokens, cost: price }, 'Agent run completed');
    } else {
      logger.info({ steps: overallSteps, inputTokens: overallInputTokens, outputTokens: overallOutputTokens }, 'Agent run completed');
    }

    const responseMessages = (await result.response).messages;
    messages.push(...responseMessages);

    return responseMessages;

  } catch (e) {
    logger.error({ err: e }, 'Agent run error');
    return [];
  }
}

// --- COMPACTION CONFIG ---
const COMPACT_THRESHOLD = 25;  // Trigger compaction when history reaches this many items
const COMPACT_RANGE = 10;      // Number of messages to summarize (items 1..10, skipping system prompt at 0)

// --- MAIN EXPORTED CLASS ---

export class Agent {
  private memory: AgentMemory;
  private model: LanguageModel;
  private messages: ModelMessage[] = [];
  private tools: ReturnType<typeof createTools>;
  private inputAdapters: InputAdapter[] = [];
  private outputAdapters: OutputAdapter[] = [];
  private inputQueue: { text: string; label: string }[] = [];
  private processing = false;
  private initialized = false;
  private bootstrapPrompt: string | null = null;

  constructor(memory: AgentMemory, model: LanguageModel) {
    this.memory = memory;
    this.model = model;
    this.tools = createTools(this.memory, this.model);
  }

  addInput(adapter: InputAdapter): this {
    this.inputAdapters.push(adapter);
    adapter.onMessage((text, label) => {
      this.inputQueue.push({ text, label });
      this.processQueue();
    });
    return this;
  }

  addOutput(adapter: OutputAdapter): this {
    this.outputAdapters.push(adapter);
    return this;
  }

  async start() {
    await this.init();
    for (const adapter of this.inputAdapters) {
      adapter.start();
    }
  }

  private async init() {
    if (this.initialized) return;
    this.initialized = true;

    // Bootstrap: copy AGENTS.template -> workspace/AGENTS.md if missing
    // Templates are resolved from the package install directory (PACKAGE_ROOT),
    // NOT from process.cwd(), so this works correctly via npx/global install.
    const workspaceDir = path.join(process.cwd(), 'workspace');
    const agentsMdPath = path.join(workspaceDir, 'AGENTS.md');
    const templatePath = path.join(PACKAGE_ROOT, 'template', 'AGENTS.template');

    try {
      await access(agentsMdPath);
    } catch {
      // AGENTS.md does not exist, copy from template
      try {
        await mkdir(workspaceDir, { recursive: true });
        await copyFile(templatePath, agentsMdPath);
        logger.info('Copied AGENTS.template -> workspace/AGENTS.md');
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to copy AGENTS.template');
      }
    }

    // Bootstrap: check if SOUL.md, IDENTITY.md, or USER.md are missing
    const requiredFiles = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
    let needsBootstrap = false;
    for (const file of requiredFiles) {
      try {
        await access(path.join(workspaceDir, file));
      } catch {
        needsBootstrap = true;
        break;
      }
    }

    if (needsBootstrap) {
      try {
        const bootstrapPath = path.join(PACKAGE_ROOT, 'template', 'BOOTSTRAP.md');
        this.bootstrapPrompt = await readFile(bootstrapPath, 'utf-8');
        logger.info('Bootstrap mode: SOUL.md, IDENTITY.md, or USER.md missing. Running BOOTSTRAP.md first.');
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to read BOOTSTRAP.md');
      }
    }

    // Load history from DB
    const savedMessages : ModelMessage[] = []; // (await this.memory.history.getAll());
    if (savedMessages.length > 0) {
      this.messages = savedMessages as ModelMessage[];
      logger.info({ count: savedMessages.length }, 'Loaded messages from history');
    } else {
      logger.debug('No messages loaded from history');
    }
  }

  /**
   * Compacts history when it reaches COMPACT_THRESHOLD items.
   * Summarizes items 1..COMPACT_RANGE (the system prompt is not included) into a single message
   * using the LLM, then replaces in-memory + persisted history.
   * Result: summary message + remaining messages.
   */
  private async compactHistory() {
    if (this.messages.length < COMPACT_THRESHOLD) return;

    logger.info({count: this.messages.length}, `messages compacted.`);

    const toSummarize = this.messages.slice(0, COMPACT_RANGE); 
    const remaining = this.messages.slice(COMPACT_RANGE);

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
        model: this.model,
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
      this.messages = [summaryMessage, ...remaining];

      // Persist: clear DB and re-write all messages
      await this.memory.history.clear();
      await this.memory.history.pushMany(this.messages);

      console.log(`  ✅ Compacted to ${this.messages.length} messages.`);
    } catch (e) {
      console.error('  ❌ Compaction failed, keeping original history:', e);
    }
  }

  private async processQueue() {
    if (this.processing || this.inputQueue.length === 0) return;
    if (!this.initialized) await this.init();
    this.processing = true;

    const { text, label } = this.inputQueue.shift()!;

    for (const out of this.outputAdapters) {
      out.onAgentStart(label);
    }

    await this.compactHistory();

    // Bootstrap: if bootstrapPrompt is set, run it instead of normal chat
    // until the required files (SOUL.md, IDENTITY.md, USER.md) are created
    const isFirstMessage = this.messages.length === 0;
    let input: string;
    if (this.bootstrapPrompt && isFirstMessage) {
      input = `[BOOTSTRAP MODE] The workspace is not yet set up.\n\n` +
        `${this.bootstrapPrompt}\n\n` +
        `Use fs.writeFile to create each file in the workspace when the user provides the information.\n\n` +
        `--- USER MESSAGE ---\n${text}`;
    } else if (this.bootstrapPrompt) {
      // Still in bootstrap mode (subsequent messages) — check if bootstrap is complete
      const workspaceDir = path.join(process.cwd(), 'workspace');
      const requiredFiles = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
      let allExist = true;
      for (const file of requiredFiles) {
        try {
          await access(path.join(workspaceDir, file));
        } catch {
          allExist = false;
          break;
        }
      }
      if (allExist) {
        this.bootstrapPrompt = null;
        console.log(`  ✅ Bootstrap complete! SOUL.md, IDENTITY.md, and USER.md are now present.`);
      }
      input = text;
    } else if (isFirstMessage) {
      input = `[SYSTEM BOOT] This is a fresh session. Before responding to the user, you MUST execute the "Every Session" protocol from AGENTS.md NOW using your tools:\n` +
        `1. Call fs.readFile for SOUL.md\n` +
        `2. Call fs.readFile for USER.md\n` +
        `3. Call fs.readFile for memory:${getTodayString()}.md (create it with fs.writeFile if it doesn't exist)\n` +
        `4. Call fs.readFile for MEMORY.md\n` +
        `Execute ALL of these tool calls first, then respond to the user's message below.\n\n` +
        `--- USER MESSAGE ---\n${text}`;
    } else {
      input = text;
    }

    let fullResponse = "";
    try {
      const newMessages = await runAgent(input, this.memory, this.model, this.messages, this.tools, (chunk) => {
      fullResponse += chunk;
        for (const out of this.outputAdapters) {
          out.onResponseChunk(chunk);
        }
      });

      for (const msg of newMessages) {
        if (typeof msg.content !== "string") {
          msg.content = msg.content.filter((part) => part.type !== 'reasoning');
        }
        await this.memory.history.push(msg);
      }

      for (const out of this.outputAdapters) {
        out.onResponseEnd(fullResponse);
      }

      // Compact history if it's grown past the threshold
      await this.compactHistory();
    } catch (error: any) {
      for (const out of this.outputAdapters) {
        out.onError(error);
      }
    }

    this.processing = false;
    this.processQueue();
  }
}
