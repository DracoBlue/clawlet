import { hermesToolMiddleware, xmlToolMiddleware, yamlToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { addToolInputExamplesMiddleware, extractReasoningMiddleware, wrapLanguageModel, type LanguageModel, gateway, defaultSettingsMiddleware, type LanguageModelMiddleware } from "ai";

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
      // tool calls: temperature: 0.0, maxOutputTokens: 2048
      // normal chat: topP: 0.8, maxOutputTokens: 2048
      // no tools:
      topP: 0.9, maxOutputTokens: 8192
    },
  })
];

if (AI_GATEWAY_USE_QWEN_MIDDLEWARE) {
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
