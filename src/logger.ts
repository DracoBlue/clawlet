import 'dotenv/config';
import pino from "pino";

const isTest = process.env.NODE_ENV === "test";
const isProd = process.env.NODE_ENV === "production";
const logFile = process.env.LOG_FILE_PATH ?? `${process.cwd()}/logs/clawlet.jsonl`;

const transport = pino.transport({
  targets: [
    {
      target: "pino/file",
      level: "debug",
      options: { destination: logFile, mkdir: true }
    },
    {
      target: "pino/file",
      level: "debug",
      options: { destination: 2 }
    }
  ]
});

export const logger = isTest ? pino(
  {
    base: {
      service: process.env.SERVICE_NAME ?? "clawlet",
      env: process.env.NODE_ENV ?? "development",
      version: process.env.APP_VERSION,
    },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level(label, number) {
        return { level: number, level_label: label };
      },
    },
    level: 'debug', 
  },
  pino.destination({
    dest: 1,     
    sync: true   
  })
) : pino({
    level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
    base: {
      service: process.env.SERVICE_NAME ?? "clawlet",
      env: process.env.NODE_ENV ?? "development",
      version: process.env.APP_VERSION,
    },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level(label, number) {
        return { level: number, level_label: label };
      },
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  },
   transport
);
