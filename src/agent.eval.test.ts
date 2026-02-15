import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { generateText } from 'ai';
import { Agent } from './agent.js';
import { AgentMemory } from './memory.js';
import { model } from './llm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const evalDir = path.join(__dirname, 'evals');

/**
 * Unstorage uses `:` as path separator internally.
 * YAML files use `/` for readability. Normalize to `:` for workspace access.
 */
function normalizeStorageKey(key: string): string {
  return key.replace(/\//g, ':');
}

/**
 * Run an LLM-as-judge evaluation using localModel.
 * Returns true if the judge considers the eval criteria met.
 */
async function runLlmJudge(
  evalCriteria: string,
  userInput: string,
  agentOutput: string
): Promise<{ pass: boolean; reasoning: string }> {
  const { text } = await generateText({
    model,
    messages: [
      {
        role: 'system',
        content: `You are a strict test evaluator. You will be given:
1. The user's input to an AI agent
2. The agent's output/response
3. Evaluation criteria

Judge whether the agent's output meets ALL the evaluation criteria.

Respond with EXACTLY this format:
PASS or FAIL
Reasoning: <brief explanation>`
      },
      {
        role: 'user',
        content: `## User Input\n${userInput}\n\n## Agent Output\n${agentOutput}\n\n## Evaluation Criteria\n${evalCriteria}`
      }
    ],
    temperature: 0.1,
  });

  const firstLine = text.trim().split('\n')[0]?.trim().toUpperCase() ?? '';
  const pass = firstLine.startsWith('PASS');
  return { pass, reasoning: text.trim() };
}

// Default timeout for LLM-backed eval tests (2 minutes)
const EVAL_TIMEOUT = 120_000;

const runTestCaseFile = async (filename: string) => {
  const content = await fs.readFile(path.join(evalDir, filename), 'utf-8');
  const data = YAML.parse(content);
  // 1. SETUP
  const memory = await AgentMemory.createInMemory();

  // Seed workspace files
  if (data.setup?.files) {
    for (const [name, content] of Object.entries(data.setup.files)) {
      await memory.workspace.setItem(normalizeStorageKey(name), content as string);
    }
  }

  // Seed KV store
  if (data.setup?.kv) {
    for (const [key, value] of Object.entries(data.setup.kv)) {
      await memory.secrets.set(key, value as string);
    }
  }

  // 2. EXECUTION
  const agent = new Agent(memory, model);
  let output = "";

  // Output capture
  agent.addOutput({
    onAgentStart: () => {},
    onResponseChunk: () => {},
    onResponseEnd: (full) => { output = full; },
    onError: (e) => { throw e; }
  });

  await (new Promise((resolve, reject) => {
    agent.addInput({
      onMessage: async (handler : (text: string, label: string) => Promise<void>) => {
        await handler(data.input, 'test');
        resolve(true);
      },
      start: () => {}
    })
  }));

  // 3. ASSERTIONS

  // a) Response keywords (ALL must match)
  if (data.validate?.response?.contains) {
    data.validate.response.contains.forEach((keyword: string) => {
      expect(output.toLowerCase()).toContain(keyword.toLowerCase());
    });
  }

  // b) Response keywords (ALL must not match)
  if (data.validate?.response?.must_not_contain) {
    data.validate.response.must_not_contain.forEach((keyword: string) => {
      expect(output.toLowerCase()).not.toContain(keyword.toLowerCase());
    });
  }

  // c) Response keywords (ANY must match — at least one)
  if (data.validate?.response?.contains_any) {
    const matches = data.validate.response.contains_any.some(
      (keyword: string) => output.toLowerCase().includes(keyword.toLowerCase())
    );
    expect(
      matches,
      `Expected response to contain at least one of: ${data.validate.response.contains_any.join(', ')}`
    ).toBe(true);
  }

  // d) File content check
  if (data.validate?.files) {
    for (const [filepath, rules] of Object.entries(data.validate.files as Record<string, any>)) {
      const storageKey = normalizeStorageKey(filepath);
      const content = await memory.workspace.getItem(storageKey);
      // Unstorage memory driver may auto-parse JSON strings into objects
      const textContent = content
        ? (typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content))
        : "";

      // ALL must be present
      if (rules.contains) {
        rules.contains.forEach((str: string) => {
          expect(textContent, `File "${filepath}" should contain "${str}"`).toContain(str);
        });
      }

      // At least ONE must be present
      if (rules.contains_any) {
        const matches = rules.contains_any.some(
          (str: string) => textContent.includes(str)
        );
        expect(
          matches,
          `File "${filepath}" should contain at least one of: ${rules.contains_any.join(', ')}`
        ).toBe(true);
      }

      // NONE must be present
      if (rules.must_not_contain) {
        rules.must_not_contain.forEach((str: string) => {
          expect(textContent, `File "${filepath}" should NOT contain "${str}"`).not.toContain(str);
        });
      }

      // File must exist (non-empty)
      if (rules.exists === true) {
        expect(textContent.length, `File "${filepath}" should exist and not be empty`).toBeGreaterThan(0);
      }
    }
  }

  // e) KV store assertions
  if (data.validate?.kv) {
    for (const [key, rules] of Object.entries(data.validate.kv as Record<string, any>)) {
      const value = await memory.secrets.get(key);

      if (rules.exists === true) {
        expect(value, `KV key "${key}" should exist`).not.toBeNull();
      }
      if (rules.contains) {
        rules.contains.forEach((str: string) => {
          expect(value ?? '', `KV key "${key}" should contain "${str}"`).toContain(str);
        });
      }
    }
  }

  // f) LLM judge evaluation using localModel
  if (data.validate?.llm_eval) {
    const { pass, reasoning } = await runLlmJudge(
      data.validate.llm_eval,
      data.input,
      output
    );
    expect(pass, `LLM judge failed:\n${reasoning} (eval: ${data.validate.llm_eval}, output: ${output})`).toBe(true);
  }
}

describe('Agent Evals (LLM)', () => {
  it(`bootstrap_trigger`, async () => runTestCaseFile('bootstrap_trigger.yaml'), EVAL_TIMEOUT);
  it(`connection_auth`, async () => runTestCaseFile('connection_auth.yaml'), EVAL_TIMEOUT);
  it(`create_python_file`, async () => runTestCaseFile('create_python_file.yaml'), EVAL_TIMEOUT);
  it(`directory_traversal`, async () => runTestCaseFile('directory_traversal.yaml'), EVAL_TIMEOUT);
  it(`empty_directory`, async () => runTestCaseFile('empty_directory.yaml'), EVAL_TIMEOUT);
  it(`extend_agents_md`, async () => runTestCaseFile('extend_agents_md.yaml'), EVAL_TIMEOUT * 2);
  it(`external_data`, async () => runTestCaseFile('external_data.yaml'), EVAL_TIMEOUT);
  it(`file_not_found`, async () => runTestCaseFile('file_not_found.yaml'), EVAL_TIMEOUT);
  it(`memory_persistence`, async () => runTestCaseFile('memory_persistence.yaml'), EVAL_TIMEOUT);
  it(`move_and_rename`, async () => runTestCaseFile('move_and_rename.yaml'), EVAL_TIMEOUT);
  it(`needle_in_haystack`, async () => runTestCaseFile('needle_in_haystack.yaml'), EVAL_TIMEOUT);
  it(`persona_tone`, async () => runTestCaseFile('persona_tone.yaml'), EVAL_TIMEOUT);
  it(`rag_user`, async () => runTestCaseFile('rag_user.yaml'), EVAL_TIMEOUT);
  it(`reasoning_multi_step`, async () => runTestCaseFile('reasoning_multi_step.yaml'), EVAL_TIMEOUT);
  it(`refactoring_edit`, async () => runTestCaseFile('refactoring_edit.yaml'), EVAL_TIMEOUT);
  it(`skill_sandbox_execution`, async () => runTestCaseFile('skill_sandbox_execution.yaml'), EVAL_TIMEOUT);
  it(`rewrite_agents_md`, async () => runTestCaseFile('rewrite_agents_md.yaml'), EVAL_TIMEOUT);
  it(`skill_system_installation`, async () => runTestCaseFile('skill_system_installation.yaml'), EVAL_TIMEOUT);
  it(`soft_delete`, async () => runTestCaseFile('soft_delete.yaml'), EVAL_TIMEOUT);
  it(`stat_check`, async () => runTestCaseFile('stat_check.yaml'), EVAL_TIMEOUT);
  it(`workflow_cleanup`, async () => runTestCaseFile('workflow_cleanup.yaml'), EVAL_TIMEOUT);
  it(`write_complex_json`, async () => runTestCaseFile('write_complex_json.yaml'), EVAL_TIMEOUT);
});
