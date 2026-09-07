import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  exportSuuntoWorkout,
  listSuuntoWorkouts,
  redactSuuntoSecret,
  SuuntoSidecarError,
  suuntoLogin,
} from "@/lib/suunto/sidecar-client";

let server: Server | null = null;
const originalUrl = process.env.SUUNTO_SIDECAR_URL;

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function listen(handler: Handler): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") throw new Error("missing test address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

afterEach(async () => {
  process.env.SUUNTO_SIDECAR_URL = originalUrl;
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
    server = null;
  });
});

describe("suunto sidecar client", () => {
  it("posts credentials to login and returns only the session material", async () => {
    process.env.SUUNTO_SIDECAR_URL = await listen(async (req, res) => {
      expect(req.url).toBe("/login");
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      await new Promise((resolve) => req.on("end", resolve));
      expect(JSON.parse(body)).toEqual({ email: "me@aleksandr.vin", password: "secret" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessionJson: "{\"session\":true}" }));
    });

    await expect(suuntoLogin("me@aleksandr.vin", "secret")).resolves.toEqual({
      sessionJson: "{\"session\":true}",
    });
  });

  it("maps sidecar auth failures without leaking secrets", async () => {
    process.env.SUUNTO_SIDECAR_URL = await listen((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ reason: "auth_expired", error: 'bad {"sessionJson":"abc"}' }));
    });

    await expect(listSuuntoWorkouts("super-secret-session", { daysBack: 3 })).rejects.toMatchObject({
      reason: "auth_expired",
      status: 401,
    });
    await expect(listSuuntoWorkouts("super-secret-session", { daysBack: 3 })).rejects.not.toThrow("abc");
  });

  it("asks the sidecar for the whole history in all mode, without a bounded limit or since window", async () => {
    let received: unknown = null;
    process.env.SUUNTO_SIDECAR_URL = await listen(async (req, res) => {
      expect(req.url).toBe("/workouts/list");
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      await new Promise((resolve) => req.on("end", resolve));
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ workouts: [{ key: "one" }, { key: "two" }] }));
    });

    await expect(listSuuntoWorkouts("super-secret-session", { all: true })).resolves.toEqual({
      workouts: [{ key: "one" }, { key: "two" }],
    });
    expect(received).toEqual({ sessionJson: "super-secret-session", all: true });
  });

  it("sends the bounded recent-days window as a since/limit pair in days mode", async () => {
    let received: unknown = null;
    process.env.SUUNTO_SIDECAR_URL = await listen(async (req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      await new Promise((resolve) => req.on("end", resolve));
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ workouts: [] }));
    });

    await listSuuntoWorkouts("super-secret-session", { daysBack: 3 });
    expect(received).toEqual({ sessionJson: "super-secret-session", limit: 100, since: "3d" });
  });

  it("rejects non-local sidecar URLs", async () => {
    process.env.SUUNTO_SIDECAR_URL = "https://suunto.example.invalid";
    await expect(exportSuuntoWorkout("session", "workout")).rejects.toBeInstanceOf(SuuntoSidecarError);
    await expect(exportSuuntoWorkout("session", "workout")).rejects.toMatchObject({ reason: "bad_request" });
  });

  it("redacts passwords and session material in arbitrary messages", () => {
    expect(redactSuuntoSecret('{"password":"pw","sessionJson":"sess"}')).not.toContain("pw");
    expect(redactSuuntoSecret('{"password":"pw","sessionJson":"sess"}')).not.toContain('"sess"');
  });
});
