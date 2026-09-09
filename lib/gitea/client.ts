import "server-only";

// Minimal Gitea REST client, used only by the in-app feedback form (issue #22). Same shape as
// lib/healthcheck-ping.ts's fetch usage (plain fetch + AbortController timeout); deliberately a
// plain .ts file rather than the .ts/.mjs twin pattern lib/padi/client.ts uses, because nothing
// here has to run inside the standalone notification worker.

const DEFAULT_BASE_URL = "https://gitea.pumpking.aleksandr.vin";
const DEFAULT_OWNER = "software-engineer-vinokurov";
const DEFAULT_REPO = "dives";

// Kept in sync with the appSecrets placeholder in helm-charts/values.yaml, same as
// scripts/padi/crypto.mjs's PLACEHOLDER_KEY_VALUE: a chart that was deployed without a real
// override must read as "not configured", not as a token that happens to be wrong.
const PLACEHOLDER_TOKEN_VALUE = "replace-with-gitea-feedback-token";

const FEEDBACK_LABEL_NAME = "user-feedback";
const FEEDBACK_LABEL_COLOR = "#00aabb";
const FEEDBACK_LABEL_DESCRIPTION = "Feedback submitted by a user from the app";

const REQUEST_TIMEOUT_MS = 10_000;
const LABEL_PAGE_LIMIT = 100;

// Not exported: every failure path out of this module is funnelled through createFeedbackIssue,
// whose only caller treats any throw the same way, so nothing outside needs to catch by type.
class GiteaApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "GiteaApiError";
    this.status = status;
  }
}

type GiteaConfig = {
  baseUrl: string;
  owner: string;
  repo: string;
  token: string;
};

function envValue(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

// Throws rather than returning null so every caller path ends up as a GiteaApiError the action
// layer already handles. The token itself is never part of any message thrown from this module.
function getConfig(): GiteaConfig {
  const token = process.env.GITEA_TOKEN?.trim();

  if (!token) {
    throw new GiteaApiError("Gitea is not configured: GITEA_TOKEN is unset");
  }
  if (token === PLACEHOLDER_TOKEN_VALUE) {
    throw new GiteaApiError("Gitea is not configured: GITEA_TOKEN is still its placeholder value");
  }

  return {
    baseUrl: envValue("GITEA_BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, ""),
    owner: envValue("GITEA_OWNER", DEFAULT_OWNER),
    repo: envValue("GITEA_REPO", DEFAULT_REPO),
    token,
  };
}

async function giteaRequest<T>(
  config: GiteaConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const url = `${config.baseUrl}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Accept: "application/json",
        Authorization: `token ${config.token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    // The caught error can carry the request (and therefore the Authorization header) on some
    // runtimes, so it is deliberately not interpolated into the message.
    throw new GiteaApiError(`Gitea request failed: network error (${init.method} ${path})`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new GiteaApiError(
      `Gitea request failed with status ${response.status} (${init.method} ${path})`,
      response.status,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new GiteaApiError(
      `Gitea request failed: invalid response body (status ${response.status})`,
      response.status,
    );
  }
}

type GiteaLabel = { id: number; name: string };

function findLabelId(labels: unknown, name: string) {
  if (!Array.isArray(labels)) return null;

  const match = (labels as GiteaLabel[]).find(
    (label) => label && typeof label.id === "number" && label.name === name,
  );

  return match ? match.id : null;
}

async function listLabelId(config: GiteaConfig, name: string) {
  const labels = await giteaRequest<unknown>(config, `/labels?limit=${LABEL_PAGE_LIMIT}`, {
    method: "GET",
  });

  return findLabelId(labels, name);
}

// Gitea's issue-create endpoint takes numeric label ids, not names, so the label has to be
// resolved (and created on first use) before an issue can carry it.
async function getOrCreateLabelId(config: GiteaConfig, labelName: string): Promise<number> {
  const existingId = await listLabelId(config, labelName);
  if (existingId !== null) return existingId;

  let created: unknown;
  try {
    created = await giteaRequest<unknown>(config, "/labels", {
      method: "POST",
      body: {
        name: labelName,
        color: FEEDBACK_LABEL_COLOR,
        description: FEEDBACK_LABEL_DESCRIPTION,
      },
    });
  } catch (error) {
    // Two feedback submissions racing on a repo that has no label yet: whichever POST loses gets
    // a conflict/validation error, and the label it wanted now exists -- so re-read the list once
    // instead of failing a submission for a problem that has already resolved itself.
    const status = error instanceof GiteaApiError ? error.status : undefined;
    if (status !== 409 && status !== 422) throw error;

    const racedId = await listLabelId(config, labelName);
    if (racedId === null) {
      // Chained, not swallowed: the original rejection carries Gitea's own reason for refusing
      // the create, which is the only thing that explains why the label is still missing.
      throw new GiteaApiError(
        `Gitea label "${labelName}" could not be created or found after a create conflict`,
        status,
        { cause: error },
      );
    }
    return racedId;
  }

  const createdId =
    created && typeof created === "object" && typeof (created as GiteaLabel).id === "number"
      ? (created as GiteaLabel).id
      : null;

  if (createdId === null) {
    throw new GiteaApiError(`Gitea label "${labelName}" was created without a usable id`);
  }

  return createdId;
}

export async function createFeedbackIssue(input: {
  title: string;
  body: string;
}): Promise<{ url: string; number: number }> {
  const config = getConfig();
  const labelId = await getOrCreateLabelId(config, FEEDBACK_LABEL_NAME);

  const data = await giteaRequest<unknown>(config, "/issues", {
    method: "POST",
    body: { title: input.title, body: input.body, labels: [labelId] },
  });

  const issue = data as { html_url?: unknown; number?: unknown } | null;
  if (!issue || typeof issue.number !== "number") {
    throw new GiteaApiError("Gitea issue was created without a usable issue number");
  }

  return {
    number: issue.number,
    url:
      typeof issue.html_url === "string"
        ? issue.html_url
        : `${config.baseUrl}/${config.owner}/${config.repo}/issues/${issue.number}`,
  };
}
