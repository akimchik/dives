"use server";

import * as client from "openid-client";
import { redirect } from "next/navigation";

import { isPasswordAuthEnabled } from "@/lib/auth-config";
import { getOidcConfig, requireEnv } from "@/lib/auth/oidc";
import { getRequestOrigin } from "@/lib/base-url";
import { createMagicLinkToken, consumeMagicLinkToken } from "@/lib/magic-link";
import { sendMagicLinkEmail } from "@/lib/mailer";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { createSession, deleteSession } from "@/lib/session";
import { createUser, findActiveUserByEmail, type AppUser } from "@/lib/users";
import { verifyPassword } from "@/lib/passwords";
import { recordSignup, recordSignin, recordLogout } from "@/lib/auth-otel";
import { withActionTelemetry } from "@/lib/action-otel";

const passwordAuthDisabledMessage = "Password sign-in is currently disabled. Use Authentik to sign in.";

export type AuthActionState = {
  error?: string;
};

export type StartAuthResult = { mode: "password" } | { mode: "magic_sent" };

function readCredentials(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "").trim();
  return { email, password, next };
}

function isUniqueConstraintError(error: unknown) {
  if (!error || typeof error !== "object") return false;

  const maybeError = error as { code?: unknown };
  const code = typeof maybeError.code === "string" ? maybeError.code : "";

  return code === "23505";
}

function buildMagicLinkUrl(origin: string, token: string, nextPath?: string) {
  const url = new URL(`/register/${encodeURIComponent(token)}`, origin);
  const safeNext = safeRedirectPath(nextPath);

  if (safeNext !== "/dashboard") {
    url.searchParams.set("next", safeNext);
  }

  return url.toString();
}

export async function startAuthAction(
  email: string,
  nextPath?: string,
): Promise<StartAuthResult> {
  // Deliberately () => null, not a thunk over the submitted `email` -- unlike loginAction, which
  // only assigns its resolvedUser after verifyPassword succeeds, this action never authenticates
  // anyone. Labeling the metric with the raw argument would let an unauthenticated caller mint an
  // arbitrary metrics-backend series per POST, since `user` is a deliberately high-cardinality label.
  return withActionTelemetry("startAuth", () => null, async () => {
    if (!isPasswordAuthEnabled()) {
      throw new Error(passwordAuthDisabledMessage);
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) {
      throw new Error("Email is required.");
    }

    const existing = await findActiveUserByEmail(normalizedEmail);

    if (existing) {
      return { mode: "password" };
    }

    const { token } = await createMagicLinkToken(normalizedEmail);
    const origin = await getRequestOrigin();
    await sendMagicLinkEmail({
      email: normalizedEmail,
      magicLinkUrl: buildMagicLinkUrl(origin, token, nextPath),
    });

    return { mode: "magic_sent" };
  });
}

export async function loginAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  // Not known until credentials are verified below -- withActionTelemetry reads this closure
  // lazily in its `finally`, after `fn` (including its final `redirect()`) has already run.
  let resolvedUser: AppUser | null = null;

  return withActionTelemetry("login", () => resolvedUser, async () => {
    if (!isPasswordAuthEnabled()) {
      return { error: passwordAuthDisabledMessage };
    }

    const { email, password, next } = readCredentials(formData);

    if (!email || !password) {
      return { error: "Email and password are required." };
    }

    const user = await findActiveUserByEmail(email);

    // OIDC-only users (created/linked via Authentik) have no password_hash --
    // password login is simply not available for them, not a crash.
    if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
      return { error: "Invalid email or password." };
    }

    resolvedUser = user;
    await createSession(user.id);
    recordSignin("password");
    redirect(safeRedirectPath(next));
  });
}

export async function completeRegistrationAction(
  token: string,
  password: string,
  nextPath?: string,
): Promise<AuthActionState> {
  let resolvedUser: AppUser | null = null;

  return withActionTelemetry("completeRegistration", () => resolvedUser, async () => {
    if (!isPasswordAuthEnabled()) {
      return { error: passwordAuthDisabledMessage };
    }

    const consumed = await consumeMagicLinkToken(token);

    if (!consumed) {
      return {
        error: "This registration link is expired or already used. Request a new link to continue.",
      };
    }

    if (password.length < 8) {
      return { error: "Password must be at least 8 characters." };
    }

    const existing = await findActiveUserByEmail(consumed.email);

    if (existing) {
      return { error: "An account already exists for this email. Please log in." };
    }

    let user;

    try {
      user = await createUser({ email: consumed.email, password });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { error: "An account already exists for this email. Please log in." };
      }

      throw error;
    }

    resolvedUser = user;
    recordSignup("password");
    await createSession(user.id);
    recordSignin("password");
    redirect(safeRedirectPath(nextPath));
  });
}

// Deleting the app's own session cookie alone leaves the user silently
// signed in at Authentik -- hitting "Sign in" again would just bounce them
// straight back in with no prompt, since the *Authentik* session is still
// live. RP-initiated logout (redirecting to Authentik's end_session_endpoint
// with the id_token_hint from login) actually ends that session too. Never
// throws -- any failure here just falls through to the local-only redirect
// below, so a broken/unreachable OIDC config can't break logout entirely.
async function buildAuthentikLogoutUrl(idToken: string): Promise<string | null> {
  try {
    const config = await getOidcConfig();
    return client
      .buildEndSessionUrl(config, {
        id_token_hint: idToken,
        post_logout_redirect_uri: requireEnv("NEXT_PUBLIC_BASE_URL"),
      })
      .toString();
  } catch (err) {
    console.error("buildAuthentikLogoutUrl failed", err);
    return null;
  }
}

export async function logoutAction() {
  // Assigned inside fn() from deleteSession()'s own return value, not a separate getOptionalUser()
  // pre-read: that raced with deleteSession() below, since Next's cookies().delete() rewrites the
  // cookie's value to "" in the mutable jar rather than removing it -- deleteSession() would then
  // read back an empty token and silently skip both the row deletion and the Authentik logout.
  let resolvedUser: AppUser | null = null;

  return withActionTelemetry("logout", () => resolvedUser, async () => {
    const { idToken, user } = await deleteSession();
    resolvedUser = user;
    recordLogout(idToken ? "oidc" : "password");

    if (idToken) {
      const authentikLogoutUrl = await buildAuthentikLogoutUrl(idToken);
      if (authentikLogoutUrl) {
        redirect(authentikLogoutUrl);
      }
    }

    redirect("/");
  });
}
