function envValue(...names: string[]) {
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

  if (!databaseHost || !databaseName) {
    throw new Error("DATABASE_URL is not configured");
  }

  const databasePort = envValue("DATABASE_PORT", "DB_PORT") ?? "5432";
  const url = new URL(`postgres://localhost/${databaseName}`);
  url.hostname = databaseHost;
  url.port = databasePort;

  if (databaseUser) url.username = databaseUser;
  if (databasePassword) url.password = databasePassword;

  return url.toString();
}
