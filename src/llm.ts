import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { addToolInputExamplesMiddleware, extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from "ai";

const OPENAI_COMPATIBLE_MODEL_ID = process.env.OPENAI_COMPATIBLE_MODEL_ID ?? 'qwen-local';
const OPENAI_COMPATIBLE_BASE_URL = process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'http://localhost:8000/v1';

// --- MODEL SETUP ---
const localProvider = createOpenAICompatible({
  name: 'local',
  baseURL: OPENAI_COMPATIBLE_BASE_URL,
});

export const model : LanguageModel = process.env.AI_GATEWAY_MODEL_ID ? process.env.AI_GATEWAY_MODEL_ID : wrapLanguageModel({
  model: localProvider.languageModel(OPENAI_COMPATIBLE_MODEL_ID),
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