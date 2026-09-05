export function encryptSecret(plaintext: string, key: Buffer, aad: string): string;
export function decryptSecret(
  ciphertext: string,
  key: Buffer,
  aad: string,
  previousKey?: Buffer,
): string;
export function keyFromEnvValue(value: string | undefined): Buffer;
export function assertKeyConfigured(keyEnvValue: string | undefined): void;
