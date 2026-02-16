import { hermesToolMiddleware, xmlToolMiddleware, yamlToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, jsonSchema, addToolInputExamplesMiddleware, extractReasoningMiddleware, wrapLanguageModel, type LanguageModel, gateway, defaultSettingsMiddleware, type LanguageModelMiddleware, generateText, Output, extractJsonMiddleware } from "ai";
import { logger } from './logger.js';

import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3FunctionTool,
  LanguageModelV3,
} from '@ai-sdk/provider';

// --- TOOL CALL JSON REPAIR ---

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;
const TOOL_NAME_RE = /"name"\s*:\s*"([^"]+)"/;

/**
 * Scans text for <tool_call>...</tool_call> blocks with broken JSON.
 * If found, uses the LLM + the tool's inputSchema to repair the arguments.
 * Returns the repaired text (or original if nothing needed fixing).
 */
async function repairToolCallsInText(
  text: string,
  tools: Array<LanguageModelV3FunctionTool> | undefined,
  repairModel: LanguageModelV3
): Promise<string> {
  if (!tools || tools.length === 0) return text;

  const matches = [...text.matchAll(TOOL_CALL_RE)];
  if (matches.length === 0) return text;

  let repairedText = text;

  for (const match of matches) {
    const fullMatch = match[0];
    const rawJson = match[1]?.trim();
    if (!rawJson) continue;

    // Try parsing — if valid JSON, no repair needed
    try {
      JSON.parse(rawJson);
      continue;
    } catch {
      // JSON is broken — attempt repair
    }

    // Extract tool name via regex
    const nameMatch = rawJson.match(TOOL_NAME_RE);
    if (!nameMatch?.[1]) {
      logger.warn({ rawJson: rawJson.slice(0, 200) }, 'fixJsonToolCall: broken JSON but could not extract tool name');
      continue;
    }
    const toolName = nameMatch[1];

    // Find matching tool in params.tools
    const tool = tools.find(t => t.type === 'function' && t.name === toolName) as LanguageModelV3FunctionTool | undefined;
    if (!tool) {
      logger.warn({ toolName }, 'fixJsonToolCall: tool not found in params.tools');
      continue;
    }

    logger.info({ toolName }, 'fixJsonToolCall: repairing broken tool call JSON');

    try {
      const result = await generateText({
        model: wrapLanguageModel({
          model: repairModel,
          middleware: [
            extractJsonMiddleware()
          ]
        }),
        prompt: [
          `The model tried to call the tool "${toolName}" with the following (broken) JSON:`,
          rawJson,
          `The tool accepts the following input schema:`,
          JSON.stringify(tool.inputSchema),
          'Please extract and fix the arguments to match the schema. No talking or explaining: just the JSON in markdown for the final json.',
        ].join('\n'),
      });

      const repairedJson = JSON.stringify({ name: toolName, arguments: JSON.parse(result.text) });
      repairedText = repairedText.replace(fullMatch, `<tool_call>${repairedJson}</tool_call>`);
      logger.info({ toolName }, 'fixJsonToolCall: successfully repaired tool call');
    } catch (e: any) {
      logger.error({ toolName, err: e.message }, 'fixJsonToolCall: repair via generateObject failed');
    }
  }

  return repairedText;
}

/**
 * Middleware that intercepts raw model output and repairs broken JSON
 * inside <tool_call> tags before hermesToolMiddleware tries to parse them.
 *
 * Must be placed AFTER hermesToolMiddleware in the middleware array
 * so it wraps closer to the model (inner layer = sees raw output first).
 */
export const fixJsonToolCallMiddleware: LanguageModelV3Middleware = {
  specificationVersion: 'v3',
  wrapGenerate: async ({ doGenerate, params: { tools } }) => {
    const result = await doGenerate();

    // Repair broken <tool_call> JSON in text content parts
    const functionTools = tools?.filter((t): t is LanguageModelV3FunctionTool => t.type === 'function');
    if (functionTools && functionTools.length > 0 && result.content) {
      for (let i = 0; i < result.content.length; i++) {
        const part = result.content[i];
        if (part?.type === 'text' && part.text.includes('<tool_call>')) {
          const repaired = await repairToolCallsInText(part.text, functionTools, unwrappedModel);
          if (repaired !== part.text) {
            result.content[i] = { ...part, text: repaired };
          }
        }
      }
    }

    return result;
  },

  wrapStream: async ({ doStream, params: { tools } }) => {
    const { stream, ...rest } = await doStream();

    let generatedText = '';
    const textBlocks = new Map<string, string>();
    const functionTools = tools?.filter((t): t is LanguageModelV3FunctionTool => t.type === 'function');

    // Buffer all chunks so we can repair before forwarding
    const allChunks: LanguageModelV3StreamPart[] = [];

    const transformStream = new TransformStream<
      LanguageModelV3StreamPart,
      LanguageModelV3StreamPart
    >({
      transform(chunk, controller) {
        switch (chunk.type) {
          case 'text-start': {
            textBlocks.set(chunk.id, '');
            break;
          }
          case 'text-delta': {
            const existing = textBlocks.get(chunk.id) || '';
            textBlocks.set(chunk.id, existing + chunk.delta);
            generatedText += chunk.delta;
            break;
          }
        }

        // Buffer chunks — we'll flush them after potential repair
        allChunks.push(chunk);
      },

      async flush(controller) {
        // Check if any text block contains a broken <tool_call>
        let needsRepair = false;
        if (functionTools && functionTools.length > 0) {
          for (const [, blockText] of textBlocks) {
            if (blockText.includes('<tool_call>')) {
              // Check if any <tool_call> block has broken JSON
              const matches = [...blockText.matchAll(TOOL_CALL_RE)];
              for (const m of matches) {
                try { JSON.parse(m[1]?.trim() ?? ''); } catch { needsRepair = true; break; }
              }
            }
            if (needsRepair) break;
          }
        }

        if (needsRepair) {
          // Repair text blocks and re-emit chunks with fixed deltas
          const repairedBlocks = new Map<string, string>();
          for (const [id, blockText] of textBlocks) {
            repairedBlocks.set(id, await repairToolCallsInText(blockText, functionTools!, unwrappedModel));
          }

          // Re-emit: for each text block, emit start + single delta with full repaired text + end
          // Non-text chunks pass through as-is
          const emittedTextIds = new Set<string>();
          for (const chunk of allChunks) {
            if (chunk.type === 'text-start' && !emittedTextIds.has(chunk.id)) {
              emittedTextIds.add(chunk.id);
              controller.enqueue(chunk);
              const repaired = repairedBlocks.get(chunk.id) ?? textBlocks.get(chunk.id) ?? '';
              controller.enqueue({ type: 'text-delta', id: chunk.id, delta: repaired });
              controller.enqueue({ type: 'text-end', id: chunk.id });
            } else if (chunk.type === 'text-delta' || chunk.type === 'text-end') {
              // Skip original text deltas/ends — we replaced them above
            } else {
              controller.enqueue(chunk);
            }
          }
        } else {
          // No repair needed — forward all buffered chunks as-is
          for (const chunk of allChunks) {
            controller.enqueue(chunk);
          }
        }
      },
    });

    return {
      stream: stream.pipeThrough(transformStream),
      ...rest,
    };
  },
};

const OPENAI_COMPATIBLE_MODEL_ID = process.env.OPENAI_COMPATIBLE_MODEL_ID ?? 'qwen-local';
const OPENAI_COMPATIBLE_BASE_URL = process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'http://localhost:8000/v1';
const AI_GATEWAY_USE_QWEN_MIDDLEWARE = process.env.AI_GATEWAY_USE_QWEN_MIDDLEWARE ?? (!process.env.AI_GATEWAY_MODEL_ID ? '1' : '');

// --- MODEL SETUP ---
const localProvider = createOpenAICompatible({
  name: 'local',
  baseURL: OPENAI_COMPATIBLE_BASE_URL,
});

const unwrappedModel : LanguageModel = process.env.AI_GATEWAY_MODEL_ID ? gateway.languageModel(process.env.AI_GATEWAY_MODEL_ID) : localProvider.languageModel(OPENAI_COMPATIBLE_MODEL_ID);

const middleware : LanguageModelMiddleware[] = [
  defaultSettingsMiddleware({
    settings: {
      //tool calls:
      temperature: 0.0, maxOutputTokens: 2048
      // normal chat: topP: 0.8, maxOutputTokens: 2048
      // no tools:
      //topP: 0.9, maxOutputTokens: 8192
    },
  }),
];

if (AI_GATEWAY_USE_QWEN_MIDDLEWARE) {
  // Order matters: hermesToolMiddleware wraps outside fixJsonToolCallMiddleware,
  // so fixJson sees raw model output first, repairs broken JSON, then hermes parses it.
  middleware.push(fixJsonToolCallMiddleware);
  middleware.push(hermesToolMiddleware);
  middleware.push(addToolInputExamplesMiddleware({  prefix: 'Input Examples:', }));
  middleware.push(extractReasoningMiddleware({
    tagName: "think"
  }));
}

export const model : LanguageModel = wrapLanguageModel({
  model: unwrappedModel,
  middleware
});
