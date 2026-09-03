import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFiles() {
  for (const file of [".env", ".env.local"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;

    const lines = readFileSync(path, "utf8").split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] ??= value;
    }
  }
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  return undefined;
}

export function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  const databaseUser = envValue("DATABASE_USER", "DB_USER", "db_username");
  const databasePassword = envValue("DATABASE_PASSWORD", "DB_PASSWORD", "db_password");

  if (databaseUrl) {
    if (!databaseUser && !databasePassword) return databaseUrl;

    const url = new URL(databaseUrl);

    if (databaseUser) url.username = databaseUser;
    if (databasePassword) url.password = databasePassword;

    return url.toString();
  }

  const databaseHost = envValue("DATABASE_HOST", "DB_HOST");
  const databaseName = envValue("DATABASE_NAME", "DB_NAME");

  if (!databaseHost || !databaseName) return null;

  const databasePort = envValue("DATABASE_PORT", "DB_PORT") ?? "5432";
  const url = new URL(`postgres://localhost/${databaseName}`);
  url.hostname = databaseHost;
  url.port = databasePort;

  if (databaseUser) url.username = databaseUser;
  if (databasePassword) url.password = databasePassword;

  return url.toString();
}
