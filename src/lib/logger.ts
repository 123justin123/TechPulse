export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
  child(scope: string): Logger;
}

export type LogWriter = (level: LogLevel, line: string, detail?: unknown) => void;

const writeToConsole: LogWriter = (level, line, detail) => {
  const write = level === "error" || level === "warn" ? console.error : console.log;
  if (detail === undefined) {
    write(line);
  } else {
    write(line, detail);
  }
};

export function createLogger(scope: string, level: LogLevel = "info", write: LogWriter = writeToConsole): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const emit = (lineLevel: LogLevel) => (message: string, detail?: unknown) => {
    if (LOG_LEVELS.indexOf(lineLevel) > threshold) return;
    write(lineLevel, `${new Date().toISOString()} [${lineLevel.toUpperCase()}] [${scope}] ${message}`, detail);
  };

  return {
    error: emit("error"),
    warn: emit("warn"),
    info: emit("info"),
    debug: emit("debug"),
    child: (childScope) => createLogger(childScope, level, write),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
