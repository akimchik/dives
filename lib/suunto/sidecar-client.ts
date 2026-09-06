import "server-only";

export type SuuntoSidecarErrorReason =
  | "bad_request"
  | "auth_expired"
  | "network"
  | "rate_limited"
  | "server"
  | "timeout"
  | "tool_error"
  | "not_found";

export class SuuntoSidecarError extends Error {
  constructor(
    message: string,
    public readonly reason: SuuntoSidecarErrorReason,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SuuntoSidecarError";
  }
}

export type SuuntoWorkoutSummary = {
  key: string;
  startTime?: string | number | null;
  activityId?: string | number | null;
  [key: string]: unknown;
};

export type SuuntoExportResponse = {
  workoutKey: string;
  workoutJson: unknown;
  workoutSmlJson: unknown;
  bundleBase64: string;
  bundleEncoding: "json-files+gzip+base64";
};

export type SuuntoLoginResponse = {
  sessionJson: string;
};

export function redactSuuntoSecret(value: string): string {
  return value
    .replace(/("password"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/("sessionJson"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/("session"\s*:\s*)(\{[^}]*\}|"[^"]+")/gi, "$1[redacted]");
}

function sidecarBaseUrl(): URL {
  const raw = process.env.SUUNTO_SIDECAR_URL ?? "http://127.0.0.1:4817";
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new SuuntoSidecarError("SUUNTO_SIDECAR_URL must be an http localhost URL.", "bad_request");
  }
  return url;
}

function reasonFromStatus(status: number): SuuntoSidecarErrorReason {
  if (status === 401) return "auth_expired";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "tool_error";
}

async function callSidecar<T>(path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const url = new URL(path, sidecarBaseUrl());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const reason =
        typeof record.reason === "string" ? (record.reason as SuuntoSidecarErrorReason) : reasonFromStatus(response.status);
      const message = typeof record.error === "string" ? record.error : `Suunto sidecar request failed (${response.status}).`;
      throw new SuuntoSidecarError(redactSuuntoSecret(message), reason, response.status);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof SuuntoSidecarError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new SuuntoSidecarError("Suunto sidecar request timed out.", "timeout", 408);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SuuntoSidecarError(redactSuuntoSecret(message), "network");
  } finally {
    clearTimeout(timer);
  }
}

export async function suuntoLogin(email: string, password: string): Promise<SuuntoLoginResponse> {
  return callSidecar("/login", { email, password });
}

export async function listSuuntoWorkouts(
  sessionJson: string,
  limit: number,
): Promise<{ workouts: SuuntoWorkoutSummary[] }> {
  return callSidecar("/workouts/list", { sessionJson, limit });
}

export async function exportSuuntoWorkout(
  sessionJson: string,
  workoutKey: string,
): Promise<SuuntoExportResponse> {
  return callSidecar("/workouts/export", { sessionJson, workoutKey }, 180_000);
}
