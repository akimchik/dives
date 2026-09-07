import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

let server;
let tempDir;

async function startServer(fakeTool, extraEnv = {}) {
  const port = 49000 + Math.floor(Math.random() * 1000);
  server = spawn(process.execPath, ["scripts/suunto-sidecar/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUUNTOOL_BIN: fakeTool,
      SUUNTO_SIDECAR_PORT: String(port),
      SUUNTO_SIDECAR_HOST: "127.0.0.1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sidecar did not start")), 5000);
    server.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("suunto-sidecar listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on("exit", (code) => reject(new Error(`sidecar exited ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

async function makeFakeTool() {
  tempDir = await mkdtemp(join(tmpdir(), "fake-suuntool-"));
  const path = join(tempDir, "suuntool.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const sessionFile = process.env.SUUNTOOL_SESSION_FILE;
if (args[0] === "version") {
  console.log("suuntool 0.8.0");
} else if (args[0] === "login") {
  let stdin = "";
  process.stdin.on("data", (chunk) => (stdin += chunk.toString("utf8")));
  process.stdin.on("end", () => {
    if (!args.includes("--password-stdin") || !stdin.includes("secret")) process.exit(2);
    writeFileSync(sessionFile, JSON.stringify({ token: "session-from-login" }));
    console.log(JSON.stringify({ ok: true }));
  });
} else if (args.join(" ") === "workouts list --limit 2 --format json") {
  console.log(JSON.stringify({ payload: { workouts: [{ key: "6tv4q2ak4ksqlrth" }] } }));
} else if (args.join(" ") === "workouts list --since 10d --limit 100 --format json") {
  console.log(JSON.stringify({ items: [{ key: "since-window" }] }));
} else if (args.join(" ") === "workouts list --since two-page --limit 100 --offset 0 --format json") {
  console.log(JSON.stringify({ workouts: Array.from({ length: 100 }, (_, i) => ({ key: "page0-" + i })) }));
} else if (args.join(" ") === "workouts list --since two-page --limit 100 --offset 100 --format json") {
  console.log(JSON.stringify({ workouts: [{ key: "page1-last" }] }));
} else if (args.join(" ") === "workouts list --since first-page-fails --limit 100 --offset 0 --format json") {
  console.error("SERVER_ERROR: upstream 500");
  process.exit(5);
} else if (args.join(" ") === "workouts list --since mid-pagination-drop --limit 100 --offset 0 --format json") {
  console.log(JSON.stringify({ workouts: Array.from({ length: 100 }, (_, i) => ({ key: "page0-" + i })) }));
} else if (args.join(" ") === "workouts list --since mid-pagination-drop --limit 100 --offset 100 --format json") {
  // Reproduces the real production failure: many pages already fetched fine, then one page dies
  // ("BAD_ENVELOPE: unexpected end of JSON input", exit 5) -- a transient hiccup, not auth/usage.
  console.error("BAD_ENVELOPE: unexpected end of JSON input");
  process.exit(5);
} else if (args.join(" ") === "workouts list --since mid-pagination-auth-drop --limit 100 --offset 0 --format json") {
  console.log(JSON.stringify({ workouts: Array.from({ length: 100 }, (_, i) => ({ key: "page0-" + i })) }));
} else if (args.join(" ") === "workouts list --since mid-pagination-auth-drop --limit 100 --offset 100 --format json") {
  // Same non-zero exit shape, but auth failures must never be treated as salvageable partial data.
  console.error("AUTH_EXPIRED: session expired mid-pagination");
  process.exit(4);
} else if (args[0] === "workouts" && args[1] === "export") {
  const dir = args[args.indexOf("--bundle") + 1];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workout.json"), JSON.stringify({ key: args[2] }));
  writeFileSync(join(dir, "workout.sml.json"), JSON.stringify({ Data: { Samples: [] } }));
  console.log(JSON.stringify({ ok: true }));
} else {
  console.error("AUTH_EXPIRED: fake failure");
  process.exit(4);
}
`,
    { mode: 0o755 },
  );
  return path;
}

afterEach(async () => {
  if (server) {
    server.kill("SIGTERM");
    server = undefined;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("suunto sidecar server", () => {
  it("logs in via password-stdin, lists workouts with a supplied session, and exports a bundle", async () => {
    const baseUrl = await startServer(await makeFakeTool());

    const health = await fetch(`${baseUrl}/health`);
    expect(await health.json()).toEqual({ ok: true, version: "suuntool 0.8.0" });

    const login = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@aleksandr.vin", password: "secret" }),
    });
    expect(login.status).toBe(200);
    const loginJson = await login.json();
    expect(loginJson.sessionJson).toContain("session-from-login");

    const list = await fetch(`${baseUrl}/workouts/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionJson: loginJson.sessionJson, limit: 2 }),
    });
    expect(await list.json()).toEqual({ workouts: [{ key: "6tv4q2ak4ksqlrth" }] });

    const sinceList = await fetch(`${baseUrl}/workouts/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionJson: loginJson.sessionJson, limit: 100, since: "10d" }),
    });
    expect(await sinceList.json()).toEqual({ workouts: [{ key: "since-window" }] });

    const exported = await fetch(`${baseUrl}/workouts/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionJson: loginJson.sessionJson, workoutKey: "6tv4q2ak4ksqlrth" }),
    });
    expect(exported.status).toBe(200);
    const exportedJson = await exported.json();
    expect(exportedJson).toMatchObject({
      workoutKey: "6tv4q2ak4ksqlrth",
      workoutJson: { key: "6tv4q2ak4ksqlrth" },
      workoutSmlJson: { Data: { Samples: [] } },
      bundleEncoding: "json-files+gzip+base64",
    });
    const bundle = JSON.parse(gunzipSync(Buffer.from(exportedJson.bundleBase64, "base64")).toString("utf8"));
    expect(bundle.files.map((file) => file.path)).toEqual(["workout.json", "workout.sml.json"]);
  });

  it("paginates the whole history in all mode with --offset, stopping at the short last page", async () => {
    const baseUrl = await startServer(await makeFakeTool());

    const response = await fetch(`${baseUrl}/workouts/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionJson: "{}", all: true, since: "two-page" }),
    });

    expect(response.status).toBe(200);
    const { workouts } = await response.json();
    expect(workouts).toHaveLength(101);
    expect(workouts[0]).toEqual({ key: "page0-0" });
    expect(workouts[workouts.length - 1]).toEqual({ key: "page1-last" });
  });

  it("fails the all-mode listing when the very first page fails", async () => {
    const baseUrl = await startServer(await makeFakeTool());

    const response = await fetch(`${baseUrl}/workouts/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionJson: "{}", all: true, since: "first-page-fails" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ reason: "server" });
  });

  it("salvages already-paginated pages when a later page dies with a transient error", async () => {
    const baseUrl = await startServer(await makeFakeTool());

    const response = await fetch(`${baseUrl}/workouts/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionJson: "{}", all: true, since: "mid-pagination-drop" }),
    });

    expect(response.status).toBe(200);
    const { workouts } = await response.json();
    expect(workouts).toHaveLength(100);
    expect(workouts[0]).toEqual({ key: "page0-0" });
  });

  it("does not salvage partial output when a later page dies on an auth failure", async () => {
    const baseUrl = await startServer(await makeFakeTool());

    const response = await fetch(`${baseUrl}/workouts/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionJson: "{}", all: true, since: "mid-pagination-auth-drop" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "auth_expired" });
  });

  it("returns whatever was paginated so far once the loop's own wall-time budget elapses", async () => {
    // A deadline already in the past forces the very first budget check (before any page is
    // fetched) to trip deterministically, rather than racing a short-but-positive timeout.
    const baseUrl = await startServer(await makeFakeTool(), { SUUNTOOL_LIST_ALL_TIMEOUT_MS: "-1000" });

    const response = await fetch(`${baseUrl}/workouts/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionJson: "{}", all: true, since: "two-page" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ workouts: [] });
  });

  it("fails closed instead of accumulating unbounded pages past its result-count cap", async () => {
    const baseUrl = await startServer(await makeFakeTool(), { SUUNTO_SIDECAR_MAX_LIST_ALL_WORKOUTS: "1" });

    const response = await fetch(`${baseUrl}/workouts/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionJson: "{}", all: true, since: "two-page" }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      reason: "bad_request",
      error: "workout listing has too many results",
    });
  });

  it("rejects oversized request bodies before spawning suuntool", async () => {
    const baseUrl = await startServer(await makeFakeTool());

    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@aleksandr.vin", password: "x".repeat(1_000_001) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      reason: "bad_request",
      error: "request body is too large",
    });
  });
});
