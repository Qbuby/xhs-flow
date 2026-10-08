import pino from 'pino';
import { ROOT_DIR } from './config.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.stdout.isTTY
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      }
    : undefined,
  base: { root: ROOT_DIR },
});

export type Logger = typeof logger;