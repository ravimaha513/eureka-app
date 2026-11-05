import "reflect-metadata";
import { readFileSync } from "node:fs";
import { RequestMethod, type Type } from "@nestjs/common";
import { beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_FILE, buildOpenApi, openApiPath, render } from "../scripts/openapi.js";
import { AppModule } from "../src/app.module.js";
import { REQUIRED_PERMISSION } from "../src/platform/auth.guard.js";
import { loadConfig } from "../src/platform/config.js";
import { API_BODY, API_QUERY, ApiBody } from "../src/platform/http/api-doc.js";
import type { DocumentStorage } from "../src/platform/storage/document-storage.js";
import { z } from "zod";

/** API inventory (audit R-19): docs/openapi.json lists every Nest route and is regenerated, not hand-edited. */

interface Operation {
  tags: string[];
  security: unknown[];
  "x-eureka-auth": string;
  "x-eureka-permission"?: string;
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { required: boolean; content: Record<string, { schema: { properties?: Record<string, unknown>; required?: string[] } }> };
  responses: Record<string, { $ref?: string; description?: string }>;
}
type Doc = { openapi: string; paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, unknown> } };

/** Independent of the generator: every (method, path) of the controllers registered in AppModule, with its permission. */
function nestRoutes(): { key: string; permission?: string; body: boolean; query: boolean }[] {
  const config = loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    PASSWORD_LOGIN: "on", EUREKA_ENVIRONMENT: "local", DATABASE_URL: "postgres://x@127.0.0.1:1/none",
  });
  const controllers = (AppModule.forConfig(config, {} as DocumentStorage).controllers ?? []) as Type[];
  const paths = (v: unknown): string[] => (Array.isArray(v) ? v : [v ?? ""]).map(String);
  const out: { key: string; permission?: string; body: boolean; query: boolean }[] = [];
  for (const ctrl of controllers) {
    for (const base of paths(Reflect.getMetadata("path", ctrl))) {
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const fn = ctrl.prototype[name];
        if (name === "constructor" || typeof fn !== "function") continue;
        const method = Reflect.getMetadata("method", fn) as RequestMethod | undefined;
        if (method === undefined) continue;
        const permission = (Reflect.getMetadata(REQUIRED_PERMISSION, fn) ?? Reflect.getMetadata(REQUIRED_PERMISSION, ctrl)) as string | undefined;
        for (const p of paths(Reflect.getMetadata("path", fn))) {
          const path = `/${base}/${p}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
          out.push({
            key: `${RequestMethod[method].toLowerCase()} ${openApiPath(path)}`, permission,
            body: Reflect.getMetadata(API_BODY, fn) !== undefined, query: Reflect.getMetadata(API_QUERY, fn) !== undefined,
          });
        }
      }
    }
  }
  return out;
}

describe("OpenAPI inventory (docs/openapi.json)", () => {
  let doc: Doc;
  let ops: Map<string, Operation>;
  beforeAll(async () => {
    doc = (await buildOpenApi()) as unknown as Doc;
    ops = new Map(Object.entries(doc.paths).flatMap(([p, ms]) => Object.entries(ms).map(([m, o]) => [`${m} ${p}`, o] as const)));
  });

  it("is OpenAPI 3.1 and lists exactly the routes registered in AppModule", () => {
    expect(doc.openapi).toBe("3.1.0");
    const routes = nestRoutes();
    expect(routes.length).toBeGreaterThan(300);
    const missing = routes.filter((r) => !ops.has(r.key)).map((r) => r.key);
    expect(missing).toEqual([]);
    expect([...ops.keys()].sort()).toEqual([...new Set(routes.map((r) => r.key))].sort());
  });

  it("records each route's posture and permission", () => {
    for (const r of nestRoutes()) {
      const op = ops.get(r.key)!;
      expect(["permission", "public", "portal", "portal-public", "self-service"], r.key).toContain(op["x-eureka-auth"]);
      expect(op["x-eureka-permission"], r.key).toBe(r.permission);
      expect(op.tags, r.key).toHaveLength(1);
      if (op["x-eureka-auth"] === "public" || op["x-eureka-auth"] === "portal-public") expect(op.security, r.key).toEqual([]);
      else expect(op.security, r.key).toHaveLength(1);
    }
    expect(ops.get("get /api/v1/candidates")?.["x-eureka-permission"]).toBe("candidate:read");
    expect(ops.get("get /api/health/live")?.["x-eureka-auth"]).toBe("public");
    expect(ops.get("get /api/v1/me")?.["x-eureka-auth"]).toBe("self-service");
  });

  it("documents a 2xx response and the problem+json error on every route", () => {
    expect(doc.components.schemas.Problem).toBeDefined();
    for (const [key, op] of ops) {
      expect(Object.keys(op.responses).some((s) => /^2\d\d$/.test(s)), key).toBe(true);
      expect(op.responses["4XX"]?.$ref, key).toBe("#/components/responses/Problem");
      expect(op.responses["5XX"]?.$ref, key).toBe("#/components/responses/Problem");
    }
  });

  it("describes the body and query schemas declared with @ApiBody/@ApiQuery", () => {
    for (const r of nestRoutes()) {
      const op = ops.get(r.key)!;
      expect(op.requestBody !== undefined, `${r.key} body`).toBe(r.body);
      if (r.query) expect(op.parameters?.some((p) => p.in === "query"), `${r.key} query`).toBe(true);
    }
    const feedback = ops.get("post /api/public/feedback/{token}")!;
    const schema = feedback.requestBody!.content["application/json"]!.schema;
    expect(schema.required).toEqual(["rating"]);
    expect(Object.keys(schema.properties!)).toContain("notes");
    expect(feedback.parameters).toEqual([expect.objectContaining({ name: "token", in: "path", required: true })]);
    const list = ops.get("get /api/v1/notifications")!;
    expect(list.parameters?.map((p) => p.name)).toEqual(expect.arrayContaining(["cursor", "limit", "unread"]));
  });

  it("ApiBody is metadata only", () => {
    const S = z.object({ a: z.string() });
    class C { m() { return 1; } }
    const d = Object.getOwnPropertyDescriptor(C.prototype, "m")!;
    ApiBody(S)(C.prototype, "m", d);
    expect(Reflect.getMetadata(API_BODY, C.prototype.m)).toBe(S);
    expect(new C().m()).toBe(1);
  });

  it("docs/openapi.json is up to date (pnpm --filter @eureka/api openapi)", () => {
    expect(readFileSync(OPENAPI_FILE, "utf8") === render(doc), "docs/openapi.json is stale: run pnpm --filter @eureka/api openapi").toBe(true);
  });
});
