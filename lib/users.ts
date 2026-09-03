import "server-only";

import { getPool, queryRead } from "./db";
import { hashPassword } from "./passwords";

export type AppUser = {
  id: string;
  email: string;
  // Synced from Authentik's "dev-dives/admin" entitlement claim on every
  // OIDC login (see findOrCreateOidcUser below), or hardcoded true for the
  // password-login bootstrap admin -- see isBootstrapAdminEmail.
  isAdmin: boolean;
  lastActivityAt: Date | null;
  createdAt: Date;
};

type UserRow = {
  id: number;
  email: string;
  password_hash: string | null;
  oidc_subject: string | null;
  is_admin: boolean;
  last_activity_at: Date | null;
  created_at: Date;
};

const userColumns = "id, email, password_hash, oidc_subject, is_admin, last_activity_at, created_at";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

// The bootstrap admin (DIVES_ADMIN_EMAIL) is always treated as admin
// independent of Authentik entirely -- an OIDC login for this same email
// (linked onto that row, see findOrCreateOidcUser below) must never demote
// it just because that particular login lacked the "dev-dives/admin"
// entitlement.
function isBootstrapAdminEmail(email: string) {
  const bootstrapEmail = process.env.DIVES_ADMIN_EMAIL?.trim().toLowerCase();
  return !!bootstrapEmail && bootstrapEmail === email;
}

function toUser(row: UserRow): AppUser {
  return {
    id: String(row.id),
    email: row.email,
    isAdmin: row.is_admin || isBootstrapAdminEmail(normalizeEmail(row.email)),
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
  };
}

export async function findActiveUserByEmail(email: string) {
  const result = await queryRead<UserRow>(
    `
      select ${userColumns}
      from users
      where lower(email) = lower($1)
      limit 1
    `,
    [normalizeEmail(email)],
  );

  const row = result.rows[0];
  return row ? { ...toUser(row), password_hash: row.password_hash } : null;
}

export async function findActiveUserById(id: string) {
  const result = await queryRead<UserRow>(
    `
      select ${userColumns}
      from users
      where id = $1
      limit 1
    `,
    [id],
  );

  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export async function createUser(input: { email: string; password: string }) {
  const passwordHash = await hashPassword(input.password);

  const result = await getPool().query<UserRow>(
    `
      insert into users (email, password_hash)
      values ($1, $2)
      returning ${userColumns}
    `,
    [normalizeEmail(input.email), passwordHash],
  );

  return toUser(result.rows[0]);
}

// Resolves an Authentik login to a local user row: match by oidc_subject
// first, then fall back to matching by email (linking the OIDC identity
// onto a pre-existing password-based row, e.g. an existing account whose
// email now matches an Authentik identity), and only create a new row if
// neither match hits. `isAdmin` reflects this login's "dev-dives/admin"
// entitlement and is synced onto the row every time (except the bootstrap
// admin, see isBootstrapAdminEmail) -- an admin demoted in Authentik loses
// admin here on their next login, not before (same "checked at login"
// model as email/sub).
// `created` tells callers (the OIDC callback route) whether this login just
// registered a new account or matched an existing one -- needed to fire a
// signup metric only on the former, since this function also runs on every
// returning OIDC login.
export async function findOrCreateOidcUser(
  sub: string,
  email: string,
  isAdmin: boolean,
): Promise<{ user: AppUser; created: boolean }> {
  const normalized = normalizeEmail(email);

  const bySubject = await queryRead<UserRow>(
    `select ${userColumns} from users where oidc_subject = $1 limit 1`,
    [sub],
  );

  if (bySubject.rows[0]) {
    const row = bySubject.rows[0];
    if (row.is_admin !== isAdmin) {
      await getPool().query("update users set is_admin = $1 where id = $2", [isAdmin, row.id]);
      row.is_admin = isAdmin;
    }
    return { user: toUser(row), created: false };
  }

  const byEmail = await queryRead<UserRow>(
    `select ${userColumns} from users where lower(email) = lower($1) limit 1`,
    [normalized],
  );

  if (byEmail.rows[0]) {
    const row = byEmail.rows[0];
    await getPool().query("update users set oidc_subject = $1, is_admin = $2 where id = $3", [
      sub,
      isAdmin,
      row.id,
    ]);
    return { user: toUser({ ...row, oidc_subject: sub, is_admin: isAdmin }), created: false };
  }

  const created = await getPool().query<UserRow>(
    `
      insert into users (email, oidc_subject, is_admin)
      values ($1, $2, $3)
      returning ${userColumns}
    `,
    [normalized, sub, isBootstrapAdminEmail(normalized) || isAdmin],
  );

  return { user: toUser(created.rows[0]), created: true };
}

export async function touchUserActivity(id: string) {
  await getPool().query(
    `
      update users
      set last_activity_at = now()
      where id = $1
        and (last_activity_at is null or last_activity_at < now() - interval '1 minute')
    `,
    [id],
  );
}
