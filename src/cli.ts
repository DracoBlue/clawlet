import * as readline from 'readline';
import 'dotenv/config';
import { Agent, type InputAdapter, type OutputAdapter } from './agent.js';
import { Bot } from 'grammy';
import { model } from './llm.js';
import { AgentMemory } from './memory.js';

// --- CLI Input Adapter ---

class CliInput implements InputAdapter {
  private handler!: (text: string, label: string) => void;
  private rl: readline.Interface;

  constructor(rl: readline.Interface) {
    this.rl = rl;
  }

  onMessage(handler: (text: string, label: string) => void) {
    this.handler = handler;
  }

  start() {
    this.rl.on('line', (input) => {
      const trimmed = input.trim();
      if (trimmed === 'exit') process.exit(0);
      if (!trimmed) { this.rl.prompt(); return; }
      this.handler(trimmed, 'cli');
    });
    this.rl.prompt();
  }
}

// --- CLI Output Adapter ---

class CliOutput implements OutputAdapter {
  constructor(private rl: readline.Interface) {}

  onAgentStart(label: string) {
    if (label !== 'cli') {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      // The label from telegram input includes the message text via logging in TelegramInput
    }
    process.stdout.write("Agent: ");
  }

  onResponseChunk(chunk: string) {
    process.stdout.write(chunk);
  }

  onResponseEnd(_fullResponse: string) {
    console.log();
    this.rl.prompt();
  }

  onError(error: Error) {
    console.error("\n❌ Error:", error.message);
    this.rl.prompt();
  }
}

// --- Telegram Input Adapter ---

class TelegramInput implements InputAdapter {
  private handler!: (text: string, label: string) => void;
  private bot: Bot;
  private authorizedChatId: string | undefined;
  /** Shared set so the output adapter knows which chats to send to */
  private activeChatIds: Set<number>;

  constructor(bot: Bot, activeChatIds: Set<number>, authorizedChatId?: string) {
    this.bot = bot;
    this.activeChatIds = activeChatIds;
    this.authorizedChatId = authorizedChatId;
  }

  onMessage(handler: (text: string, label: string) => void) {
    this.handler = handler;
  }

  start() {
    this.bot.command("start", (ctx) => ctx.reply("Clawlet is online."));

    this.bot.on("message:text", async (ctx) => {
      const chatId = ctx.chat.id;

      if (this.authorizedChatId && chatId.toString() !== this.authorizedChatId) {
        console.log(`Unauthorized access attempt from Telegram chat ID: ${chatId}`);
        return;
      }

      this.activeChatIds.add(chatId);
      console.log(`\n[Telegram] ${ctx.message.text}`);
      this.handler(ctx.message.text, 'telegram');
    });

    this.bot.start();
    console.log("🤖 Telegram Bot started.");
  }
}

// --- Telegram Output Adapter ---

class TelegramOutput implements OutputAdapter {
  private bot: Bot;
  /** Shared reference to active chat IDs (populated by TelegramInput) */
  private activeChatIds: Set<number>;
  private typingInterval: NodeJS.Timeout | null = null;

  constructor(bot: Bot, activeChatIds: Set<number>) {
    this.bot = bot;
    this.activeChatIds = activeChatIds;
  }

  onAgentStart(_label: string) {
    if (this.activeChatIds.size === 0) return;
    for (const chatId of this.activeChatIds) {
      this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }
    this.typingInterval = setInterval(() => {
      for (const chatId of this.activeChatIds) {
        this.bot.api.sendChatAction(chatId, "typing").catch(() => {});
      }
    }, 4000);
  }

  onResponseChunk(_chunk: string) {
    // Telegram doesn't stream — full message sent at end
  }

  async onResponseEnd(fullResponse: string) {
    this.stopTyping();
    const text = fullResponse.trim() || "✅ Done.";
    for (const chatId of this.activeChatIds) {
      try {
        if (text.length > 4000) {
          const chunks = text.match(/.{1,4000}/g) || [];
          for (const chunk of chunks) {
            await this.bot.api.sendMessage(chatId, chunk);
          }
        } else {
          await this.bot.api.sendMessage(chatId, text);
        }
      } catch (e: any) {
        console.error(`  ⚠️ Failed to send to Telegram chat ${chatId}: ${e.message}`);
      }
    }
  }

  onError(error: Error) {
    this.stopTyping();
    for (const chatId of this.activeChatIds) {
      this.bot.api.sendMessage(chatId, `⚠️ Error: ${error.message}`).catch(() => {});
    }
  }

  private stopTyping() {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }
}

// --- MAIN ---

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USERINFO_ID = process.env.TELEGRAM_USERINFO_ID;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\nYou: ' });
const agent = new Agent(new AgentMemory(), model);

// Always add CLI adapters
agent.addInput(new CliInput(rl));
agent.addOutput(new CliOutput(rl));

// Add Telegram if configured via .env
if (TELEGRAM_BOT_TOKEN) {
  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  const activeChatIds = new Set<number>();

  agent.addInput(new TelegramInput(bot, activeChatIds, TELEGRAM_USERINFO_ID ?? undefined));
  agent.addOutput(new TelegramOutput(bot, activeChatIds));

  console.log("🤖 Telegram integration enabled.");
} else {
  console.log("⚠️ TELEGRAM_BOT_TOKEN not found. Running CLI only.");
}

console.log("🤖 Clawlet CLI initialized.");
await agent.start();
