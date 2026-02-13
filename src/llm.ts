import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { addToolInputExamplesMiddleware, extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from "ai";

// --- MODEL SETUP ---
const localProvider = createOpenAICompatible({
  name: 'mlx',
  baseURL: 'http://localhost:8000/v1',
});

export const model : LanguageModel = process.env.AI_GATEWAY_MODEL_ID ? process.env.AI_GATEWAY_MODEL_ID : wrapLanguageModel({
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