import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Evals brauchen Zeit (LLM-backed, multi-step)
    testTimeout: 120000,
    // LLM APIs haben Rate-Limits -> Begrenze Parallelität
    maxConcurrency: 1, 
    // Evals sind Backend-Tests, kein Browser nötig
    environment: 'node', 
    include: ['**/*.eval.test.ts'], // Separate Endung für Evals
  },
});