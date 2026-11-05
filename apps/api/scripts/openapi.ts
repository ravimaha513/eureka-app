/**
 * Machine-readable API inventory (audit R-19): writes docs/openapi.json (OpenAPI 3.1)
 * from the Nest metadata of every controller registered in AppModule.
 *
 *   pnpm --filter @eureka/api openapi         regenerate docs/openapi.json
 *   pnpm --filter @eureka/api openapi:check   fail when docs/openapi.json is stale (CI)
 *
 * Per route: method, path, tag (the module directory), auth posture (RequirePermission,
 * Public, PortalRoute, SelfService; the permission as `x-eureka-permission`), path
 * parameters, and the zod body/query schema when the handler declares it with
 * @ApiBody/@ApiQuery (src/platform/http/api-doc.ts). Responses: the 2xx status plus
 * RFC 9457 problem+json for 4XX/5XX.
 */
import "reflect-metadata";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi, type RouteConfig } from "@asteasolutions/zod-to-openapi";
import { ParseUUIDPipe, RequestMethod, type Type } from "@nestjs/common";
import { z, type AnyZodObject, type ZodTypeAny } from "zod";
import { AppModule } from "../src/app.module.js";
import { PORTAL_ROUTE, PUBLIC_ROUTE, REQUIRED_PERMISSION, SELF_SERVICE_ROUTE } from "../src/platform/auth.guard.js";
import { loadConfig } from "../src/platform/config.js";
import { API_BODY, API_QUERY } from "../src/platform/http/api-doc.js";
import type { DocumentStorage } from "../src/platform/storage/document-storage.js";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OPENAPI_FILE = join(API_DIR, "../../docs/openapi.json");

/** Nest's internal metadata keys (@nestjs/common/constants). */
const HTTP_CODE = "__httpCode__";
const ROUTE_ARGS = "__routeArguments__";
const PARAM_ARG = 5; // RouteParamtypes.PARAM

export type Auth = "permission" | "public" | "portal" | "portal-public" | "self-service" | "none";

export interface Route {
  method: Lowercase<keyof typeof RequestMethod>;
  /** Nest form, e.g. /api/v1/candidates/:id */
  path: string;
  tag: string;
  controller: string;
  handler: string;
  auth: Auth;
  permission?: string;
  status: number;
  uuidParams: Set<string>;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
}

/** Controller class -> module directory (its tag), from the exports of src/modules/<area>/*.controller.ts. */
async function controllerTags(): Promise<Map<unknown, { tag: string; name: string }>> {
  const out = new Map<unknown, { tag: string; name: string }>();
  const modules = join(API_DIR, "src/modules");
  for (const area of readdirSync(modules).sort()) {
    let files: string[];
    try {
      files = readdirSync(join(modules, area)).filter((f) => f.endsWith(".controller.ts")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const mod = (await import(pathToFileURL(join(modules, area, f)).href)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) if (typeof value === "function" && !out.has(value)) out.set(value, { tag: area, name });
    }
  }
  return out;
}

/** Every route of the controllers registered in AppModule, sorted by path then method. */
export async function routes(): Promise<Route[]> {
  const config = loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "openapi-openapi-openapi-openapi-123",
    PASSWORD_LOGIN: "on", EUREKA_ENVIRONMENT: "local", DATABASE_URL: "postgres://x@127.0.0.1:1/none",
  });
  const controllers = (AppModule.forConfig(config, {} as DocumentStorage).controllers ?? []) as Type[];
  const tags = await controllerTags();
  const paths = (v: unknown): string[] => (Array.isArray(v) ? v : [v ?? ""]).map(String);
  const out: Route[] = [];
  for (const ctrl of controllers) {
    const { tag, name: controller } = tags.get(ctrl) ?? { tag: "platform", name: ctrl.name };
    for (const base of paths(Reflect.getMetadata("path", ctrl))) {
      for (const handler of Object.getOwnPropertyNames(ctrl.prototype)) {
        const fn = ctrl.prototype[handler];
        if (handler === "constructor" || typeof fn !== "function") continue;
        const method = Reflect.getMetadata("method", fn) as RequestMethod | undefined;
        if (method === undefined) continue;
        const meta = (key: string) => Reflect.getMetadata(key, fn) ?? Reflect.getMetadata(key, ctrl);
        const permission = meta(REQUIRED_PERMISSION) as string | undefined;
        const portal = meta(PORTAL_ROUTE) as "session" | "public" | undefined;
        // Same precedence as AuthGuard: portal, then public, then a staff session.
        const auth: Auth = portal === "public" ? "portal-public" : portal !== undefined ? "portal"
          : meta(PUBLIC_ROUTE) !== undefined ? "public" : permission !== undefined ? "permission"
            : meta(SELF_SERVICE_ROUTE) !== undefined ? "self-service" : "none";
        const args = (Reflect.getMetadata(ROUTE_ARGS, ctrl, handler) ?? {}) as Record<string, { data?: unknown; pipes?: unknown[] }>;
        const uuidParams = new Set<string>();
        for (const [key, arg] of Object.entries(args)) {
          if (key.split(":")[0] === String(PARAM_ARG) && typeof arg.data === "string"
            && (arg.pipes ?? []).some((p) => p === ParseUUIDPipe || p instanceof ParseUUIDPipe)) uuidParams.add(arg.data);
        }
        const verb = RequestMethod[method].toLowerCase() as Route["method"];
        for (const p of paths(Reflect.getMetadata("path", fn))) {
          out.push({
            method: verb, path: `/${base}/${p}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1"), tag, controller, handler,
            auth, ...(permission !== undefined ? { permission } : {}),
            status: (Reflect.getMetadata(HTTP_CODE, fn) as number | undefined) ?? (verb === "post" ? 201 : 200),
            uuidParams, body: Reflect.getMetadata(API_BODY, fn), query: Reflect.getMetadata(API_QUERY, fn),
          });
        }
      }
    }
  }
  return out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path < b.path ? -1 : 1));
}

/** /api/v1/x/:id -> /api/v1/x/{id} */
export const openApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

/** The object schema behind refinements/defaults, which OpenAPI query parameters are generated from. */
function queryObject(schema: ZodTypeAny): AnyZodObject | undefined {
  let s: ZodTypeAny = schema;
  for (;;) {
    if (s instanceof z.ZodObject) return s;
    if (s instanceof z.ZodEffects) s = s.innerType();
    else if (s instanceof z.ZodDefault) s = s.removeDefault();
    else if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
    else return undefined;
  }
}

const AUTH_DOC: Record<Auth, string> = {
  permission: "Staff session; the guard requires the permission in x-eureka-permission (data scope from RLS).",
  "self-service": "Any signed-in staff user; data scope from RLS or a check in the service.",
  public: "No session.",
  portal: "Applicant portal session only (staff sessions are refused).",
  "portal-public": "No session; writes must carry the x-eureka-portal header.",
  none: "Undeclared posture: the guard refuses every request (403).",
};

export async function buildOpenApi(): Promise<Record<string, unknown>> {
  // Adds .openapi() to zod types in this process only (the generator calls it); the API never loads this.
  extendZodWithOpenApi(z);
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "staffSession", {
    type: "apiKey", in: "cookie", name: "__Host-eureka_sid",
    description: "Staff session cookie (eureka_sid outside production). Unsafe methods also need the x-csrf-token header.",
  });
  registry.registerComponent("securitySchemes", "portalSession", {
    type: "apiKey", in: "cookie", name: "__Secure-eureka_portal_sid",
    description: "Applicant portal session cookie (eureka_portal_sid outside production).",
  });
  registry.registerComponent("schemas", "Problem", {
    type: "object",
    description: "RFC 9457 problem details (platform/errors.ts ProblemFilter).",
    required: ["type", "title", "status"],
    properties: {
      type: { type: "string", const: "about:blank" },
      title: { type: "string" },
      status: { type: "integer", minimum: 400, maximum: 599 },
      detail: { type: "string" },
      errors: {
        description: "Validation issues (422).",
        type: "array",
        items: { type: "object", required: ["path", "message"], properties: { path: { type: "string" }, message: { type: "string" } } },
      },
      instance: { type: "string", description: "Request id." },
    },
  });
  registry.registerComponent("responses", "Problem", {
    description: "Error (application/problem+json). 404 when the record is not visible, 403 when visible but not allowed, 422 on validation, 503 with Retry-After when the database is unavailable.",
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
  });

  const seen = new Set<string>();
  for (const r of await routes()) {
    const path = openApiPath(r.path);
    const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const query = r.query ? queryObject(r.query) : undefined;
    let operationId = `${r.controller}_${r.handler}`;
    for (let i = 2; seen.has(operationId); i++) operationId = `${r.controller}_${r.handler}_${i}`;
    seen.add(operationId);
    const request: NonNullable<RouteConfig["request"]> = {};
    if (params.length) {
      request.params = z.object(Object.fromEntries(params.map((p) => [p, r.uuidParams.has(p) ? z.string().uuid() : z.string()])));
    }
    if (query) request.query = query;
    if (r.body) request.body = { required: !r.body.isOptional(), content: { "application/json": { schema: r.body } } };
    const route: RouteConfig = {
      method: r.method as RouteConfig["method"],
      path,
      operationId,
      tags: [r.tag],
      description: AUTH_DOC[r.auth],
      security: r.auth === "permission" || r.auth === "self-service" ? [{ staffSession: [] }] : r.auth === "portal" ? [{ portalSession: [] }] : [],
      request,
      responses: {
        [r.status]: { description: r.status === 204 ? "No content" : "Success" },
        "4XX": { $ref: "#/components/responses/Problem" } as never,
        "5XX": { $ref: "#/components/responses/Problem" } as never,
      },
      "x-eureka-auth": r.auth,
      ...(r.permission !== undefined ? { "x-eureka-permission": r.permission } : {}),
      ...(r.query && !query ? { "x-eureka-query-schema": "not an object schema" } : {}),
    };
    registry.registerPath(route);
  }

  const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Eureka API",
      version: "1",
      description: "Generated by apps/api/scripts/openapi.ts from controller metadata; do not edit by hand. Per-area behaviour is documented in docs/<area>-api.md.",
    },
    servers: [{ url: "/" }],
  });
  return doc as unknown as Record<string, unknown>;
}

export const render = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;

async function main(): Promise<void> {
  const text = render(await buildOpenApi());
  const file = relative(process.cwd(), OPENAPI_FILE);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OPENAPI_FILE, "utf8");
    } catch {
      /* missing: stale */
    }
    if (current !== text) {
      console.error(`${file} is out of date: run \`pnpm --filter @eureka/api openapi\` and commit the result.`);
      process.exit(1);
    }
    console.log(`${file} is up to date.`);
    return;
  }
  writeFileSync(OPENAPI_FILE, text);
  console.log(`wrote ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
