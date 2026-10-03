import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BlindIndexer, dobBlindIndex, normalizeDob } from "./blind-index.js";
import { createBlindIndexer, createKeyProvider, checkFieldCrypto, fieldCryptoEnv, type FieldCryptoConfig } from "./config.js";
import { FieldCryptoError, MIN_CIPHERTEXT_LEN, openWith, parseHeader, sealWith, type DataKey } from "./field-crypto.js";
import { KmsKeyProvider, KmsMacProvider, LocalKeyProvider, LocalMacProvider, dataKeyContext } from "./key-provider.js";
import { z } from "zod";

const key = (version = 1, cls: DataKey["cls"] = "work_auth_number"): DataKey => ({ id: randomUUID(), version, cls, key: randomBytes(32) });
const ref = (rowId = randomUUID()) => ({ cls: "work_auth_number" as const, rowId });

describe("field encryption (AES-256-GCM envelope, design A6.3)", () => {
  it("round-trips, with a fresh IV each time and the key id and version in the header", () => {
    const k = key(7);
    const r = ref();
    const a = sealWith(k, r, "EAC2190012345");
    const b = sealWith(k, r, "EAC2190012345");
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBeGreaterThanOrEqual(MIN_CIPHERTEXT_LEN);
    expect(a.includes(Buffer.from("EAC2190012345"))).toBe(false);
    expect(parseHeader(a)).toEqual({ keyId: k.id, version: 7 });
    expect(openWith(k, r, a)).toBe("EAC2190012345");
    expect(openWith(k, r, b)).toBe("EAC2190012345");
  });

  it("is bound to the row: another row id, field class or table does not decrypt", () => {
    const k = key();
    const r = ref();
    const enc = sealWith(k, r, "A1234567");
    expect(() => openWith(k, ref(), enc)).toThrow(FieldCryptoError);
    expect(() => openWith({ ...k, cls: "dob" }, { cls: "dob", rowId: r.rowId }, enc)).toThrow(FieldCryptoError);
    expect(() => openWith(k, { ...r, rowId: "not-a-uuid" }, enc)).toThrow(FieldCryptoError);
  });

  it("rejects tampering with any byte (header, IV, ciphertext, tag) and truncation", () => {
    const k = key();
    const r = ref();
    const enc = sealWith(k, r, "I94-12345678901");
    for (let i = 0; i < enc.length; i++) {
      const t = Buffer.from(enc);
      t[i] = t[i]! ^ 0x01;
      expect(() => openWith(k, r, t), `byte ${i}`).toThrow(FieldCryptoError);
    }
    expect(() => openWith(k, r, enc.subarray(0, enc.length - 1))).toThrow(FieldCryptoError);
    expect(() => openWith(k, r, enc.subarray(0, 10))).toThrow(FieldCryptoError);
  });

  it("refuses a different key, a different version of the same key id and a key of another class", () => {
    const k = key(3);
    const r = ref();
    const enc = sealWith(k, r, "X1");
    expect(() => openWith(key(3), r, enc)).toThrow(/not under this data key/);
    expect(() => openWith({ ...k, version: 4 }, r, enc)).toThrow(/not under this data key/);
    expect(() => sealWith(key(1, "dob"), r, "X1")).toThrow(/another field class/);
  });

  it("error messages never contain the plaintext", () => {
    const k = key();
    const r = ref();
    const enc = sealWith(k, r, "SECRET-NUMBER-42");
    try {
      openWith(k, ref(), enc);
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SECRET");
    }
  });
});

describe("local key provider (development only)", () => {
  it("wraps and unwraps a data key bound to its context", async () => {
    const p = new LocalKeyProvider();
    const ctx = dataKeyContext("work_auth_number", randomUUID());
    const { plaintext, wrapped } = await p.generateDataKey(ctx);
    expect(plaintext).toHaveLength(32);
    expect(wrapped.includes(plaintext)).toBe(false);
    expect((await p.unwrapDataKey(wrapped, ctx)).equals(plaintext)).toBe(true);
    await expect(p.unwrapDataKey(wrapped, { ...ctx, "eureka:key-id": randomUUID() })).rejects.toThrow();
    await expect(p.unwrapDataKey(wrapped, { ...ctx, "eureka:field-class": "dob" })).rejects.toThrow();
    await expect(new LocalKeyProvider("ab".repeat(32)).unwrapDataKey(wrapped, ctx)).rejects.toThrow();
  });

  it("names its key by a fingerprint, so data keys of another local key are told apart", () => {
    expect(new LocalKeyProvider().keyRef).toMatch(/^local:[0-9a-f]{16}$/);
    expect(new LocalKeyProvider("ab".repeat(32)).keyRef).not.toBe(new LocalKeyProvider().keyRef);
    expect(() => new LocalKeyProvider("abcd")).toThrow(/32 bytes/);
  });
});

describe("KMS providers (calls and encryption context)", () => {
  it("generates and decrypts data keys with the field context and the configured key", async () => {
    const send = vi.fn(async (cmd: { input: Record<string, unknown>; constructor: { name: string } }) =>
      cmd.constructor.name === "GenerateDataKeyCommand"
        ? { Plaintext: new Uint8Array(32).fill(1), CiphertextBlob: new Uint8Array(180).fill(2) }
        : { Plaintext: new Uint8Array(32).fill(1) });
    const arn = "arn:aws:kms:us-east-2:123456789012:key/abc";
    const p = new KmsKeyProvider({ send } as never, arn);
    const ctx = dataKeyContext("work_auth_number", "k1");
    const out = await p.generateDataKey(ctx);
    expect(out.plaintext).toHaveLength(32);
    await p.unwrapDataKey(out.wrapped, ctx);
    expect(send.mock.calls.map(([c]) => [c.constructor.name, c.input])).toEqual([
      ["GenerateDataKeyCommand", { KeyId: arn, KeySpec: "AES_256", EncryptionContext: { "eureka:purpose": "field", "eureka:field-class": "work_auth_number", "eureka:key-id": "k1" } }],
      ["DecryptCommand", { KeyId: arn, CiphertextBlob: out.wrapped, EncryptionContext: ctx }],
    ]);
  });

  it("computes the blind index with GenerateMac (HMAC_SHA_256) on the separate key", async () => {
    const send = vi.fn(async () => ({ Mac: new Uint8Array(32).fill(9) }));
    const ix = new BlindIndexer(new KmsMacProvider({ send } as never, "arn:aws:kms:us-east-2:123456789012:key/mac"));
    expect(await ix.compute("dob", "1990-01-31")).toEqual(Buffer.alloc(32, 9));
    const [[cmd]] = send.mock.calls as unknown as [[{ input: { KeyId: string; MacAlgorithm: string; Message: Buffer } }]];
    expect(cmd.input.KeyId).toBe("arn:aws:kms:us-east-2:123456789012:key/mac");
    expect(cmd.input.MacAlgorithm).toBe("HMAC_SHA_256");
    expect(Buffer.from(cmd.input.Message).toString()).toBe("eureka-bidx:v1\0dob\x001990-01-31");
  });
});

describe("blind index (HMAC-SHA256, separate key)", () => {
  const ix = new BlindIndexer(new LocalMacProvider());
  it("is deterministic per value and class, differs by value and by key", async () => {
    const a = await ix.compute("dob", "1990-01-31");
    expect(a).toHaveLength(32);
    expect((await ix.compute("dob", "1990-01-31")).equals(a)).toBe(true);
    expect((await ix.compute("dob", "1990-01-30")).equals(a)).toBe(false);
    const other = new BlindIndexer(new LocalMacProvider("cd".repeat(32)));
    expect((await other.compute("dob", "1990-01-31")).equals(a)).toBe(false);
    await expect(ix.compute("phone" as never, "x")).rejects.toThrow(/unknown/);
  });

  it("normalizes DOB to a real ISO date before indexing; the blind index key is not the field key", async () => {
    const today = new Date("2026-10-03T00:00:00Z");
    expect(normalizeDob(" 1990-01-31 ", today)).toBe("1990-01-31");
    expect(normalizeDob("1990-02-30", today)).toBeNull();
    expect(normalizeDob("31/01/1990", today)).toBeNull();
    expect(normalizeDob("1899-12-31", today)).toBeNull();
    expect(normalizeDob("2027-01-01", today)).toBeNull();
    expect((await dobBlindIndex(ix, " 1990-01-31", today)).equals(await ix.compute("dob", "1990-01-31"))).toBe(true);
    await expect(dobBlindIndex(ix, "1990-13-01", today)).rejects.toThrow(/invalid/);
  });
});

describe("configuration (local provider refused in production)", () => {
  const schema = z.object({ NODE_ENV: z.enum(["development", "test", "production"]), AWS_REGION: z.string().optional(), ...fieldCryptoEnv })
    .superRefine((c, ctx) => checkFieldCrypto(c, ctx, { bidx: true }));
  const arn = "arn:aws:kms:us-east-2:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab";
  const issues = (env: Record<string, string>) => {
    const r = schema.safeParse(env);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("production needs both KMS keys and no local key", () => {
    expect(issues({ NODE_ENV: "production" }).join()).toMatch(/FIELD_KMS_KEY_ARN is required.*BIDX_KMS_KEY_ARN is required/);
    expect(issues({ NODE_ENV: "production", AWS_REGION: "us-east-2", FIELD_KMS_KEY_ARN: arn, BIDX_KMS_KEY_ARN: arn })).toEqual([]);
    expect(issues({ NODE_ENV: "production", AWS_REGION: "us-east-2", FIELD_KMS_KEY_ARN: arn, BIDX_KMS_KEY_ARN: arn, FIELD_LOCAL_KEY: "ab".repeat(32) }).join())
      .toMatch(/only one/);
    expect(issues({ NODE_ENV: "production", FIELD_KMS_KEY_ARN: arn, BIDX_KMS_KEY_ARN: arn }).join()).toMatch(/AWS_REGION/);
    expect(issues({ NODE_ENV: "development", FIELD_KMS_KEY_ARN: "alias/x" }).join()).toMatch(/KMS key ARN/);
    expect(issues({ NODE_ENV: "development" })).toEqual([]);
  });

  it("the factories refuse the local provider in production even if validation was skipped", () => {
    const prod = { NODE_ENV: "production" } as FieldCryptoConfig;
    expect(() => createKeyProvider(prod)).toThrow(/not allowed in production/);
    expect(() => createBlindIndexer(prod)).toThrow(/not allowed in production/);
    expect(createKeyProvider({ NODE_ENV: "test" }).kind).toBe("local");
    expect(createKeyProvider({ NODE_ENV: "production", FIELD_KMS_KEY_ARN: arn, AWS_REGION: "us-east-2" }).kind).toBe("kms");
  });
});
