import { readdir, readFile } from "node:fs/promises";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { getDatabaseUrl, loadEnvFiles } from "./env.mjs";

loadEnvFiles();

const scrypt = promisify(scryptCallback);

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
  console.error("DATABASE_URL is not configured.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
const migrationsDir = join(process.cwd(), "migrations");

await client.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = await client.query("select filename from schema_migrations");
  const appliedFilenames = new Set(applied.rows.map((row) => row.filename));
  const migrations = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of migrations) {
    if (appliedFilenames.has(filename)) {
      console.log(`Skipping ${filename}`);
      continue;
    }

    const sql = await readFile(join(migrationsDir, filename), "utf8");

    console.log(`Applying ${filename}`);
    await client.query("begin");

    try {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (filename) values ($1)",
        [filename],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  await bootstrapAdminUser(client);
  await grantAppRoleOperationalAccess(client);
  console.log("Migrations complete");
} finally {
  await client.end();
}

function envValue(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }

  return "";
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = await scrypt(password, salt, 64);

  return `scrypt$${salt}$${derivedKey.toString("base64url")}`;
}

async function bootstrapAdminUser(client) {
  const email = envValue("DIVES_ADMIN_EMAIL").trim().toLowerCase();
  const password = envValue("DIVES_ADMIN_PASSWORD");

  if (!email || !password) {
    console.log("Admin bootstrap skipped; admin email or password is not configured.");
    return;
  }

  const passwordHash = await hashPassword(password);
  const existing = await client.query(
    "select id from users where lower(email) = lower($1) limit 1",
    [email],
  );
  const existingUser = existing.rows[0];

  if (existingUser) {
    await client.query(
      "update users set password_hash = $2 where id = $1",
      [existingUser.id, passwordHash],
    );
    console.log(`Admin user bootstrapped for ${email}`);
    return;
  }

  await client.query(
    "insert into users (email, password_hash) values ($1, $2)",
    [email, passwordHash],
  );
  console.log(`Admin user bootstrapped for ${email}`);
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

// The app's *entire runtime* (the deployed web server, plus every CronJob
// except this migration container) connects as this restricted role, never
// as the schema owner -- see helm-charts' databaseApp vs database. Its name
// is an infra-provisioned identifier (pumpking's provisioning/terraform,
// e.g. "dev-dives.dev-dives_app") that isn't portable across
// stages/deployments, so it can't be hardcoded into a versioned .sql
// migration; this runs after every migration batch instead. Idempotent --
// GRANT and ALTER DEFAULT PRIVILEGES are both safe to repeat.
//
// Ordinary CRUD (select/insert/update/delete) on every existing table,
// covering both tables that predate this role and any migration already
// applied above in this same run. No DDL/CREATE/DROP -- schema changes stay
// owner-only, applied by this same script but never by the app at runtime.
// ALTER DEFAULT PRIVILEGES extends the same grant to tables a *future*
// migration creates, without needing to remember to grant it again by hand --
// so no per-table "app-role grant" migration is ever needed for new tables.
//
// The upstream template narrowed tos_acceptance back down to insert/select
// here; Dives never ported that table, and re-adding the revoke would fail
// outright against a table that doesn't exist.
async function grantAppRoleOperationalAccess(client) {
  const role = envValue("APP_DB_ROLE");

  if (!role) {
    console.log("App-role grant skipped; APP_DB_ROLE is not configured.");
    return;
  }

  const ident = quoteIdent(role);

  await client.query(`grant select, insert, update, delete on all tables in schema public to ${ident}`);
  await client.query(`grant usage, select on all sequences in schema public to ${ident}`);
  await client.query(
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${ident}`,
  );
  await client.query(`alter default privileges in schema public grant usage, select on sequences to ${ident}`);

  console.log(`App role ${role}: granted operational CRUD access`);
}
