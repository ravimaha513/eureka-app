import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, GenerateMacCommand, type KMSClient } from "@aws-sdk/client-kms";
import { FieldCryptoError, unwrapFailure } from "./errors.js";

/**
 * Key providers for field encryption (design A6.3). A provider wraps and
 * unwraps per-class AES-256 data keys; the plaintext data key exists only in
 * process memory. KMS in AWS (FIELD_KMS_KEY_ARN); a local provider for
 * development and tests that the configuration refuses in production.
 *
 * The encryption context names the purpose, the field class and the data key
 * id, so a wrapped key cannot be unwrapped for another class or row, and the
 * IAM policy can limit the task roles to field-encryption use of the key
 * (kms:EncryptionContext:eureka:purpose = "field").
 */
export type EncryptionContext = Record<string, string>;

export interface KeyProvider {
  readonly kind: "kms" | "local";
  /** KMS key ARN, or the local key's label. Stored with each data key; must match on unwrap. */
  readonly keyRef: string;
  generateDataKey(context: EncryptionContext): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  unwrapDataKey(wrapped: Buffer, context: EncryptionContext): Promise<Buffer>;
}

/** Context of a field data key (also the IAM condition keys). */
export function dataKeyContext(fieldClass: string, keyId: string): EncryptionContext {
  return { "eureka:purpose": "field", "eureka:field-class": fieldClass, "eureka:key-id": keyId };
}

/** Canonical bytes of a context (sorted keys), the AAD of the local provider's wrap. */
function canonical(context: EncryptionContext): Buffer {
  return Buffer.from(JSON.stringify(Object.keys(context).sort().map((k) => [k, context[k]])), "utf8");
}

/**
 * Development keys. NOT SECRET: they are in the repository so that a local
 * stack and the tests work without AWS. The configuration refuses the local
 * provider in production (platform/crypto/config.ts).
 */
export const DEV_FIELD_KEY_HEX = "6465762d6f6e6c792d6669656c642d6b65792d6e6f742d7365637265742d2d31";
export const DEV_BIDX_KEY_HEX = "6465762d6f6e6c792d626c696e642d696e6465782d6e6f742d7365637265742d";

const fingerprint = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export class LocalKeyProvider implements KeyProvider {
  readonly kind = "local" as const;
  readonly keyRef: string;
  private readonly master: Buffer;

  constructor(masterKeyHex: string = DEV_FIELD_KEY_HEX) {
    const key = Buffer.from(masterKeyHex, "hex");
    if (key.length !== 32) throw new Error("the local field key must be 32 bytes (64 hex characters)");
    this.master = key;
    this.keyRef = `local:${fingerprint(key)}`;
  }

  async generateDataKey(context: EncryptionContext) {
    const plaintext = randomBytes(32);
    return { plaintext, wrapped: this.wrap(plaintext, context) };
  }

  private wrap(plaintext: Buffer, context: EncryptionContext): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.master, iv);
    c.setAAD(canonical(context));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]);
  }

  async unwrapDataKey(wrapped: Buffer, context: EncryptionContext): Promise<Buffer> {
    if (wrapped.length !== 12 + 32 + 16) throw new FieldCryptoError("wrapped data key has the wrong length");
    try {
      const d = createDecipheriv("aes-256-gcm", this.master, wrapped.subarray(0, 12));
      d.setAAD(canonical(context));
      d.setAuthTag(wrapped.subarray(44));
      return Buffer.concat([d.update(wrapped.subarray(12, 44)), d.final()]);
    } catch {
      throw new FieldCryptoError("data key cannot be unwrapped (local)");
    }
  }
}

/** Our own copy of a key from the SDK; the SDK's buffer is zeroed (review finding 6). */
function copyAndZero(src: Uint8Array): Buffer {
  const out = Buffer.alloc(src.length);
  out.set(src);
  src.fill(0);
  return out;
}

export class KmsKeyProvider implements KeyProvider {
  readonly kind = "kms" as const;

  constructor(private readonly kms: Pick<KMSClient, "send">, readonly keyRef: string) {}

  async generateDataKey(context: EncryptionContext) {
    const out = await this.kms.send(new GenerateDataKeyCommand({ KeyId: this.keyRef, KeySpec: "AES_256", EncryptionContext: context }));
    if (!out.Plaintext || !out.CiphertextBlob || out.Plaintext.length !== 32) {
      out.Plaintext?.fill(0);
      throw new Error("KMS returned no data key");
    }
    return { plaintext: copyAndZero(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob) };
  }

  async unwrapDataKey(wrapped: Buffer, context: EncryptionContext): Promise<Buffer> {
    const out = await this.kms.send(new DecryptCommand({ KeyId: this.keyRef, CiphertextBlob: wrapped, EncryptionContext: context }))
      .catch(unwrapFailure);
    if (!out.Plaintext || out.Plaintext.length !== 32) {
      out.Plaintext?.fill(0);
      throw new FieldCryptoError("KMS returned no data key");
    }
    return copyAndZero(out.Plaintext);
  }
}

/**
 * Blind index MAC (design A6.3 "Searchable encrypted fields"): HMAC-SHA256
 * with a key separate from the field key. In AWS a KMS HMAC key
 * (BIDX_KMS_KEY_ARN, GenerateMac; the key never leaves KMS); locally an HMAC key.
 */
export interface MacProvider {
  readonly kind: "kms" | "local";
  mac(message: Buffer): Promise<Buffer>;
}

export class LocalMacProvider implements MacProvider {
  readonly kind = "local" as const;
  private readonly key: Buffer;

  constructor(keyHex: string = DEV_BIDX_KEY_HEX) {
    const key = Buffer.from(keyHex, "hex");
    if (key.length !== 32) throw new Error("the local blind index key must be 32 bytes (64 hex characters)");
    this.key = key;
  }

  async mac(message: Buffer): Promise<Buffer> {
    return createHmac("sha256", this.key).update(message).digest();
  }
}

export class KmsMacProvider implements MacProvider {
  readonly kind = "kms" as const;

  constructor(private readonly kms: Pick<KMSClient, "send">, private readonly keyArn: string) {}

  async mac(message: Buffer): Promise<Buffer> {
    const out = await this.kms.send(new GenerateMacCommand({ KeyId: this.keyArn, MacAlgorithm: "HMAC_SHA_256", Message: message }));
    if (!out.Mac || out.Mac.length !== 32) throw new Error("KMS returned no MAC");
    return Buffer.from(out.Mac);
  }
}
