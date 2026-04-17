type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  });
  process.stdout.write(`${line}\n`);
};

export const logger = {
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) =>
    emit("error", message, fields),
};
