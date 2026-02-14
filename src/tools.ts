import {
  tool,
  streamText,
  generateText,
  stepCountIs,
  jsonSchema,
  type ModelMessage,
  type LanguageModel,
} from 'ai';
import 'dotenv/config';
import { AgentMemory } from './memory.js';
import { readFile, writeFile } from 'node:fs/promises';
import TurndownService from 'turndown';
import { logger } from './logger.js';

// Resolve the package root directory (where template/ lives), independent of cwd
const GENERATE_TEXT_TEMPERATURE = 0.6;
const GENERATE_TEXT_TOP_P = 0.95;
const GENERATE_TEXT_MAX_OUTPUT_TOKENS = 16384;
const GENERATE_TEXT_MAX_STEPS = 30;

const turndownService = new TurndownService()

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

// --- PERMISSION HELPERS ---

function matchesPermissionPattern(actual: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(actual);
}

function getTodayString(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}


// --- SKILL SYSTEM PROMPT ---
async function buildSkillSystemPrompt(name: string, memory: AgentMemory, skillPermissions: Record<string, Array<Record<string, string>>>): Promise<string> {
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

  // Read SKILL.md from skill in workspace (if it exists)
  let skillDoc = "";
  try {
    const doc = await memory.workspace.getItem('skills:' + name + ':SKILL.md');
    if (doc) skillDoc = String(doc);
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


  const permissionSectionEntries = Object.keys(skillPermissions).map((toolName: string) => {
    const permissionEntry = "- tool: " + toolName;
    const rules: Array<Record<string, string>> = skillPermissions[toolName] as any;

    if (rules.length > 0) {
      return permissionEntry + '\n' + rules.map((rule: Record<string, string>) => {
        return '   - ' + JSON.stringify(rule)
      }).join('\n');
    }

    return permissionEntry + ' (no permissions)';
  });

  const permissionsSection = permissionSectionEntries.join('\n');;

  return `
${identitySection}

# PRIME DIRECTIVE
This is a specific skill session. You must obey these rules above all else.

# OPERATIONAL PROTOCOL (The "Every Session" Loop)
1. **INITIALIZE**:
   - Read \`SKILL.md\` (provided below).
   - **MANDATORY**: Check for today's memory file (\`memory:${getTodayString()}.md\`).
   - IF it todays memory file exists -> Read it using \`fs.readFile\` to get context.
   - IF todays mmemory file does NOT exist -> Create it using \`fs.writeFile\` (start fresh).

2. **AUTH CHECK**:
   - Before external API calls, check \`connection.list\` for available connections.
   - If the connection is missing, use \`connection.create\` to register and store credentials.
   - Use \`connection.request\` for authenticated API calls (Bearer token is auto-injected).

3. **EXECUTION**:
   - Use \`fs.readFile\` and \`fs.writeFile\` to log *significant* events to append oday's memory file.
   - **Text > Brain**: If you learn something, write it down immediately.

# AVAILABLE PERMISSIONS (Permissions)
${permissionsSection}

# CORE RULES (SKILL.md)
${skillDoc}
`;
}

// --- TOOLS (built from memory) ---

export function createTools(memory: AgentMemory, model: LanguageModel) {
  return {
    now: tool({
      description: 'Get current time and date',
      inputSchema: jsonSchema<{}>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        return new Date().toISOString();
      }
    }),

    'http.request': tool({
      description: 'Execute HTTP requests. Provide method (GET/POST/PUT/DELETE), url, optional headers object, and optional unescaped body string. Returns status, statusText and data.',
      inputSchema: jsonSchema<{method?:string,url:string,headers?:Record<string,string>,body?:string,transformer?:string}>({
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method' },
          url: { type: 'string', description: 'URL to request' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional headers' },
          body: { type: 'string', description: 'Optional unescaped body string' },
          transformer: { type: 'string', enum: ['markdown'], description: 'Transform the result into e.g. markdown' }
        },
        required: ['url'],
      }),
      execute: async ({ method, url, headers, body, transformer }) => {
        const executeMethod = method ? method : 'GET';
        logger.debug({ method: executeMethod, url }, 'HTTP request');
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
          const transformedText = transformer === 'markdown' ? turndownService.turndown(text) : text;
          return JSON.stringify({
            status: res.status,
            statusText: res.statusText,
            data: transformedText.length > 5000 ? transformedText.substring(0, 5000) + "..." : transformedText
          });
        } catch (e: any) { return JSON.stringify({ error: e.message }); }
      },
    }),

    'http.get': tool({
      description: 'Shortcut for GET requests. Provide url and optional headers.',
      inputSchema: jsonSchema<{url: string, headers?: Record<string, string>, transformer?: string}>({
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to request' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional headers' },
          transformer: { type: 'string', enum: ['markdown'], description: 'Transform the result into e.g. markdown' }
        },
        required: ['url'],
      }),
      execute: async ({ url, headers, transformer }) => {
        logger.debug({ url }, 'HTTP GET');
        try {
          const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json', ...headers },
          });
          const text = await res.text();
          const transformedText = transformer === 'markdown' ? turndownService.turndown(text) : text;
          return JSON.stringify({
            status: res.status,
            statusText: res.statusText,
            data: transformedText.length > 5000 ? transformedText.substring(0, 5000) + "..." : transformedText
          });
        } catch (e: any) { return JSON.stringify({ error: e.message }); }
      },
    }),

    'http.post': tool({
      description: 'Shortcut for POST requests. Provide url, optional unescaped body string, and optional headers.',
      inputSchema: jsonSchema<{url: string, body?: string, headers?: Record<string, string>, transformer?: string}>({
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to request' },
          body: { type: 'string', description: 'Optional unescaped body string' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional headers' },
          transformer: { type: 'string', enum: ['markdown'], description: 'Transform the result into e.g. markdown' }
        },
        required: ['url'],
      }),
      execute: async ({ url, body, headers, transformer }) => {
        logger.debug({ url }, 'HTTP POST');
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
          const transformedText = transformer === 'markdown' ? turndownService.turndown(text) : text;
          return JSON.stringify({
            status: res.status,
            statusText: res.statusText,
            data: transformedText.length > 5000 ? transformedText.substring(0, 5000) + "..." : transformedText
          });
        } catch (e: any) { return JSON.stringify({ error: e.message }); }
      },
    }),

    'http.download': tool({
      description: 'Download a file from a URL and save it to the workspace. Provide url and an optional filename (defaults to the last path segment of the URL).',
      inputSchema: jsonSchema<{ url: string, filename?: string }>({
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to download from' },
          filename: { type: 'string', description: 'Filename to save as in the workspace' },
        },
        required: ['url'],
      }),
      execute: async ({ url, filename }) => {
        const name = filename || url.split('/').pop() || 'download';
        logger.debug({ url, filename: name }, 'HTTP download');
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
      inputSchema: jsonSchema<{ key: string, value: string }>({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to store' },
          value: { type: 'string', description: 'The value to store' },
        },
        required: ['key', 'value'],
      }),
      execute: async ({ key, value }) => {
        logger.debug({ key }, 'KV set');
        try {
          await memory.secrets.set(key, value);
          return `Success: Saved ${key}.`;
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'kv.get': tool({
      description: 'Retrieve a value by key from the key-value store.',
      inputSchema: jsonSchema<{ key: string }>({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to retrieve' },
        },
        required: ['key'],
      }),
      execute: async ({ key }) => {
        logger.debug({ key }, 'KV get');
        try {
          const result = await memory.secrets.get(key);
          return result ?? "NOT_FOUND";
        } catch (e: any) { return `Error: ${e.message}`; }
      }
    }),

    'kv.list': tool({
      description: 'List all keys in the key-value store.',
      inputSchema: jsonSchema<{}>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        logger.debug('KV list');
        try {
          const keys = await memory.secrets.listKeys();
          return keys.join(', ') || "EMPTY_STORE";
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'kv.delete': tool({
      description: 'Delete a key from the key-value store.',
      inputSchema: jsonSchema<{ key: string }>({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to delete' },
        },
        required: ['key'],
      }),
      execute: async ({ key }) => {
        logger.debug({ key }, 'KV delete');
        try {
          await memory.secrets.delete(key);
          return `Success: Deleted ${key}.`;
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'kv.has': tool({
      description: 'Check if a key exists in the key-value store. Returns true or false.',
      inputSchema: jsonSchema<{ key: string }>({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to check' },
        },
        required: ['key'],
      }),
      execute: async ({ key }) => {
        logger.debug({ key }, 'KV has');
        try {
          const exists = await memory.secrets.has(key);
          return exists ? "true" : "false";
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'fs.listDir': tool({
      description: 'List all files in the workspace (including memory logs and skills).',
      inputSchema: jsonSchema<{}>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        logger.debug('FS listDir');
        try {
          const keys = await memory.workspace.getKeys();
          return keys.join('\n') || "No files found.";
        } catch (e: any) { return `Error: ${e.message}`; }
      }
    }),

    'fs.readFile': tool({
      description: 'Read a file from the workspace. "path" must be one of the keys from fs.listDir (e.g. "memory:2026-02-08.md").',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to read' },
        },
        required: ['path'],
      }),
      execute: async ({ path }) => {
        logger.debug({ path }, 'FS readFile');
        try {
          const content = await memory.workspace.getItem(path);
          if (content === null || content === undefined) return "File not found. Create it first with fs.writeFile if needed.";
          return String(content);
        } catch (e: any) { return "Error reading file: " + e.message; }
      }
    }),

    'fs.writeFile': tool({
      description: 'Write or update a file in the workspace. "path" is the key/path (e.g. "memory:2026-02-08.md"), "content" is the full content.',
      inputSchema: jsonSchema<{ path: string, content: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to write' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      }),
      execute: async ({ path, content }) => {
        logger.debug({ path }, 'FS writeFile');
        try {
          await memory.workspace.setItem(path, content);
          return `Success: Wrote to ${path}`;
        } catch (e: any) { return "Error writing file: " + e.message; }
      }
    }),

    'fs.edit': tool({
      description: 'Smart edit: Replaces a specific string in a file with a new string. Use this for small, targeted changes instead of rewriting the whole file. The "find" text must be an exact, unique match.',
      inputSchema: jsonSchema<{ path: string, find: string, replace: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to edit' },
          find: { type: 'string', description: 'The EXACT text block to search for. Must be unique in the file.' },
          replace: { type: 'string', description: 'The new text to replace it with.' },
        },
        required: ['path', 'find', 'replace'],
      }),
      execute: async ({ path, find, replace }) => {
        logger.debug({ path }, 'FS edit');
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
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to delete' },
        },
        required: ['path'],
      }),
      execute: async ({ path }) => {
        try {
          const content = await memory.workspace.getItem(path);
          if (content === null || content === undefined) return "File not found.";

          if (path.startsWith('.trash:') || path.startsWith('.trash/')) {
            // Already in trash — hard delete
            logger.debug({ path }, 'FS permanentDelete');
            await memory.workspace.removeItem(path);
            return `Success: Permanently deleted ${path}`;
          } else {
            // Move to .trash/
            const trashPath = `.trash:${path}`;
            logger.debug({ path, trashPath }, 'FS softDelete');
            await memory.workspace.setItem(trashPath, content);
            await memory.workspace.removeItem(path);
            return `Success: Moved ${path} to ${trashPath}`;
          }
        } catch (e: any) { return "Error deleting file: " + e.message; }
      }
    }),

    'fs.move': tool({
      description: 'Move/rename a file in the workspace. Reads from "from", writes to "to", then removes the original.',
      inputSchema: jsonSchema<{ from: string, to: string }>({
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path/key' },
          to: { type: 'string', description: 'Destination path/key' },
        },
        required: ['from', 'to'],
      }),
      execute: async ({ from, to }) => {
        logger.debug({ from, to }, 'FS move');
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
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file to check' },
        },
        required: ['path'],
      }),
      execute: async ({ path }) => {
        logger.debug({ path }, 'FS exists');
        try {
          const exists = await memory.workspace.hasItem(path);
          return exists ? "true" : "false";
        } catch (e: any) { return `Error: ${e.message}`; }
      }
    }),

    'fs.stat': tool({
      description: 'Get metadata about a file in the workspace (e.g. mtime, size). Returns JSON with available metadata.',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path/key of the file' },
        },
        required: ['path'],
      }),
      execute: async ({ path }) => {
        logger.debug({ path }, 'FS stat');
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
      inputSchema: jsonSchema<{ name: string; url: string }>({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (e.g. "moltbook", "tavily"). Used as the folder name under skills/.' },
          url: { type: 'string', description: 'URL to the remote SKILL.md file.' },
        },
        required: ['name', 'url'],
      }),
      execute: async ({ name, url }) => {
        logger.info({ skill: name, url }, 'SKILL installing');

        // Phase 0: Validate name
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          return JSON.stringify({ error: 'Invalid skill name. Use only letters, numbers, hyphens, underscores.' });
        }

        const skillBasePath = `skills:${name}`;

        // Phase 1: Download SKILL.md
        logger.debug('SKILL step 1/4: downloading SKILL.md');
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
        logger.debug({ bytes: skillMdContent.length }, 'SKILL saved SKILL.md');

        // Phase 2: Extract additional files via LLM
        logger.debug('SKILL step 2/4: analyzing for additional files');
        let additionalFiles: Array<{ url: string; filename: string }> = [];
        try {
          const { text: installJson } = await generateText({
            model,
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
          logger.warn({ err: e }, 'SKILL could not parse additional files');
        }

        // Phase 3: Download additional files
        logger.debug({ count: additionalFiles.length }, 'SKILL step 3/4: downloading additional files');
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
            logger.debug({ filename: file.filename }, 'SKILL downloaded file');
          } catch (e: any) {
            downloadResults.push({ filename: file.filename, status: `failed: ${e.message}` });
          }
        }

        // Phase 4: Analyze permissions via LLM
        logger.debug('SKILL step 4/4: analyzing required permissions');
        let skillPermissions: Record<string, Array<Record<string, string>>> = {};
        try {
          const { text: permJson } = await generateText({
            model,
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
          logger.warn({ err: e }, 'SKILL could not analyze permissions');
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
          logger.info('SKILL updated permissions.json');
        } catch (e: any) {
          logger.warn({ err: e }, 'SKILL could not write permissions.json');
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
      inputSchema: jsonSchema<{}>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        logger.debug('CONN list');
        try {
          const settings = await readSettings();
          const names = Object.keys(settings.connections);
          return names.length > 0 ? names.join(',') : 'NO_CONNECTIONS';
        } catch (e: any) { return `Error: ${e.message}`; }
      },
    }),

    'connection.request': tool({
      description: 'Execute an authenticated HTTP request using a named connection. The connection\'s Bearer token is automatically injected into the Authorization header. If the connection does not exist, returns an error prompting you to create it first with connection.create.',
      inputSchema: jsonSchema<{ name: string; url: string; method?: string; headers?: Record<string, string>; body?: string }>({
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
      execute: async ({ name, url, method, headers, body }) => {
        logger.debug({ name, method: method || 'GET', url }, 'CONN request');
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
          logger.debug({ status: res.status }, 'CONN request response');
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
      inputSchema: jsonSchema<{name:string, url:string, method?:string, headers?:Record<string,string>, body?:string, type:string, tokenPath?:string, refreshTokenPath?:string, refreshUrl?:string}>({
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
        logger.debug({ name, method: method || 'POST', url }, 'CONN create');

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
          logger.debug({ status: res.status }, 'CONN create response');

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
        logger.info({ name }, 'CONN saved connection to settings.json');

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
      inputSchema: jsonSchema<{ name: string; prompt: string }>({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (must be installed via skill.install).' },
          prompt: { type: 'string', description: 'The prompt/message to send to the skill.' },
        },
        required: ['name', 'prompt'],
      }),
      execute: async ({ name, prompt }) => {
        logger.info({ skill: name }, 'SKILL.PROMPT starting chat');

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
          return JSON.stringify({ error: `No permissions found for skill "${name}". Ask user to install skill with skill.install tool first.` });
        }

        skillPermissions['fs.writeFile'] = skillPermissions['fs.writeFile'] || [
          {
            path: "memory/*",
            allowed: "1"
          }
        ];

        skillPermissions['fs.readFile'] = skillPermissions['fs.readFile'] || [
          {
            path: "memory/*",
            allowed: "1"
          }
        ]


        // 4. Build sandboxed tools (only tools with "allowed": true, HTTP tools get URL guards)
        const allTools = createTools(memory, model);
        const sandboxed = createSandboxedTools(allTools, skillPermissions);

        if (Object.keys(sandboxed).length === 0) {
          logger.info({ skill: name }, 'SKILL.PROMPT no tools allowed, text-only mode');
        } else {
          logger.info({ skill: name, tools: Object.keys(sandboxed) }, 'SKILL.PROMPT sandboxed tools');
        }

        // 5. Load per-skill message history (single table, partitioned by name)
        const messages: ModelMessage[] = await memory.history.getAll(name);

        // Add user prompt
        messages.push({ role: 'user', content: prompt });

        // 6. Run skill via streamText (agentic — multi-step tool use, up to 15 steps)
        logger.debug({ skill: name, prompt: prompt.substring(0, 80) }, 'SKILL.PROMPT running');
        try {
          const result = streamText({
            model,
            system: await buildSkillSystemPrompt(name, memory, skillPermissions),
            messages,
            tools: Object.keys(sandboxed).length > 0 ? sandboxed : {},
            temperature: GENERATE_TEXT_TEMPERATURE,
            topP: GENERATE_TEXT_TOP_P,
            maxOutputTokens: GENERATE_TEXT_MAX_OUTPUT_TOKENS,
            stopWhen: stepCountIs(GENERATE_TEXT_MAX_STEPS),
            onStepFinish: (step) => {
              if (step.toolCalls.length > 0) {
                const toolNames = step.toolCalls.map(t => t.toolName).join(', ');
                logger.debug({ skill: name, tools: toolNames }, 'SKILL.PROMPT executed tools');
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

          const messagesToSave: ModelMessage[] = [{ role: 'user', content: prompt }, ...responseMessages];
          await memory.history.pushMany(name, messagesToSave);

          await memory.compactHistory(name, model);

          return fullResponse || JSON.stringify({ success: true, response: '(no text response — tool actions only)' });
        } catch (e: any) {
          logger.error({ err: e }, 'SKILL.PROMPT error');
          return JSON.stringify({ error: `Skill chat failed: ${e.message}` });
        }
      },
    }),
  };
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
            logger.warn({ key, value: args[key], args, rules }, 'Skill permission denied');

            return JSON.stringify({ error: `Permission denied: ${key} not allowed for this skill with value ${args[key]}.` });
          }
        };
        return originalTool.execute(args);
      },
    });
  });


  return sandboxed;
}
