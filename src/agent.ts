import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type LanguageModel,
  NoSuchToolError,
  generateObject,
} from 'ai';
import 'dotenv/config';
import { AgentMemory } from './memory.js';
import { readFile } from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { createTools } from './tools.js';

// Resolve the package root directory (where template/ lives), independent of cwd
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const GENERATE_TEXT_MAX_STEPS = 30;

// --- ADAPTER INTERFACES ---

export interface InputAdapter {
  onMessage(handler: (text: string, label: string) => Promise<void>): void;
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

  // Read USER.md from workspace (if it exists)
  let userDoc = "";
  try {
    const doc = await memory.workspace.getItem('USER.md');
    if (doc) userDoc = String(doc);
  } catch {}

  // Read SYSTEM_INSTRUCTIONS.md from workspace (if it exists)
  let systemInstructionsDoc = "";
  try {
    const doc = await memory.workspace.getItem('SYSTEM_INSTRUCTIONS.md');
    if (doc) systemInstructionsDoc = String(doc);
  } catch {}

  // List all workspace files
  let workspaceFiles = "No workspace files found.";
  try {
    const keys = await memory.workspace.getKeys();
    if (keys.length > 0) workspaceFiles = keys.filter((key:string) => !key.startsWith('.trash/')).join('\n');
  } catch {}

  return `
---
currentDay: ${getTodayString()}
---
<!-- FILE: ./IDENTITY.md -->
${identityDoc}
<!-- END-OF-FILE: ./IDENTITY.md -->
<!-- FILE: ./SOUL.md -->
${soulDoc}
<!-- END-OF-FILE: ./SOUL.md -->
<!-- FILE: ./USER.md -->
${userDoc}
<!-- END-OF-FILE: ./USER.md -->
<!-- FILE: ./SYSTEM_INSTRUCTIONS.md -->
${systemInstructionsDoc}
<!-- END-OF-FILE: ./SYSTEM_INSTRUCTIONS.md -->
  `
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
       experimental_repairToolCall: async ({
    toolCall,
    tools,
    inputSchema,
    error,
  }) => {
    if (NoSuchToolError.isInstance(error)) {
      return null; 
    }

    const tool = tools[toolCall.toolName as keyof typeof tools];
    logger.info('we have to repair the tool call')

    const { object: repairedArgs } = await generateObject({
      model,
      schema: tool.inputSchema,
      prompt: [
        `The model tried to call the tool "${toolCall.toolName}"` +
          ` with the following inputs:`,
        JSON.stringify(toolCall.input),
        `The tool accepts the following schema:`,
        JSON.stringify(inputSchema(toolCall)),
        'Please fix the inputs.',
      ].join('\n'),
    });

    logger.info('we have a repaired tool call')

    return { ...toolCall, input: JSON.stringify(repairedArgs) };
  },
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

// --- MAIN EXPORTED CLASS ---

export class Agent {
  private memory: AgentMemory;
  private model: LanguageModel;
  private messages: ModelMessage[] = [];
  private tools: ReturnType<typeof createTools>;
  private inputAdapters: InputAdapter[] = [];
  private outputAdapters: OutputAdapter[] = [];
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
    adapter.onMessage(async (text, label) => {
      await this.memory.queue.push("main-session", { text, label });
      await this.processQueue();
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
    await this.processQueue();
  }

  private async init() {
    if (this.initialized) return;
    this.initialized = true;

    // Bootstrap: copy SYSTEM_INSTRUCTIONS.template -> workspace/SYSTEM_INSTRUCTIONS.md if missing
    // Templates are resolved from the package install directory (PACKAGE_ROOT),
    // NOT from process.cwd(), so this works correctly via npx/global install.
    const existing = await this.memory.workspace.getItem('SYSTEM_INSTRUCTIONS.md');
    if (existing) {
      logger.info('Found  SYSTEM_INSTRUCTIONS.md.')
    } else {
      try {
        const templatePath = path.join(PACKAGE_ROOT, 'template', 'SYSTEM_INSTRUCTIONS.template');
        const templateContent = await readFile(templatePath, 'utf-8');
        await this.memory.workspace.setItem('SYSTEM_INSTRUCTIONS.md', templateContent);
        logger.info('Copied SYSTEM_INSTRUCTIONS.template -> workspace/SYSTEM_INSTRUCTIONS.md');
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to copy SYSTEM_INSTRUCTIONS.template');
      }
    }

    // Bootstrap: check if SOUL.md, IDENTITY.md, or USER.md are missing
    const requiredFiles = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
    let needsBootstrap = false;
    for (const file of requiredFiles) {
      const exists = await this.memory.workspace.hasItem(file);
      if (!exists) {
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
    const savedMessages : ModelMessage[] = await this.memory.history.getAll("main-session");
    if (savedMessages.length > 0) {
      this.messages = savedMessages as ModelMessage[];
      logger.info({ count: savedMessages.length }, 'Loaded messages from history');
    } else {
      logger.debug('No messages loaded from history');
    }
  }


  private async processQueue() {
    if (this.processing) return;
    if (await this.memory.queue.empty("main-session")) return ;
    if (!this.initialized) await this.init();
    this.processing = true;

    while (true) {
      const queuedItem = await this.memory.queue.pop("main-session");
      if (!queuedItem) {
          this.processing = false;
          return;
      }
      const { text, label } = queuedItem;

      for (const out of this.outputAdapters) {
        out.onAgentStart(label);
      }

      this.messages = await this.memory.compactHistory("main-session", this.model, async () => {
        const dailyMemoryFileName = "memory:" + getTodayString() + ".md";
        const dailyMemoryFileContent = String(await this.memory.workspace.getItem(dailyMemoryFileName) || '');
        await runAgent(`I will compact the message history in a moment - please write to daily memory whatever shall not be lost.\n\n${dailyMemoryFileContent}:\n\n${dailyMemoryFileContent}`, this.memory, this.model, this.messages, this.tools, () : void => {});
      });

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
        const requiredFiles = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
        let allExist = true;
        for (const file of requiredFiles) {
          const exists = await this.memory.workspace.hasItem(file);
          if (!exists) {
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
        input = text;
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
          await this.memory.history.push("main-session", msg);
        }

        for (const out of this.outputAdapters) {
          out.onResponseEnd(fullResponse);
        }
      } catch (error: any) {
        for (const out of this.outputAdapters) {
          out.onError(error);
        }
      }
    }
  }
}
