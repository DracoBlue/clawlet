import { hermesToolMiddleware, xmlToolMiddleware, yamlToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { addToolInputExamplesMiddleware, extractReasoningMiddleware, wrapLanguageModel, type LanguageModel, gateway } from "ai";

const OPENAI_COMPATIBLE_MODEL_ID = process.env.OPENAI_COMPATIBLE_MODEL_ID ?? 'qwen-local';
const OPENAI_COMPATIBLE_BASE_URL = process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'http://localhost:8000/v1';
const AI_GATEWAY_USE_QWEN_MIDDLEWARE = process.env.AI_GATEWAY_USE_QWEN_MIDDLEWARE ?? '';

// --- MODEL SETUP ---
const localProvider = createOpenAICompatible({
  name: 'local',
  baseURL: OPENAI_COMPATIBLE_BASE_URL,
});

export const model : LanguageModel = process.env.AI_GATEWAY_MODEL_ID ? (AI_GATEWAY_USE_QWEN_MIDDLEWARE ? wrapLanguageModel({
  model: gateway(process.env.AI_GATEWAY_MODEL_ID),
  middleware: [
    hermesToolMiddleware,
    //xmlToolMiddleware,
    addToolInputExamplesMiddleware({  prefix: 'Input Examples:', }),
    extractReasoningMiddleware({
      tagName: "think"
    })
  ]
}) : process.env.AI_GATEWAY_MODEL_ID) : wrapLanguageModel({
  model: localProvider.languageModel(OPENAI_COMPATIBLE_MODEL_ID),
  middleware: [
    hermesToolMiddleware,
    //xmlToolMiddleware,
    addToolInputExamplesMiddleware({  prefix: 'Input Examples:', }),
    extractReasoningMiddleware({
      tagName: "think"
    })
  ]
});
