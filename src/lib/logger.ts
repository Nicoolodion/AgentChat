type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

function structLog(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  const output = JSON.stringify(entry);

  switch (level) {
    case "error":
      console.error(output);
      break;
    case "warn":
      console.warn(output);
      break;
    case "info":
    case "debug":
      console.log(output);
      break;
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => structLog("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => structLog("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => structLog("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => structLog("error", msg, fields),
  withRequestId: (requestId: string) => ({
    debug: (msg: string, fields?: Record<string, unknown>) => structLog("debug", msg, { requestId, ...fields }),
    info: (msg: string, fields?: Record<string, unknown>) => structLog("info", msg, { requestId, ...fields }),
    warn: (msg: string, fields?: Record<string, unknown>) => structLog("warn", msg, { requestId, ...fields }),
    error: (msg: string, fields?: Record<string, unknown>) => structLog("error", msg, { requestId, ...fields }),
  }),
};
