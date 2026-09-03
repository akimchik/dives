import { inspect } from "node:util";

const INSTALLED = Symbol.for("dives.ndjson-console.installed");

export function createCronjobLogger({ service } = {}) {
  installNdjsonConsole({ service });

  return {
    info(message, context) {
      writeLog(process.stdout, { context, level: "info", message, service });
    },
    warn(message, context, error) {
      writeLog(process.stderr, normalizeLoggerArgs({ context, error, level: "warn", message, service }));
    },
    error(message, context, error) {
      writeLog(process.stderr, normalizeLoggerArgs({ context, error, level: "error", message, service }));
    },
  };
}

function installNdjsonConsole({ service } = {}) {
  if (console[INSTALLED]) return;

  const writeStdout = process.stdout.write.bind(process.stdout);
  const writeStderr = process.stderr.write.bind(process.stderr);

  console.log = (...args) => writeStdout(`${formatLog("info", args, service)}\n`);
  console.info = (...args) => writeStdout(`${formatLog("info", args, service)}\n`);
  console.warn = (...args) => writeStderr(`${formatLog("warn", args, service)}\n`);
  console.error = (...args) => writeStderr(`${formatLog("error", args, service)}\n`);

  Object.defineProperty(console, INSTALLED, {
    configurable: true,
    enumerable: false,
    value: true,
  });
}

function formatLog(level, args, service) {
  const [first, ...rest] = args;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service,
    message: formatMessage(first),
  };

  if (rest.length === 1) {
    entry.context = serializeValue(rest[0]);
  } else if (rest.length > 1) {
    entry.context = rest.map((value) => serializeValue(value));
  }

  return JSON.stringify(entry);
}

function writeLog(stream, { level, message, context, error, service }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service,
    message: String(message ?? ""),
  };

  if (context !== undefined) entry.context = serializeValue(context);
  if (error !== undefined) entry.error = serializeValue(error);

  stream.write(`${JSON.stringify(entry)}\n`);
}

function normalizeLoggerArgs({ context, error, level, message, service }) {
  if (context instanceof Error && error === undefined) {
    return { error: context, level, message, service };
  }

  return { context, error, level, message, service };
}

function formatMessage(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return inspect(value, { breakLength: Infinity, depth: 8 });
}

function serializeValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...copyEnumerableProperties(value),
    };
  }

  if (Array.isArray(value)) return value.map((item) => serializeValue(item));

  if (value && typeof value === "object") {
    return copyEnumerableProperties(value);
  }

  return value;
}

function copyEnumerableProperties(value) {
  const copy = {};
  for (const [key, propertyValue] of Object.entries(value)) {
    copy[key] = serializeValue(propertyValue);
  }
  return copy;
}
