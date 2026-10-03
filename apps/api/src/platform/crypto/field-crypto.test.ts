import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BlindIndexer, dobBlindIndex, normalizeDob } from "./blind-index.js";
import { createBlindIndexer, createKeyProvider, checkFieldCrypto, fieldCryptoEnv, type FieldCryptoConfig } from "./config.js";
import { FieldCipher, FieldCryptoError, MIN_CIPHERTEXT_LEN, openWith, parseHeader, sealWith, type DataKey, type Queryable } from "./field-crypto.js";
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

describe("key material handling (review findings 6 and 7)", () => {
  it("KMS: the SDK's plaintext buffers are zeroed after copying", async () => {
    const generated = new Uint8Array(32).fill(7);
    const decrypted = new Uint8Array(32).fill(8);
    const send = vi.fn(async (cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === "GenerateDataKeyCommand" ? { Plaintext: generated, CiphertextBlob: new Uint8Array(180) } : { Plaintext: decrypted });
    const p = new KmsKeyProvider({ send } as never, "arn:aws:kms:us-east-2:123456789012:key/abc");
    const out = await p.generateDataKey({});
    expect(out.plaintext.equals(Buffer.alloc(32, 7))).toBe(true);
    expect([...generated].every((b) => b === 0)).toBe(true);
    expect((await p.unwrapDataKey(out.wrapped, {})).equals(Buffer.alloc(32, 8))).toBe(true);
    expect([...decrypted].every((b) => b === 0)).toBe(true);
  });

  it("unwrap: a rejected ciphertext is a FieldCryptoError; throttling and network errors are rethrown as they are", async () => {
    const fail = (name: string) => new KmsKeyProvider({ send: async () => { const e = new Error(name); e.name = name; throw e; } } as never, "arn:x");
    await expect(fail("InvalidCiphertextException").unwrapDataKey(Buffer.alloc(10), {})).rejects.toBeInstanceOf(FieldCryptoError);
    await expect(fail("IncorrectKeyException").unwrapDataKey(Buffer.alloc(10), {})).rejects.toBeInstanceOf(FieldCryptoError);
    for (const name of ["ThrottlingException", "TimeoutError", "KMSInternalException"]) {
      const err = await fail(name).unwrapDataKey(Buffer.alloc(10), {}).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(FieldCryptoError);
      expect((err as Error).name).toBe(name);
    }
    const local = new LocalKeyProvider();
    const { wrapped } = await local.generateDataKey({ a: "b" });
    await expect(local.unwrapDataKey(wrapped, { a: "c" })).rejects.toBeInstanceOf(FieldCryptoError);
    await expect(local.unwrapDataKey(Buffer.alloc(5), { a: "b" })).rejects.toBeInstanceOf(FieldCryptoError);
  });

  it("the cache is bounded, evicts and zeroes the oldest, never hands out its own buffers", async () => {
    const provider = new LocalKeyProvider();
    const rows = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      const { wrapped } = await provider.generateDataKey(dataKeyContext("work_auth_number", id));
      rows.set(id, { id, field_class: "work_auth_number", version: i + 1, provider: "local", key_ref: provider.keyRef, wrapped_key: wrapped });
    }
    const db: Queryable = { query: async (_sql: string, params?: unknown[]) => ({ rows: [rows.get(String(params![0]))] as never[] }) };
    const cipher = new FieldCipher(provider, { maxKeys: 3 });
    const ids = [...rows.keys()];
    const encs = await Promise.all(ids.map(async (id, i) => {
      // Seal with a lent copy, then zero the copy: the cache still decrypts.
      const k = await (cipher as unknown as { keyById(db: Queryable, id: string): Promise<DataKey> }).keyById(db, id);
      const enc = sealWith(k, { cls: "work_auth_number", rowId: id }, `N-${i}`);
      cipher.release(k);
      expect(k.key.every((b) => b === 0)).toBe(true);
      return enc;
    }));
    expect(cipher.cacheSize).toBe(3);
    for (const [i, id] of ids.entries()) expect(await cipher.decrypt(db, { cls: "work_auth_number", rowId: id }, encs[i]!)).toBe(`N-${i}`);
    expect(cipher.cacheSize).toBe(3);
  });
});
