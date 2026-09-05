import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PADI_CLIENT_ID,
  PadiApiError,
  decodeIdTokenClaims,
  fetchLogbookDetail,
  fetchLogbookPage,
  login,
  refresh,
} from "@/lib/padi/client";

function jsonResponse(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login", () => {
  it("posts the username/password/clientId to PADI's login endpoint", async () => {
    const sampleTokens = {
      tokens: {
        idToken: "id.token.value",
        accessToken: "access.token.value",
        refreshToken: "refresh.token.value",
        tokenType: "Bearer",
        expiresIn: 3600,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sampleTokens));
    vi.stubGlobal("fetch", fetchMock);

    const result = await login("aleksandr.vin@gmail.com", "correct horse battery staple");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.global-prod.padi.com/auth/api/oauth/login");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(options.body)).toEqual({
      username: "aleksandr.vin@gmail.com",
      password: "correct horse battery staple",
      clientId: PADI_CLIENT_ID,
    });
    expect(result).toEqual(sampleTokens);
  });

  it("throws a PadiApiError that never contains the password on a failed login", async () => {
    const password = "super-secret-password-123";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "Incorrect username or password." }, { ok: false, status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await login("aleksandr.vin@gmail.com", password);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PadiApiError);
    expect((thrown as PadiApiError).status).toBe(400);
    expect((thrown as Error).message).not.toContain(password);
    expect(JSON.stringify(thrown)).not.toContain(password);
  });

  it("throws a PadiApiError on a network failure without leaking the password", async () => {
    const password = "another-secret-password";
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await login("aleksandr.vin@gmail.com", password);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PadiApiError);
    expect((thrown as Error).message).not.toContain(password);
  });
});

describe("refresh", () => {
  it("posts the refreshToken/clientId/idToken to PADI's refresh endpoint", async () => {
    const sampleTokens = { tokens: { idToken: "new-id", accessToken: "new-access", refreshToken: "new-refresh", tokenType: "Bearer", expiresIn: 3600 } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sampleTokens));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refresh("old-refresh-token", "old-id-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.global-prod.padi.com/auth/api/oauth/refresh");
    expect(JSON.parse(options.body)).toEqual({
      refreshToken: "old-refresh-token",
      clientId: PADI_CLIENT_ID,
      idToken: "old-id-token",
    });
    expect(result).toEqual(sampleTokens);
  });

  it("throws a PadiApiError on a rejected refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "invalid_grant" }, { ok: false, status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refresh("expired-refresh-token", "old-id-token")).rejects.toBeInstanceOf(PadiApiError);
  });
});

describe("fetchLogbookPage", () => {
  it("sends the affiliate-id header, x-platform header, and affiliate_id GraphQL variable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { logbook_logs: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchLogbookPage("access-token-value", "29837190", { limit: 15, offset: 15 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://logbook.global-prod.padi.com/api/Logbook");
    expect(options.headers["affiliate-id"]).toBe("29837190");
    expect(options.headers["x-platform"]).toBe("web");
    expect(options.headers.Authorization).toBe("Bearer access-token-value");

    const body = JSON.parse(options.body);
    expect(body.variables).toEqual({ affiliate_id: "29837190", limit: 15, offset: 15 });
    expect(body.query).toContain("logbook_logs");
  });
});

describe("fetchLogbookDetail", () => {
  it("sends the affiliate-id/x-platform headers and affiliate_id + id GraphQL variables", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { logbook_logs: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchLogbookDetail("access-token-value", "29837190", 22238544);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://logbook.global-prod.padi.com/api/Logbook");
    expect(options.headers["affiliate-id"]).toBe("29837190");
    expect(options.headers["x-platform"]).toBe("web");

    const body = JSON.parse(options.body);
    expect(body.variables).toEqual({ affiliate_id: "29837190", id: "22238544" });
  });
});

describe("decodeIdTokenClaims", () => {
  it("extracts affiliateId from the custom:affiliate_id claim", () => {
    const payload = { sub: "some-user-id", "custom:affiliate_id": "29837190" };
    const fakeJwt = [
      Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "dummy-signature",
    ].join(".");

    expect(decodeIdTokenClaims(fakeJwt)).toEqual({ affiliateId: "29837190" });
  });
});
