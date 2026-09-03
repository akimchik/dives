type HealthcheckPingState = {
  intervalId?: ReturnType<typeof setInterval>;
  intervalMs?: number;
  lastError?: string;
  lastPingAt?: string;
  lastStatus?: number;
  url?: string;
};

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = 10_000;

const globalForHealthcheck = globalThis as typeof globalThis & {
  __divesHealthcheckPing?: HealthcheckPingState;
};

function getState() {
  globalForHealthcheck.__divesHealthcheckPing ??= {};
  return globalForHealthcheck.__divesHealthcheckPing;
}

function getConfig() {
  const url = process.env.HEALTHCHECK_PING_URL?.trim();
  if (!url) return null;

  const configuredIntervalSeconds =
    process.env.HEALTHCHECK_PING_INTERVAL_SECONDS?.trim();
  const parsedIntervalSeconds = configuredIntervalSeconds
    ? Number(configuredIntervalSeconds)
    : NaN;
  const intervalMs = Number.isFinite(parsedIntervalSeconds)
    ? parsedIntervalSeconds * 1000
    : DEFAULT_INTERVAL_MS;

  return {
    intervalMs: Math.max(MIN_INTERVAL_MS, intervalMs),
    url,
  };
}

async function pingHealthcheck() {
  const config = getConfig();
  if (!config) return;

  const state = getState();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      cache: "no-store",
      signal: controller.signal,
    });

    state.lastPingAt = new Date().toISOString();
    state.lastStatus = response.status;
    state.lastError = response.ok ? undefined : `HTTP ${response.status}`;
  } catch (error) {
    state.lastPingAt = new Date().toISOString();
    state.lastStatus = undefined;
    state.lastError =
      error instanceof Error ? error.message : "Healthcheck ping failed";
  } finally {
    clearTimeout(timeout);
  }
}

function unrefInterval(intervalId: ReturnType<typeof setInterval>) {
  if (
    typeof intervalId === "object" &&
    intervalId !== null &&
    "unref" in intervalId &&
    typeof intervalId.unref === "function"
  ) {
    intervalId.unref();
  }
}

export function ensureHealthcheckPingerStarted() {
  const config = getConfig();
  const state = getState();

  if (!config) {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = undefined;
    }

    state.url = undefined;
    state.intervalMs = undefined;
    return;
  }

  if (
    state.intervalId &&
    state.url === config.url &&
    state.intervalMs === config.intervalMs
  ) {
    return;
  }

  if (state.intervalId) {
    clearInterval(state.intervalId);
  }

  state.url = config.url;
  state.intervalMs = config.intervalMs;

  void pingHealthcheck();
  state.intervalId = setInterval(() => {
    void pingHealthcheck();
  }, config.intervalMs);
  unrefInterval(state.intervalId);
}

export function getHealthcheckPingStatus() {
  const state = getState();

  return {
    enabled: Boolean(state.url),
    intervalSeconds: state.intervalMs ? Math.round(state.intervalMs / 1000) : null,
    lastError: state.lastError ?? null,
    lastPingAt: state.lastPingAt ?? null,
    lastStatus: state.lastStatus ?? null,
  };
}
