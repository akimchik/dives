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
const MAX_REQUEST_BYTES = Number(process.env.SUUNTO_SIDECAR_MAX_REQUEST_BYTES || 1_000_000);
const MAX_BUNDLE_BYTES = Number(process.env.SUUNTO_SIDECAR_MAX_BUNDLE_BYTES || 25_000_000);
const MAX_BUNDLE_FILES = Number(process.env.SUUNTO_SIDECAR_MAX_BUNDLE_FILES || 20);

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
    const result = await runSuuntool(
      ["login", "--email", payload.email, "--password-stdin", "--format", "json"],
      { sessionPath, stdin: payload.password },
    );
    assertOk(result);
    return { sessionJson: await readFile(sessionPath, "utf8") };
  });
}

async function listWorkouts(payload) {
  const limit = Math.max(1, Math.min(100, Number(payload.limit || 10)));
  return withTempSession(payload.sessionJson, async ({ sessionPath }) => {
    const result = await runSuuntool(["workouts", "list", "--limit", String(limit), "--format", "json"], {
      sessionPath,
    });
    assertOk(result);
    const parsed = parseJson(result.stdout, []);
    return { workouts: Array.isArray(parsed) ? parsed : parsed.workouts || [] };
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
    const result = await runSuuntool(
      ["workouts", "export", String(payload.workoutKey), "--bundle", bundleDir, "--format", "json"],
      { sessionPath, timeoutMs: EXPORT_TIMEOUT_MS },
    );
    assertOk(result);
    const files = await collectFiles(bundleDir);
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

  try {
    const payload = req.method === "GET" ? {} : await body(req);
    const result = await handler(payload);
    json(res, 200, result);
  } catch (error) {
    json(res, error.status || 500, {
      error: redact(error instanceof Error ? error.message : String(error)),
      reason: error.reason || "server",
    });
  }
}).listen(PORT, HOST, () => {
  console.log(`suunto-sidecar listening on http://${HOST}:${PORT}`);
});
