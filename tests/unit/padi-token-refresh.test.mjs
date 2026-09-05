import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encryptSecret, decryptSecret } from "../../scripts/padi/crypto.mjs";
import { processPadiTokenRefresh } from "../../scripts/padi/token-refresh.mjs";

const encryptionKey = randomBytes(32);

function encryptedDueRow(userId = "42") {
  return {
    user_id: userId,
    email: `padi-refresh-${userId}@example.com`,
    refresh_token_encrypted: encryptSecret("old-refresh", encryptionKey, `${userId}:refresh`),
    id_token_encrypted: encryptSecret("old-id", encryptionKey, `${userId}:id`),
  };
}

function makeFakeClient(row) {
  const state = { integration: { status: "connected" }, notifications: [], updatedTokens: null };

  return {
    state,
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes("from padi_integrations pi")) {
        return { rows: [row] };
      }
      if (text.includes("set access_token_encrypted")) {
        state.updatedTokens = {
          access: params[0],
          refresh: params[1],
          id: params[2],
          expiresIn: params[3],
        };
        return { rows: [] };
      }
      if (text.includes("set status = 'needs_reconnect'")) {
        if (state.integration.status !== "connected") return { rows: [] };
        state.integration.status = "needs_reconnect";
        return { rows: [{ needs_reconnect_at: new Date("2026-09-05T11:00:00.000Z") }] };
      }
      if (text.includes("insert into notification_queue")) {
        state.notifications.push({
          recipientEmail: params[0],
          notificationType: params[1],
          idempotencyKey: params[2],
          payload: JSON.parse(params[3]),
        });
        return { rows: [{ id: 1 }] };
      }
      if (text === "begin" || text === "commit" || text === "rollback") {
        return { rows: [] };
      }
      throw new Error(`Unhandled fake query: ${text}`);
    },
  };
}

describe("processPadiTokenRefresh token response classification", () => {
  it("normalizes a flat token response and never reads response.tokens blindly", async () => {
    const row = encryptedDueRow();
    const client = makeFakeClient(row);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => ({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        idToken: "new-id",
        expiresIn: "3600",
      }),
      logger: { error: () => {} },
    });

    expect(result).toMatchObject({ refreshed: 1, needsReconnect: 0, refreshFailures: 0 });
    expect(decryptSecret(client.state.updatedTokens.access, encryptionKey, "42:access")).toBe("new-access");
    expect(decryptSecret(client.state.updatedTokens.refresh, encryptionKey, "42:refresh")).toBe("new-refresh");
    expect(decryptSecret(client.state.updatedTokens.id, encryptionKey, "42:id")).toBe("new-id");
    expect(client.state.updatedTokens.expiresIn).toBe(3600);
  });

  it("turns explicit 2xx refresh-token rejection bodies into reconnect notifications", async () => {
    const row = encryptedDueRow("43");
    const client = makeFakeClient(row);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => ({ message: "Refresh token expired" }),
      logger: { error: () => {} },
    });

    expect(result).toMatchObject({ refreshed: 0, needsReconnect: 1, refreshFailures: 0 });
    expect(client.state.integration.status).toBe("needs_reconnect");
    expect(client.state.notifications).toEqual([
      {
        recipientEmail: row.email,
        notificationType: "padi_reconnect",
        idempotencyKey: "padi-reconnect:43:2026-09-05T11:00:00.000Z",
        payload: { userId: "43" },
      },
    ]);
  });

  it("counts unrelated malformed 2xx refresh bodies as transient failures instead of crashing", async () => {
    const row = encryptedDueRow("44");
    const client = makeFakeClient(row);

    const result = await processPadiTokenRefresh(client, {
      encryptionKey,
      refreshFn: async () => ({ message: "temporarily unavailable" }),
      logger: { error: () => {} },
    });

    expect(result).toMatchObject({ refreshed: 0, needsReconnect: 0, refreshFailures: 1 });
    expect(client.state.integration.status).toBe("connected");
    expect(client.state.notifications).toEqual([]);
  });
});
