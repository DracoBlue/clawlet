import {
  tool,
  addToolInputExamplesMiddleware,
  streamText,
  generateText,
  wrapLanguageModel,
  stepCountIs,
  jsonSchema,
  type ModelMessage,
  extractReasoningMiddleware,
  type ToolSet,
} from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import 'dotenv/config';
import { hermesToolMiddleware } from '@ai-sdk-tool/parser';
import { AgentMemory } from './memory.js';
import { readFile, writeFile, copyFile, access, mkdir } from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';

// Resolve the package root directory (where template/ lives), independent of cwd
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');

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

// --- MODEL SETUP ---
const localProvider = createOpenAICompatible({
  name: 'mlx',
  baseURL: 'http://localhost:8000/v1',
});

const localModel = wrapLanguageModel({
  model: localProvider.languageModel('qwen-local'),
  middleware: [
    hermesToolMiddleware,
    addToolInputExamplesMiddleware({
      prefix: 'Input Examples:',
    }),
    extractReasoningMiddleware({
      tagName: "think"
    })
  ]
});

// --- HELPERS ---

function getTodayString(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

// --- SETTINGS HELPERS ---

const SETTINGS_PATH = `${process.cwd()}/settings.json`;

interface ConnectionBearer {
  idToken: string;
  refreshToken?: string;
  refreshUrl?: string;
}

interface ConnectionEntry {
  bearer: ConnectionBearer;
}

interface SettingsFile {
  connections: Record<string, ConnectionEntry>;
}

async function readSettings(): Promise<SettingsFile> {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (!parsed.connections) parsed.connections = {};
      return parsed as SettingsFile;
    }
  } catch {}
  return { connections: {} };
}

async function writeSettings(settings: SettingsFile): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
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

// --- PERMISSION HELPERS ---

function matchesPermissionPattern(actual: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(actual);
}

function createSandboxedTools(
  allTools: ReturnType<typeof createTools>,
  permissions: Record<string, Array<Record<string, string>>>
): Record<string, any> {
  const sandboxed: Record<string, any> = {};

  Object.entries(permissions).forEach(([toolName, rules]) => {
    const hasAllowed = rules.some((r: any) => r.allowed === 'true' || r.allowed === true);
    if (!hasAllowed) return;

    const originalTool = (allTools as any)[toolName];
    if (!originalTool) return;

    sandboxed[toolName] = tool({
      description: originalTool.description,
      inputSchema: originalTool.inputSchema,
      execute: async (args: any) => {
        for (const key in args) {
          if (!rules.some(r => matchesPermissionPattern(args[key], r[key] || '*'))) {
            console.log(` 🚫 Permission denied: ${key} not allowed for this skill with value ${args[key]}. ${JSON.stringify(args)} for permission: ${JSON.stringify(rules)}`);

            return JSON.stringify({ error: `Permission denied: ${key} not allowed for this skill with value ${args[key]}.` });
          }
        };
        return originalTool.execute(args);
      },
    });
  });


  return sandboxed;
}

// --- TOOLS (built from memory) ---

function createTools(memory: AgentMemory) {
  return {
    now: tool({
      description: 'Get current time and date',
      execute: async () => {
        return new Date().toISOString();
      }
    }),

    'http.request': tool({
      description: 'Execute HTTP requests. Provide method (GET/POST/PUT/DELETE), url, optional headers object, and optional unescaped body string. Returns status, statusText and data.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method' },
          url: { type: 'string', description: 'URL to request' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional headers' },
          body: { type: 'string', description: 'Optional unescaped body string' },
        },
        required: ['url'],
      }),
      execute: async ({ method, url, headers, body }: { method?: string, url: string, headers?: Record<string, string>, body?: string }) => {
        const executeMethod = method ? method : 'GET';
        console.log(`  🌐 [HTTP] ${executeMethod} ${url}`);
        try {
          let parsedBody = body;
          if (typeof body === 'string') {
            try { parsedBody = JSON.parse(body); } catch {}
          }

          const res = await fetch(url, {
            method: executeMethod,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: parsedBody ? JSON.stringify(parsedBody) : null
          });

          const text = await res.text();
          return JSON.stringify({
            status: res.status,
            statusText: res.statusText,
            data: text.length > 2000 ? text.substring(0, 2000) + "..." : text
          });
        } catch (e: any) { return JSON.stringify({ error: e.message }); }
      },
    }),

    'http.get': tool({
      description: 'Shortcut for GET requests. Provide url and optional headers.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to request' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional headers' },
        },
        required: ['url'],
      }),
      execute: async ({ url, headers }: { url: string, headers?: Record<string, string> }) => {
        console.log(`  🌐 [HTTP] GET ${url}`);
        try {
          const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json', ...headers },
          });
          const text = await res.text();
          return JSON.stringify({
            status: res.status,
            statusText: res.statusText,
            data: text.length > 2000 ? text.substring(0, 2000) + "..." : text
          });
        } catch (e: any) { return JSON.stringify({ error: e.message }); }
      },
    }),

    'http.post': tool({
      description: 'Shortcut for POST requests. Provide url, optional unescaped body string, and optional headers.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to request' },
          body: { type: 'string', description: 'Optional unescaped body string' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional headers' },
        },
        required: ['url'],
      }),
      execute: async ({ url, body, headers }: { url: string, body?: string, headers?: Record<string, string> }) => {
        console.log(`  🌐 [HTTP] POST ${url}`);
        try {
          let parsedBody = body;
          if (typeof body === 'string') {
            try { parsedBody = JSON.parse(body); } catch {}
          }
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: parsedBody ? JSON.stringify(parsedBody) : null
          });
          const text = await res.text();
        console.log(`    -> ${res.status}`);
          return JSON.stringify({
            status: res.status,
            statusText: res.statusText,
            data: text.length > 2000 ? text.substring(0, 2000) + "..." : text
          });
        } catch (e: any) { return JSON.stringify({ error: e.message }); }
      },
    }),

    'http.download': tool({
      description: 'Download a file from a URL and save it to the workspace. Provide url and an optional filename (defaults to the last path segment of the URL).',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to download from' },
          filename: { type: 'string', description: 'Filename to save as in the workspace' },
        },
        required: ['url'],
      }),
      execute: async ({ url, filename }: { url: string, filename?: string }) => {
        const name = filename || url.split('/').pop() || 'download';
        console.log(`  ⬇️ [HTTP] download ${url} -> ${name}`);
        try {
          const res = await fetch(url);
          if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status} ${res.statusText}` });

          const buffer = await res.arrayBuffer();
          const content = Buffer.from(buffer);

          // Store as base64 for binary files, as string for text
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('text') || contentType.includes('json') || contentType.includes('xml')) {
            await memory.workspace.setItem(name, new TextDecoder().decode(content));
          } else {
            await memory.workspace.setItemRaw(name, content);
          }

          return JSON.stringify({
            status: res.status,
            filename: name,
            size: content.byteLength,
            contentType,
          });
        } catch (e: any) { return JSON.stringify({ error: e.message }); }
      },
    }),

    'kv.set': tool({
      description: 'Store a key-value pair (e.g. API keys, config). Provide "key" and "value".',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to store' },
          value: { type: 'string', description: 'The value to store' },
        },
        required: ['key', 'value'],
      }),
      execute: async ({ key, value }: { key: string, value: string }) => {
        console.log(`  🔑 [KV] set ${key}`);
        try {
          await memory.secrets.set(key, value);
          return `Success: Saved ${key}.`;
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'kv.get': tool({
      description: 'Retrieve a value by key from the key-value store.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to retrieve' },
        },
        required: ['key'],
      }),
      execute: async ({ key }: { key: string }) => {
        console.log(`  🔑 [KV] get ${key}`);
        try {
          const result = await memory.secrets.get(key);
          return result ?? "NOT_FOUND";
        } catch (e: any) { return `Error: ${e.message}`; }
      }
    }),

    'kv.list': tool({
      description: 'List all keys in the key-value store.',
      execute: async () => {
        console.log(`  🔑 [KV] list`);
        try {
          const keys = await memory.secrets.listKeys();
          return keys.join(', ') || "EMPTY_STORE";
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'kv.delete': tool({
      description: 'Delete a key from the key-value store.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to delete' },
        },
        required: ['key'],
      }),
      execute: async ({ key }: { key: string }) => {
        console.log(`  🔑 [KV] delete ${key}`);
        try {
          await memory.secrets.delete(key);
          return `Success: Deleted ${key}.`;
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'kv.has': tool({
      description: 'Check if a key exists in the key-value store. Returns true or false.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to check' },
        },
        required: ['key'],
      }),
      execute: async ({ key }: { key: string }) => {
        console.log(`  🔑 [KV] has ${key}`);
        try {
          const exists = await memory.secrets.has(key);
          return exists ? "true" : "false";
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'fs.listDir': tool({
      description: 'List all files in the workspace (including memory logs and skills).',
      execute: async () => {
        console.log(`  📂 [FS] listDir`);
        try {
          const keys = await memory.workspace.getKeys();
          return keys.join('\n') || "No files found.";
        } catch (e: any) { return `Error: ${e.message}`; }
      }
    }),

    'fs.readFile': tool({
      description: 'Read a file from the workspace. "path" must be one of the keys from fs.listDir (e.g. "memory:2026-02-08.md").',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to read' },
        },
        required: ['path'],
      }),
      execute: async ({ path }: { path: string }) => {
        console.log(`  📖 [FS] readFile ${path}`);
        try {
          const content = await memory.workspace.getItem(path);
          if (content === null || content === undefined) return "File not found. Create it first with fs.writeFile if needed.";
          return String(content);
        } catch (e: any) { return "Error reading file: " + e.message; }
      }
    }),

    'fs.writeFile': tool({
      description: 'Write or update a file in the workspace. "path" is the key/path (e.g. "memory:2026-02-08.md"), "content" is the full content.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to write' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      }),
      execute: async ({ path, content }: { path: string, content: string }) => {
        console.log(`  ✍️ [FS] writeFile ${path}`);
        try {
          await memory.workspace.setItem(path, content);
          return `Success: Wrote to ${path}`;
        } catch (e: any) { return "Error writing file: " + e.message; }
      }
    }),

    'fs.edit': tool({
      description: 'Smart edit: Replaces a specific string in a file with a new string. Use this for small, targeted changes instead of rewriting the whole file. The "find" text must be an exact, unique match.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to edit' },
          find: { type: 'string', description: 'The EXACT text block to search for. Must be unique in the file.' },
          replace: { type: 'string', description: 'The new text to replace it with.' },
        },
        required: ['path', 'find', 'replace'],
      }),
      execute: async ({ path, find, replace }: { path: string, find: string, replace: string }) => {
        console.log(`  ✏️ [FS] edit ${path}`);
        try {
          const content = await memory.workspace.getItem(path);
          if (content === null || content === undefined) return `Error: File "${path}" not found.`;

          const fileText = String(content);
          if (!fileText.includes(find)) {
            return `Error: The text to replace was not found in "${path}". Check whitespace and indentation exactly.`;
          }

          const parts = fileText.split(find);
          if (parts.length > 2) {
            return `Error: Ambiguous match. Found ${parts.length - 1} occurrences. Provide more surrounding context in "find" to make it unique.`;
          }

          const newContent = fileText.replace(find, replace);
          await memory.workspace.setItem(path, newContent);
          return `Success: Edited "${path}". Replaced 1 occurrence.`;
        } catch (e: any) { return "Error editing file: " + e.message; }
      }
    }),

    'fs.delete': tool({
      description: 'Delete a file. If the file is outside .trash/, it is moved to .trash/ (soft delete). If the file is already inside .trash/, it is permanently removed.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to delete' },
        },
        required: ['path'],
      }),
      execute: async ({ path }: { path: string }) => {
        try {
          const content = await memory.workspace.getItem(path);
          if (content === null || content === undefined) return "File not found.";

          if (path.startsWith('.trash:') || path.startsWith('.trash/')) {
            // Already in trash — hard delete
            console.log(`  🗑️ [FS] permanentDelete ${path}`);
            await memory.workspace.removeItem(path);
            return `Success: Permanently deleted ${path}`;
          } else {
            // Move to .trash/
            const trashPath = `.trash:${path}`;
            console.log(`  🗑️ [FS] softDelete ${path} -> ${trashPath}`);
            await memory.workspace.setItem(trashPath, content);
            await memory.workspace.removeItem(path);
            return `Success: Moved ${path} to ${trashPath}`;
          }
        } catch (e: any) { return "Error deleting file: " + e.message; }
      }
    }),

    'fs.move': tool({
      description: 'Move/rename a file in the workspace. Reads from "from", writes to "to", then removes the original.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path/key' },
          to: { type: 'string', description: 'Destination path/key' },
        },
        required: ['from', 'to'],
      }),
      execute: async ({ from, to }: { from: string, to: string }) => {
        console.log(`  📦 [FS] move ${from} -> ${to}`);
        try {
          const content = await memory.workspace.getItem(from);
          if (content === null || content === undefined) return `File not found: ${from}`;
          await memory.workspace.setItem(to, content);
          await memory.workspace.removeItem(from);
          return `Success: Moved ${from} to ${to}`;
        } catch (e: any) { return "Error moving file: " + e.message; }
      }
    }),

    'fs.exists': tool({
      description: 'Check if a file exists in the workspace. Returns true or false.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to check' },
        },
        required: ['path'],
      }),
      execute: async ({ path }: { path: string }) => {
        console.log(`  🔍 [FS] exists ${path}`);
        try {
          const exists = await memory.workspace.hasItem(path);
          return exists ? "true" : "false";
        } catch (e: any) { return `Error: ${e.message}`; }
      }
    }),

    'fs.stat': tool({
      description: 'Get metadata about a file in the workspace (e.g. mtime, size). Returns JSON with available metadata.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file' },
        },
        required: ['path'],
      }),
      execute: async ({ path }: { path: string }) => {
        console.log(`  📊 [FS] stat ${path}`);
        try {
          const exists = await memory.workspace.hasItem(path);
          if (!exists) return "File not found.";
          const meta = await memory.workspace.getMeta(path);
          return JSON.stringify(meta);
        } catch (e: any) { return `Error: ${e.message}`; }
      }
    }),

    'skill.install': tool({
      description: 'Install a skill from a remote URL. Downloads SKILL.md, parses it for additional files to download, analyzes required tool permissions, and saves everything to workspace under skills/<name>/.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (e.g. "moltbook", "tavily"). Used as the folder name under skills/.' },
          url: { type: 'string', description: 'URL to the remote SKILL.md file.' },
        },
        required: ['name', 'url'],
      }),
      execute: async ({ name, url }: { name: string; url: string }) => {
        console.log(`  📦 [SKILL] Installing skill "${name}" from ${url}`);

        // Phase 0: Validate name
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          return JSON.stringify({ error: 'Invalid skill name. Use only letters, numbers, hyphens, underscores.' });
        }

        const skillBasePath = `skills:${name}`;

        // Phase 1: Download SKILL.md
        console.log(`  📦 [SKILL] Step 1/4: Downloading SKILL.md...`);
        let skillMdContent: string;
        try {
          const res = await fetch(url);
          if (!res.ok) {
            return JSON.stringify({ error: `Failed to download SKILL.md: HTTP ${res.status} ${res.statusText}` });
          }
          skillMdContent = await res.text();
        } catch (e: any) {
          return JSON.stringify({ error: `Network error downloading SKILL.md: ${e.message}` });
        }
        await memory.workspace.setItem(`${skillBasePath}:SKILL.md`, skillMdContent);
        console.log(`  📦 [SKILL] Saved SKILL.md (${skillMdContent.length} bytes)`);

        // Phase 2: Extract additional files via LLM
        console.log(`  📦 [SKILL] Step 2/4: Analyzing for additional files...`);
        let additionalFiles: Array<{ url: string; filename: string }> = [];
        try {
          const { text: installJson } = await generateText({
            model: localModel,
            messages: [
              {
                role: 'system',
                content: `You are a skill file analyzer. Given a SKILL.md file, extract all additional files that need to be downloaded for complete installation. Look for:
- File tables listing URLs and filenames
- Install instructions with curl/download commands
- References to companion files (HEARTBEAT.md, MESSAGING.md, RULES.md, package.json, etc.)

Return ONLY a JSON array. Each element: {"url": "<download_url>", "filename": "<local_filename>"}.
Do NOT include SKILL.md itself. If no additional files, return [].`,
              },
              { role: 'user', content: skillMdContent },
            ],
            temperature: 0.1,
          });
          const match = installJson.match(/\[[\s\S]*\]/);
          if (match) additionalFiles = JSON.parse(match[0]);
        } catch (e: any) {
          console.log(`  ⚠️ [SKILL] Could not parse additional files: ${e.message}`);
        }

        // Phase 3: Download additional files
        console.log(`  📦 [SKILL] Step 3/4: Downloading ${additionalFiles.length} additional files...`);
        const downloadResults: Array<{ filename: string; status: string }> = [];
        for (const file of additionalFiles) {
          try {
            const res = await fetch(file.url);
            if (!res.ok) {
              downloadResults.push({ filename: file.filename, status: `failed: HTTP ${res.status}` });
              continue;
            }
            const content = await res.text();
            await memory.workspace.setItem(`${skillBasePath}:${file.filename}`, content);
            downloadResults.push({ filename: file.filename, status: 'ok' });
            console.log(`  📦 [SKILL] Downloaded ${file.filename}`);
          } catch (e: any) {
            downloadResults.push({ filename: file.filename, status: `failed: ${e.message}` });
          }
        }

        // Phase 4: Analyze permissions via LLM
        console.log(`  📦 [SKILL] Step 4/4: Analyzing required permissions...`);
        let skillPermissions: Record<string, Array<Record<string, string>>> = {};
        try {
          const { text: permJson } = await generateText({
            model: localModel,
            messages: [
              {
                role: 'system',
                content: `You are a security analyzer for AI agent skills. Analyze this SKILL.md and determine what tools and permissions it needs.

Available tools: "http.request", "http.get", "http.post", "http.download", "connection.list", "connection.request", "connection.create", "kv.set", "kv.get", "kv.list", "kv.delete", "kv.has", "fs.readFile", "fs.writeFile", "fs.edit", "fs.delete", "fs.move", "fs.listDir", "fs.exists", "fs.stat"

IMPORTANT: If the skill requires API keys or authentication, use "connection.create" and "connection.request" instead of "kv.*" tools. Connections handle registration, token storage, and authenticated requests automatically.

For HTTP tools, include "url" (pattern with * wildcard) and "method".
For connection tools, include "url" pattern and "name" of the connection.
For KV tools, include "key" pattern. Only use kv.* for non-auth data (preferences, config, caches).
For FS tools, include "path" pattern.

Return ONLY a JSON object mapping tool names to arrays of permission rules. Example:
{"connection.create": [{"name": "example", "url": "https://api.example.com/register"}], "connection.request": [{"name": "example", "url": "https://api.example.com/*", "method": "*"}]}`,
              },
              { role: 'user', content: skillMdContent },
            ],
            temperature: 0.1,
          });
          const match = permJson.match(/\{[\s\S]*\}/);
          if (match) skillPermissions = JSON.parse(match[0]);
        } catch (e: any) {
          console.log(`  ⚠️ [SKILL] Could not analyze permissions: ${e.message}`);
        }

        // Phase 5: Write permissions.json at project root
        const permissionsPath = `${process.cwd()}/permissions.json`;
        let permissionsFile: { skills: Record<string, Record<string, Array<Record<string, string>>>> } = { skills: {} };
        try {
          const existing = await readFile(permissionsPath, 'utf-8');
          const parsed = JSON.parse(existing);
          if (parsed && typeof parsed === 'object') {
            permissionsFile = parsed;
            if (!permissionsFile.skills) permissionsFile.skills = {};
          }
        } catch {
          // File doesn't exist yet, start fresh
        }
        permissionsFile.skills[name] = skillPermissions;
        try {
          await writeFile(permissionsPath, JSON.stringify(permissionsFile, null, 2), 'utf-8');
          console.log(`  📦 [SKILL] Updated permissions.json`);
        } catch (e: any) {
          console.log(`  ⚠️ [SKILL] Could not write permissions.json: ${e.message}`);
        }

        return JSON.stringify({
          success: true,
          skill: name,
          files: [
            { filename: 'SKILL.md', status: 'ok' },
            ...downloadResults,
          ],
          permissions: skillPermissions,
          message: `Skill "${name}" installed with ${downloadResults.filter(r => r.status === 'ok').length + 1} files.`,
        });
      },
    }),

    'connection.list': tool({
      description: 'List all available connections (configured API credentials). Returns comma-separated connection names.',
      execute: async () => {
        console.log(`  🔌 [CONN] list`);
        try {
          const settings = await readSettings();
          const names = Object.keys(settings.connections);
          return names.length > 0 ? names.join(',') : 'NO_CONNECTIONS';
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'connection.request': tool({
      description: 'Execute an authenticated HTTP request using a named connection. The connection\'s Bearer token is automatically injected into the Authorization header. If the connection does not exist, returns an error prompting you to create it first with connection.create.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Connection name (e.g. "petstore", "moltbook")' },
          url: { type: 'string', description: 'URL to request' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method (default: GET)' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional additional headers' },
          body: { type: 'string', description: 'Optional request body string' },
        },
        required: ['name', 'url'],
      }),
      execute: async ({ name, url, method, headers, body }: { name: string; url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
        console.log(`  🔌 [CONN] request "${name}" ${method || 'GET'} ${url}`);
        const settings = await readSettings();
        const conn = settings.connections[name];

        if (!conn) {
          return JSON.stringify({
            error: `Connection "${name}" not found. Available connections: ${Object.keys(settings.connections).join(', ') || 'none'}. Use connection.create to set up this connection first.`,
          });
        }

        const executeMethod = method || 'GET';
        try {
          let parsedBody = body;
          if (typeof body === 'string') {
            try { parsedBody = JSON.parse(body); } catch {}
          }

          const res = await fetch(url, {
            method: executeMethod,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${conn.bearer.idToken}`,
              ...headers,
            },
            body: parsedBody ? JSON.stringify(parsedBody) : null,
          });

          const text = await res.text();
          console.log(`    -> ${res.status}`);
          return JSON.stringify({
            status: res.status,
            statusText: res.statusText,
            data: text.length > 2000 ? text.substring(0, 2000) + '...' : text,
          });
        } catch (e: any) { return JSON.stringify({ error: e.message }); }
      },
    }),

    'connection.create': tool({
      description: 'Create a new connection by calling a registration endpoint. Sends the request, extracts the API key from the response, and stores the connection in settings.json. The "type" must be "Bearer". The response should contain the API key and optionally a refresh token/URL.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Connection name (e.g. "moltbook", "petstore")' },
          url: { type: 'string', description: 'Registration endpoint URL' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT'], description: 'HTTP method (default: POST)' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional headers' },
          body: { type: 'string', description: 'Optional request body string' },
          type: { type: 'string', enum: ['Bearer'], description: 'Auth type. Currently only "Bearer" is supported.' },
          tokenPath: { type: 'string', description: 'JSON path to the API key in the response (e.g. "agent.api_key"). Dot-separated. Defaults to "api_key".' },
          refreshTokenPath: { type: 'string', description: 'Optional JSON path to the refresh token in the response (e.g. "agent.verification_code").' },
          refreshUrl: { type: 'string', description: 'Optional URL for token refresh.' },
        },
        required: ['name', 'url', 'type'],
      }),
      execute: async ({ name, url, method, headers, body, type, tokenPath, refreshTokenPath, refreshUrl }: {
        name: string; url: string; method?: string; headers?: Record<string, string>; body?: string;
        type: string; tokenPath?: string; refreshTokenPath?: string; refreshUrl?: string;
      }) => {
        console.log(`  🔌 [CONN] create "${name}" via ${method || 'POST'} ${url}`);

        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          return JSON.stringify({ error: 'Invalid connection name. Use only letters, numbers, hyphens, underscores.' });
        }

        if (type !== 'Bearer') {
          return JSON.stringify({ error: `Unsupported auth type "${type}". Only "Bearer" is supported.` });
        }

        // Execute registration request
        const executeMethod = method || 'POST';
        let responseData: any;
        let responseText: string;
        try {
          let parsedBody = body;
          if (typeof body === 'string') {
            try { parsedBody = JSON.parse(body); } catch {}
          }

          const res = await fetch(url, {
            method: executeMethod,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: parsedBody ? JSON.stringify(parsedBody) : null,
          });

          responseText = await res.text();
          console.log(`    -> ${res.status}`);

          if (!res.ok) {
            return JSON.stringify({ error: `Registration failed: HTTP ${res.status} ${res.statusText}`, data: responseText.substring(0, 500) });
          }

          responseData = JSON.parse(responseText);
        } catch (e: any) {
          return JSON.stringify({ error: `Registration request failed: ${e.message}` });
        }

        // Extract token from response using dot-path
        const tPath = tokenPath || 'api_key';
        let idToken: string | undefined;
        try {
          idToken = tPath.split('.').reduce((obj: any, key: string) => obj?.[key], responseData);
        } catch {}

        if (!idToken || typeof idToken !== 'string') {
          return JSON.stringify({
            error: `Could not extract token at path "${tPath}" from response.`,
            response: responseText!.substring(0, 500),
          });
        }

        // Extract optional refresh token
        let refreshToken: string | undefined;
        if (refreshTokenPath) {
          try {
            refreshToken = refreshTokenPath.split('.').reduce((obj: any, key: string) => obj?.[key], responseData);
          } catch {}
        }

        // Save to settings.json
        const settings = await readSettings();
        settings.connections[name] = {
          bearer: {
            idToken,
            ...(refreshToken ? { refreshToken } : {}),
            ...(refreshUrl ? { refreshUrl } : {}),
          },
        };
        await writeSettings(settings);
        console.log(`  🔌 [CONN] Saved connection "${name}" to settings.json`);

        return JSON.stringify({
          success: true,
          connection: name,
          response: responseData,
          message: `Connection "${name}" created and saved. Bearer token stored.`,
        });
      },
    }),

    'skill.prompt': tool({
      description: 'Chat with an installed skill in a sandboxed environment. The skill runs with its own message history and only the tools allowed by permissions.json (entries with "allowed": true).',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (must be installed via skill.install).' },
          prompt: { type: 'string', description: 'The prompt/message to send to the skill.' },
        },
        required: ['name', 'prompt'],
      }),
      execute: async ({ name, prompt }: { name: string; prompt: string }) => {
        console.log(`  💬 [SKILL.PROMPT] Starting chat with "${name}"`);

        // 1. Validate name
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          return JSON.stringify({ error: 'Invalid skill name.' });
        }

        // 2. Read SKILL.md as system prompt
        const skillMd = await memory.workspace.getItem(`skills:${name}:SKILL.md`);
        if (!skillMd) {
          return JSON.stringify({ error: `Skill "${name}" not found. Install it first with skill.install.` });
        }

        // 3. Read permissions.json
        const permissionsPath = `${process.cwd()}/permissions.json`;
        let skillPermissions: Record<string, Array<Record<string, string>>> = {};
        try {
          const raw = await readFile(permissionsPath, 'utf-8');
          const parsed = JSON.parse(raw);
          skillPermissions = parsed?.skills?.[name] ?? {};
        } catch {
          return JSON.stringify({ error: `No permissions found for skill "${name}". Run skill.install first.` });
        }

        // 4. Build sandboxed tools (only tools with "allowed": true, HTTP tools get URL guards)
        const allTools = createTools(memory);
        const sandboxed = createSandboxedTools(allTools, skillPermissions);

        if (Object.keys(sandboxed).length === 0) {
          console.log(`  🔒 [SKILL.PROMPT] "${name}": no tools allowed, text-only mode`);
        } else {
          console.log(`  🔒 [SKILL.PROMPT] "${name}": sandboxed tools: ${Object.keys(sandboxed).join(', ')}`);
        }

        // 5. Load per-skill message history (single table, partitioned by name)
        const messages: ModelMessage[] = []; // await memory.skillHistory.getAll(name);

        // Inject system prompt if this is a fresh history
        if (messages.length === 0) {
          messages.push({ role: 'system', content: String(skillMd) });
        }

        // Add user prompt
        messages.push({ role: 'user', content: prompt });

        // 6. Run skill via streamText (agentic — multi-step tool use, up to 15 steps)
        console.log(`  💬 [SKILL.PROMPT] Running "${name}" with prompt: ${prompt.substring(0, 80)}...`);
        try {
          const result = streamText({
            model: localModel,
            messages,
            tools: Object.keys(sandboxed).length > 0 ? sandboxed : {},
            temperature: 0.6,
            topP: 0.95,
            stopWhen: stepCountIs(30),
            onStepFinish: (step) => {
              if (step.toolCalls.length > 0) {
                const toolNames = step.toolCalls.map(t => t.toolName).join(', ');
                console.log(`  🛠️  [SKILL.PROMPT/${name}] Executed: ${toolNames}`);
              }
            },
          });

          // Consume the full stream and collect the response
          let fullResponse = "";
          for await (const delta of result.textStream) {
            fullResponse += delta;
          }

          // Persist messages to skill history after stream completes
          const responseMessages = (await result.response).messages;

          await memory.skillHistory.push(name, { role: 'user', content: prompt });
          for (const msg of responseMessages) {
            if (typeof msg.content !== "string") {
              msg.content = msg.content.filter((part) => part.type !== 'reasoning');
            }
            await memory.skillHistory.push(name, msg);
          }

          return fullResponse || JSON.stringify({ success: true, response: '(no text response — tool actions only)' });
        } catch (e: any) {
          console.error(`  ❌ [SKILL.PROMPT] Error:`, e);
          return JSON.stringify({ error: `Skill chat failed: ${e.message}` });
        }
      },
    }),
  };
}

// --- AGENT RUNNER ---

async function runAgent(
  input: string,
  memory: AgentMemory,
  messages: ModelMessage[],
  tools: ReturnType<typeof createTools>,
  onResponseChunk?: (chunk: string) => void
): Promise<ModelMessage[]> {
  const message : ModelMessage = { role: 'user', content: input };
  messages.push(message);

  try {
    const result = await streamText({
      model: localModel,
      system: await buildSystemPrompt(memory),
      messages,
      tools,
      temperature: 0.6,
      topP: 0.95,
      stopWhen: stepCountIs(30),

      onStepFinish: (step) => {
        if (step.toolCalls.length > 0) {
          const names = step.toolCalls.map(t => t.toolName).join(', ');
          console.log(`  🛠️  [Executed: ${names}] `);
        }
      },
    });

    let fullResponse = "";

    for await (const delta of result.textStream) {
      fullResponse += delta;
      if (onResponseChunk) {
        onResponseChunk(delta);
      }
    }

    const responseMessages = (await result.response).messages;
    messages.push(...responseMessages);

    return responseMessages;

  } catch (e) {
    console.error("\n❌ Error:", e);
    return [];
  }
}

// --- COMPACTION CONFIG ---
const COMPACT_THRESHOLD = 25;  // Trigger compaction when history reaches this many items
const COMPACT_RANGE = 10;      // Number of messages to summarize (items 1..10, skipping system prompt at 0)

// --- MAIN EXPORTED CLASS ---

export class Agent {
  private memory: AgentMemory;
  private messages: ModelMessage[] = [];
  private tools: ReturnType<typeof createTools>;
  private inputAdapters: InputAdapter[] = [];
  private outputAdapters: OutputAdapter[] = [];
  private inputQueue: { text: string; label: string }[] = [];
  private processing = false;
  private initialized = false;
  private bootstrapPrompt: string | null = null;

  constructor(memory?: AgentMemory) {
    this.memory = memory ?? new AgentMemory();
    this.tools = createTools(this.memory);
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
        console.log(`  📋 Copied AGENTS.template -> workspace/AGENTS.md`);
      } catch (e: any) {
        console.error(`  ⚠️ Failed to copy AGENTS.template: ${e.message}`);
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
        console.log(`  🚀 Bootstrap mode: SOUL.md, IDENTITY.md, or USER.md missing. Running BOOTSTRAP.md first.`);
      } catch (e: any) {
        console.error(`  ⚠️ Failed to read BOOTSTRAP.md: ${e.message}`);
      }
    }

    // Load history from DB
    const savedMessages : ModelMessage[] = []; // (await this.memory.history.getAll());
    if (savedMessages.length > 0) {
      this.messages = savedMessages as ModelMessage[];
      console.log(`  📜 Loaded ${savedMessages.length} messages from history.`);
    } else {
      console.log(`  📜 Did not load any messages from history.`);
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

    console.log(`  🗜️  Compacting history: ${this.messages.length} messages -> summarizing first ${COMPACT_RANGE} (after system prompt)...`);

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
        model: localModel,
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
      const newMessages = await runAgent(input, this.memory, this.messages, this.tools, (chunk) => {
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
