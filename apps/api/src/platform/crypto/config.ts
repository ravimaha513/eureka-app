import { KMSClient } from "@aws-sdk/client-kms";
import { z } from "zod";
import { BlindIndexer } from "./blind-index.js";
import { FieldCipher } from "./field-crypto.js";
import { KmsKeyProvider, KmsMacProvider, LocalKeyProvider, LocalMacProvider, type KeyProvider } from "./key-provider.js";

/**
 * Field encryption settings shared by the API and worker configurations.
 * AWS: FIELD_KMS_KEY_ARN (symmetric key; GenerateDataKey/Decrypt with the
 * field encryption context) and, for the API, BIDX_KMS_KEY_ARN (HMAC key).
 * Without them a local provider is used, with the development keys unless
 * FIELD_LOCAL_KEY / BIDX_LOCAL_KEY are set. Production refuses the local
 * provider (both keys must be KMS keys and no local key may be set).
 */
const hexKey = z.string().regex(/^[0-9a-f]{64}$/i, "must be 64 hex characters");
const kmsArn = z.string().regex(/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-zA-Z-]+$/, "must be a KMS key ARN");

export const fieldCryptoEnv = {
  FIELD_KMS_KEY_ARN: kmsArn.optional(),
  FIELD_LOCAL_KEY: hexKey.optional(),
  BIDX_KMS_KEY_ARN: kmsArn.optional(),
  BIDX_LOCAL_KEY: hexKey.optional(),
};

export interface FieldCryptoConfig {
  NODE_ENV: "development" | "test" | "production";
  AWS_REGION?: string;
  FIELD_KMS_KEY_ARN?: string;
  FIELD_LOCAL_KEY?: string;
  BIDX_KMS_KEY_ARN?: string;
  BIDX_LOCAL_KEY?: string;
}

/** Adds the field-encryption configuration issues (zod superRefine). `bidx`: the blind index key is required too. */
export function checkFieldCrypto(c: FieldCryptoConfig, ctx: z.RefinementCtx, opts: { bidx: boolean }): void {
  if (c.FIELD_KMS_KEY_ARN && c.FIELD_LOCAL_KEY) ctx.addIssue({ code: "custom", message: "Set only one of FIELD_KMS_KEY_ARN and FIELD_LOCAL_KEY" });
  if (c.BIDX_KMS_KEY_ARN && c.BIDX_LOCAL_KEY) ctx.addIssue({ code: "custom", message: "Set only one of BIDX_KMS_KEY_ARN and BIDX_LOCAL_KEY" });
  if ((c.FIELD_KMS_KEY_ARN || (opts.bidx && c.BIDX_KMS_KEY_ARN)) && !c.AWS_REGION) {
    ctx.addIssue({ code: "custom", message: "KMS field encryption requires AWS_REGION" });
  }
  if (c.NODE_ENV === "production") {
    if (!c.FIELD_KMS_KEY_ARN || c.FIELD_LOCAL_KEY) {
      ctx.addIssue({ code: "custom", message: "FIELD_KMS_KEY_ARN is required in production (the local field key provider is for development)" });
    }
    if (opts.bidx && (!c.BIDX_KMS_KEY_ARN || c.BIDX_LOCAL_KEY)) {
      ctx.addIssue({ code: "custom", message: "BIDX_KMS_KEY_ARN is required in production (the local blind index key is for development)" });
    }
  }
}

const kmsClient = (region: string | undefined) => new KMSClient({
  region,
  maxAttempts: 3,
  requestHandler: { requestTimeout: 10_000, connectionTimeout: 5_000 },
});

export function createKeyProvider(c: FieldCryptoConfig): KeyProvider {
  if (c.FIELD_KMS_KEY_ARN) return new KmsKeyProvider(kmsClient(c.AWS_REGION), c.FIELD_KMS_KEY_ARN);
  if (c.NODE_ENV === "production") throw new Error("the local field key provider is not allowed in production");
  return new LocalKeyProvider(c.FIELD_LOCAL_KEY);
}

export function createBlindIndexer(c: FieldCryptoConfig): BlindIndexer {
  if (c.BIDX_KMS_KEY_ARN) return new BlindIndexer(new KmsMacProvider(kmsClient(c.AWS_REGION), c.BIDX_KMS_KEY_ARN));
  if (c.NODE_ENV === "production") throw new Error("the local blind index key is not allowed in production");
  return new BlindIndexer(new LocalMacProvider(c.BIDX_LOCAL_KEY));
}

export interface FieldCrypto { cipher: FieldCipher; blindIndex: BlindIndexer }

export const FIELD_CRYPTO = Symbol("FIELD_CRYPTO");

export function createFieldCrypto(c: FieldCryptoConfig): FieldCrypto {
  return { cipher: new FieldCipher(createKeyProvider(c)), blindIndex: createBlindIndexer(c) };
}
