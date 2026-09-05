import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const WIRE_VERSION = "v1";
const PLACEHOLDER_KEY_VALUE = "replace-with-padi-token-encryption-key";

// AAD convention (enforced by callers, not this module): pass `${userId}:${field}`
// where field is one of "access" / "refresh" / "id", so the three token
// ciphertexts stored for one user's padi_integrations row aren't swappable
// with each other.

/**
 * Encrypts `plaintext` with AES-256-GCM under `key`, authenticated with `aad`.
 * Returns the pinned wire format: `v1:<base64 iv>:<base64 authTag>:<base64 ciphertext>`.
 */
export function encryptSecret(plaintext, key, aad) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    WIRE_VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

function decryptWithKey(ciphertext, key, aad) {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== WIRE_VERSION) {
    throw new Error("Unrecognized ciphertext wire format");
  }

  const [, ivPart, authTagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart, "base64");
  const authTag = Buffer.from(authTagPart, "base64");
  const data = Buffer.from(dataPart, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Decrypts a `v1:`-prefixed ciphertext produced by `encryptSecret`. If decryption
 * under `key` fails and `previousKey` is provided, retries once under `previousKey`
 * before throwing -- this lets an operator rotate PADI_TOKEN_ENCRYPTION_KEY via a
 * temporary PADI_TOKEN_ENCRYPTION_KEY_PREVIOUS env var without breaking every
 * already-stored token.
 */
export function decryptSecret(ciphertext, key, aad, previousKey) {
  try {
    return decryptWithKey(ciphertext, key, aad);
  } catch (error) {
    if (previousKey) {
      return decryptWithKey(ciphertext, previousKey, aad);
    }
    throw error;
  }
}

/**
 * Turns a PADI_TOKEN_ENCRYPTION_KEY-shaped env value (base64) into the 32-byte
 * Buffer key used by encryptSecret/decryptSecret. Throws if the decoded value
 * isn't exactly 32 bytes.
 */
export function keyFromEnvValue(value) {
  const key = Buffer.from(value ?? "", "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `PADI_TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes, got ${key.length}`,
    );
  }
  return key;
}

/**
 * Lazy configuration check: throws a clear error if `keyEnvValue` is unset or
 * equals the literal placeholder from helm-charts/values.yaml. Must be called
 * on first use by callers (server actions, the cronjob) -- never at module load
 * time, so an unconfigured checkout doesn't break unrelated pages/tests/boot.
 */
export function assertKeyConfigured(keyEnvValue) {
  if (!keyEnvValue) {
    throw new Error("PADI_TOKEN_ENCRYPTION_KEY is not configured");
  }
  if (keyEnvValue === PLACEHOLDER_KEY_VALUE) {
    throw new Error("PADI_TOKEN_ENCRYPTION_KEY is still set to its placeholder value");
  }
}
