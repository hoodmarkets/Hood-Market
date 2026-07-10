import winston from 'winston';

/** Safe string for logs when `error.message` is missing (some Discord.js / fetch errors). */
export function formatStartupError(error: unknown): string {
  if (error == null) return 'unknown error (null or undefined)';
  if (error instanceof Error) {
    const msg = error.message?.trim();
    if (msg) return msg;
    const anyErr = error as NodeJS.ErrnoException & { code?: string | number };
    if (anyErr.code != null) return `${error.name || 'Error'} (code ${anyErr.code})`;
    return error.name || 'Error (no message)';
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
  ],
});

if (process.env.NODE_ENV === 'production') {
  logger.add(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
  logger.add(new winston.transports.File({ filename: 'logs/combined.log' }));
}
