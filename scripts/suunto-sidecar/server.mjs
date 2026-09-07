#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";

const HOST = process.env.SUUNTO_SIDECAR_HOST || "127.0.0.1";
const PORT = Number(process.env.SUUNTO_SIDECAR_PORT || 4817);
const SUUNTOOL = process.env.SUUNTOOL_BIN || "suuntool";
const DEFAULT_TIMEOUT_MS = Number(process.env.SUUNTOOL_TIMEOUT_MS || 60_000);
const EXPORT_TIMEOUT_MS = Number(process.env.SUUNTOOL_EXPORT_TIMEOUT_MS || 180_000);
// "All time" fetches the user's entire history by paginating the SAME bounded, single-page call the
// "recent days" mode already uses (proven reliable), just looping with an increasing --offset,
// rather than suuntool's own `--stream --limit 0` auto-pagination. That auto-pagination turned out
// to be fundamentally unreliable for a large real history: a production fetch with ~9,600 activities
// died with "BAD_ENVELOPE: unexpected end of JSON input" first at suuntool's own 30s default HTTP
// timeout, then again at an explicit 170s --timeout -- proving --timeout only delayed the same
// failure rather than fixing it, since one continuous multi-minute streaming HTTP operation was
// never going to reliably finish for a large-enough history no matter how long it was allowed to
// run. LIST_ALL_TIMEOUT_MS now bounds the total wall time of the whole *pagination loop* (checked
// between pages, not inside any single runSuuntool call).
const LIST_ALL_TIMEOUT_MS = Number(process.env.SUUNTOOL_LIST_ALL_TIMEOUT_MS || 180_000);
// Matches the server's own per-page ceiling (see the bounded branch of listWorkouts below).
const LIST_ALL_PAGE_SIZE = 100;
const MAX_REQUEST_BYTES = Number(process.env.SUUNTO_SIDECAR_MAX_REQUEST_BYTES || 1_000_000);
const MAX_BUNDLE_BYTES = Number(process.env.SUUNTO_SIDECAR_MAX_BUNDLE_BYTES || 25_000_000);
const MAX_BUNDLE_FILES = Number(process.env.SUUNTO_SIDECAR_MAX_BUNDLE_FILES || 20);
// Ceiling on the one path whose in-memory accumulation isn't bounded by a single small page: "all
// time" pagination keeps appending pages (of real activities, not just dives) until the loop's own
// wall-time deadline. A hard count cap is a backstop against an extreme history ballooning memory.
const MAX_LIST_ALL_WORKOUTS = Number(process.env.SUUNTO_SIDECAR_MAX_LIST_ALL_WORKOUTS || 20_000);

const EXIT_REASONS = new Map([
  [1, [502, "tool_error"]],
  [2, [400, "bad_request"]],
  [3, [503, "network"]],
  [4, [401, "auth_expired"]],
  [5, [500, "server"]],
  [6, [408, "timeout"]],
  [7, [429, "rate_limited"]],
]);

function redact(value) {
  return String(value)
    .replace(/("password"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/("sessionJson"\s*:\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/("session"\s*:\s*)(\{[^}]*\}|"[^"]+")/gi, "$1[redacted]");
}


function logEvent(event, fields = {}) {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  console.log(redact(JSON.stringify(payload)));
}

function parsedShape(value) {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (!value || typeof value !== "object") return { type: typeof value };
  const record = value;
  return {
    type: "object",
    keys: Object.keys(record).slice(0, 20),
    payloadKeys: record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? Object.keys(record.payload).slice(0, 20)
      : undefined,
  };
}

function extractWorkouts(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const candidates = [
    parsed.workouts,
    parsed.items,
    parsed.data,
    parsed.results,
    parsed.records,
    parsed.payload,
    parsed.payload?.workouts,
    parsed.payload?.items,
    parsed.payload?.data,
    parsed.payload?.results,
    parsed.payload?.records,
  ];
  return candidates.find(Array.isArray) || [];
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("request body is too large");
      error.status = 413;
      error.reason = "bad_request";
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function withTempSession(sessionJson, run) {
  const dir = await mkdtemp(join(tmpdir(), "suunto-sidecar-"));
  const sessionPath = join(dir, "session.json");
  try {
    if (sessionJson) await writeFile(sessionPath, sessionJson, { mode: 0o600 });
    return await run({ dir, sessionPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runSuuntool(args, { sessionPath, stdin, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(SUUNTOOL, args, {
      env: { ...process.env, SUUNTOOL_SESSION_FILE: sessionPath || process.env.SUUNTOOL_SESSION_FILE || "" },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? 6 : (code ?? 1), stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message });
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin.endsWith("\n") ? stdin : `${stdin}\n`);
    }
  });
}

function parseJson(text, fallback = null) {
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed);
}

function assertOk(result) {
  if (result.code === 0) return;
  const [status, reason] = EXIT_REASONS.get(result.code) ?? [502, "tool_error"];
  const error = redact(result.stderr || result.stdout || `suuntool exited with ${result.code}`);
  const thrown = new Error(error);
  thrown.status = status;
  thrown.reason = reason;
  throw thrown;
}

async function collectFiles(root) {
  const entries = [];
  let totalBytes = 0;
  async function walk(dir) {
    for (const name of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) {
        await walk(path);
      } else if (name.isFile()) {
        if (entries.length >= MAX_BUNDLE_FILES) {
          const error = new Error("exported bundle contains too many files");
          error.status = 413;
          error.reason = "bad_request";
          throw error;
        }
        const content = await readFile(path);
        totalBytes += content.length;
        if (totalBytes > MAX_BUNDLE_BYTES) {
          const error = new Error("exported bundle is too large");
          error.status = 413;
          error.reason = "bad_request";
          throw error;
        }
        entries.push({ path: relative(root, path), contentBase64: content.toString("base64") });
      }
    }
  }
  await walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function login(payload) {
  if (typeof payload.email !== "string" || typeof payload.password !== "string") {
    const error = new Error("email and password are required");
    error.status = 400;
    error.reason = "bad_request";
    throw error;
  }
  return withTempSession(null, async ({ sessionPath }) => {
    logEvent("suunto.login.start", { emailProvided: Boolean(payload.email) });
    const result = await runSuuntool(
      ["login", "--email", payload.email, "--password-stdin", "--format", "json"],
      { sessionPath, stdin: payload.password },
    );
    logEvent("suunto.login.suuntool", {
      exitCode: result.code,
      stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      stderrPreview: result.stderr ? redact(result.stderr).slice(0, 500) : undefined,
    });
    assertOk(result);
    const sessionJson = await readFile(sessionPath, "utf8");
    logEvent("suunto.login.result", { sessionBytes: Buffer.byteLength(sessionJson, "utf8") });
    return { sessionJson };
  });
}

async function listWorkouts(payload) {
  const since = typeof payload.since === "string" && payload.since.trim() ? payload.since.trim() : null;

  if (payload.all === true) {
    return withTempSession(payload.sessionJson, async ({ sessionPath }) => {
      const workouts = [];
      let offset = 0;
      const deadline = Date.now() + LIST_ALL_TIMEOUT_MS;
      logEvent("suunto.workouts.list_all.start", { since, hasSession: Boolean(payload.sessionJson) });

      while (true) {
        if (Date.now() > deadline) {
          // The whole history wasn't reached within the budget -- return what's been paginated so
          // far rather than erroring. The caller's own wall-time-budgeted staging loop already
          // expects a listing to sometimes come back short and reports "click Fetch again"; the next
          // click restarts pagination from offset 0, which is safe (not just fast) because every
          // already-staged/saved workout is skipped by the caller's own dedupe check.
          logEvent("suunto.workouts.list_all.result", { since, workoutCount: workouts.length, truncatedByDeadline: true });
          return { workouts };
        }
        if (workouts.length > MAX_LIST_ALL_WORKOUTS) {
          const error = new Error("workout listing has too many results");
          error.status = 413;
          error.reason = "bad_request";
          throw error;
        }

        const args = ["workouts", "list", "--limit", String(LIST_ALL_PAGE_SIZE), "--offset", String(offset), "--format", "json"];
        if (since) args.splice(2, 0, "--since", since);
        const result = await runSuuntool(args, { sessionPath });
        logEvent("suunto.workouts.list_all.page", {
          since,
          offset,
          exitCode: result.code,
          stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
          stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
          stderrPreview: result.stderr ? redact(result.stderr).slice(0, 500) : undefined,
        });

        if (result.code !== 0) {
          const [, reason] = EXIT_REASONS.get(result.code) ?? [502, "tool_error"];
          // A hiccup partway through paginating shouldn't discard pages already collected -- the
          // caller already dedupes safely against whatever this returns. The very first page (offset
          // 0, nothing collected yet) and any auth/usage failure still hard-fail via assertOk below.
          const canSalvage = workouts.length > 0 && (reason === "server" || reason === "timeout" || reason === "network");
          if (canSalvage) {
            logEvent("suunto.workouts.list_all.result", { since, workoutCount: workouts.length, salvagedAtOffset: offset });
            return { workouts };
          }
          assertOk(result);
        }

        const parsed = parseJson(result.stdout, []);
        const page = extractWorkouts(parsed);
        workouts.push(...page);
        if (page.length < LIST_ALL_PAGE_SIZE) {
          logEvent("suunto.workouts.list_all.result", { since, workoutCount: workouts.length });
          return { workouts };
        }
        offset += LIST_ALL_PAGE_SIZE;
      }
    });
  }

  const requestedLimit = Number(payload.limit || 10);
  const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 10));
  return withTempSession(payload.sessionJson, async ({ sessionPath }) => {
    const args = ["workouts", "list", "--limit", String(limit), "--format", "json"];
    if (since) args.splice(2, 0, "--since", since);
    logEvent("suunto.workouts.list.start", { limit, since, hasSession: Boolean(payload.sessionJson) });
    const result = await runSuuntool(args, { sessionPath });
    logEvent("suunto.workouts.list.suuntool", {
      limit,
      since,
      exitCode: result.code,
      stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      stderrPreview: result.stderr ? redact(result.stderr).slice(0, 500) : undefined,
    });
    assertOk(result);
    const parsed = parseJson(result.stdout, []);
    const workouts = extractWorkouts(parsed);
    logEvent("suunto.workouts.list.result", { limit, since, workoutCount: workouts.length, shape: parsedShape(parsed) });
    return { workouts };
  });
}

async function getWorkout(payload) {
  return withTempSession(payload.sessionJson, async ({ sessionPath }) => {
    const result = await runSuuntool(["workouts", "get", String(payload.workoutKey), "--format", "json"], {
      sessionPath,
    });
    assertOk(result);
    return { workout: parseJson(result.stdout, {}) };
  });
}

async function exportWorkout(payload) {
  return withTempSession(payload.sessionJson, async ({ dir, sessionPath }) => {
    const bundleDir = join(dir, "bundle");
    const workoutKey = String(payload.workoutKey);
    logEvent("suunto.workouts.export.start", { workoutKey, hasSession: Boolean(payload.sessionJson) });
    const result = await runSuuntool(
      ["workouts", "export", workoutKey, "--bundle", bundleDir, "--format", "json"],
      { sessionPath, timeoutMs: EXPORT_TIMEOUT_MS },
    );
    logEvent("suunto.workouts.export.suuntool", {
      workoutKey,
      exitCode: result.code,
      stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      stderrPreview: result.stderr ? redact(result.stderr).slice(0, 500) : undefined,
    });
    assertOk(result);
    const files = await collectFiles(bundleDir);
    logEvent("suunto.workouts.export.result", { workoutKey, fileCount: files.length, files: files.map((file) => file.path) });
    const fileByPath = new Map(files.map((file) => [file.path, file]));
    const workoutJson = parseJson(Buffer.from(fileByPath.get("workout.json")?.contentBase64 || "e30=", "base64").toString("utf8"), {});
    const workoutSmlJson = parseJson(Buffer.from(fileByPath.get("workout.sml.json")?.contentBase64 || "e30=", "base64").toString("utf8"), {});
    return {
      workoutKey: String(payload.workoutKey),
      workoutJson,
      workoutSmlJson,
      bundleEncoding: "json-files+gzip+base64",
      bundleBase64: gzipSync(JSON.stringify({ files })).toString("base64"),
    };
  });
}

const routes = {
  "GET /health": async () => {
    const result = await runSuuntool(["version"]);
    assertOk(result);
    return { ok: true, version: result.stdout.trim() };
  },
  "POST /doctor": async () => {
    const result = await runSuuntool(["doctor", "--format", "json"]);
    assertOk(result);
    return { ok: true, doctor: parseJson(result.stdout, {}) };
  },
  "POST /login": login,
  "POST /workouts/list": listWorkouts,
  "POST /workouts/get": getWorkout,
  "POST /workouts/export": exportWorkout,
};

createServer(async (req, res) => {
  const key = `${req.method} ${new URL(req.url || "/", "http://localhost").pathname}`;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: "not found", reason: "not_found" });

  const started = Date.now();
  try {
    const payload = req.method === "GET" ? {} : await body(req);
    logEvent("suunto.request.start", { route: key });
    const result = await handler(payload);
    logEvent("suunto.request.ok", { route: key, durationMs: Date.now() - started });
    json(res, 200, result);
  } catch (error) {
    const status = error.status || 500;
    const reason = error.reason || "server";
    logEvent("suunto.request.error", {
      route: key,
      status,
      reason,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    json(res, status, {
      error: redact(error instanceof Error ? error.message : String(error)),
      reason,
    });
  }
}).listen(PORT, HOST, () => {
  console.log(`suunto-sidecar listening on http://${HOST}:${PORT}`);
});
