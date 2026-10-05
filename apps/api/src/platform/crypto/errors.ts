/**
 * A value or data key that cannot be decrypted as stored (wrong row, key,
 * provider, tampering, a wrapped key KMS or the local provider rejects).
 * Never carries plaintext. Transient failures (throttling, network, timeouts)
 * are not FieldCryptoErrors: callers retry those.
 */
export class FieldCryptoError extends Error {}

/** KMS errors that mean "this ciphertext or key cannot be used", not "try again". */
const KMS_PERMANENT = new Set([
  "InvalidCiphertextException", "IncorrectKeyException", "InvalidKeyUsageException", "InvalidGrantTokenException",
]);

/** Maps a provider unwrap failure: permanent ones become FieldCryptoError, others are rethrown as they are. */
export function unwrapFailure(err: unknown): never {
  const name = (err as { name?: string } | null)?.name;
  if (name !== undefined && KMS_PERMANENT.has(name)) throw new FieldCryptoError(`data key cannot be unwrapped (${name})`);
  throw err;
}
