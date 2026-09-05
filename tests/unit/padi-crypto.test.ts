import { describe, expect, it } from "vitest";
import {
  assertKeyConfigured,
  decryptSecret,
  encryptSecret,
  keyFromEnvValue,
} from "@/lib/padi/crypto";

function randomKey(seed: number): Buffer {
  return Buffer.alloc(32, seed);
}

describe("padi crypto", () => {
  it("round-trips plaintext through encryptSecret/decryptSecret", () => {
    const key = randomKey(1);
    const ciphertext = encryptSecret("super-secret-token", key, "1:access");

    expect(decryptSecret(ciphertext, key, "1:access")).toBe("super-secret-token");
  });

  it("throws when decrypting with the wrong key", () => {
    const key = randomKey(1);
    const wrongKey = randomKey(2);
    const ciphertext = encryptSecret("super-secret-token", key, "1:access");

    expect(() => decryptSecret(ciphertext, wrongKey, "1:access")).toThrow();
  });

  it("falls back to previousKey when the current key fails", () => {
    const oldKey = randomKey(1);
    const newKey = randomKey(2);
    const ciphertext = encryptSecret("super-secret-token", oldKey, "1:access");

    expect(decryptSecret(ciphertext, newKey, "1:access", oldKey)).toBe("super-secret-token");
  });

  it("fails to decrypt when the aad does not match (GCM auth failure)", () => {
    const key = randomKey(1);
    const ciphertext = encryptSecret("super-secret-token", key, "1:access");

    expect(() => decryptSecret(ciphertext, key, "1:refresh")).toThrow();
  });

  it("never leaks the plaintext secret in a failed decrypt's error", () => {
    const key = randomKey(1);
    const wrongKey = randomKey(2);
    const ciphertext = encryptSecret("super-secret-token", key, "1:access");

    try {
      decryptSecret(ciphertext, wrongKey, "1:access");
      throw new Error("expected decryptSecret to throw");
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      expect(message).not.toContain("super-secret-token");
    }
  });

  it("keyFromEnvValue requires an exactly 32-byte base64 key", () => {
    const validKey = randomKey(3).toString("base64");
    expect(keyFromEnvValue(validKey)).toHaveLength(32);
    expect(() => keyFromEnvValue("dG9vLXNob3J0")).toThrow();
    expect(() => keyFromEnvValue(undefined)).toThrow();
  });

  describe("assertKeyConfigured", () => {
    it("throws when the key is unset", () => {
      expect(() => assertKeyConfigured(undefined)).toThrow();
    });

    it("throws when the key is the literal placeholder value", () => {
      expect(() => assertKeyConfigured("replace-with-padi-token-encryption-key")).toThrow();
    });

    it("does not throw for a plausible real value", () => {
      expect(() => assertKeyConfigured(randomKey(4).toString("base64"))).not.toThrow();
    });
  });
});
