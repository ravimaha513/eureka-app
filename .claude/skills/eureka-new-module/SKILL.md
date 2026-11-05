---
name: eureka-new-module
description: Scaffold or extend a NestJS API area in apps/api/src/modules (controller, service, schemas, errors) with its docs and tests. Use when the user asks for a new API area, a new endpoint group, "add endpoints for X", or a new resource in Eureka's API.
---

# Eureka API module

Reference module: `apps/api/src/modules/training/`. Read its controller and one service method
before writing; copy patterns, don't invent new ones.

## Files

```
apps/api/src/modules/<area>/
  <area>.controller.ts   routes, @RequirePermission, parse body/query with zod schemas
  <area>.service.ts      DB access as the user; calls definer functions for writes
  <area>.schemas.ts      zod schemas, .strict() (unknown keys -> 422; mass-assignment tests rely on it)
  <area>.errors.ts       CODES map: DB exception message -> HttpException
docs/<area>-api.md       endpoint list with ids (XX-1, XX-2 …), permissions, errors
apps/api/test/<area>.api.int.test.ts   (+ <area>.db.int.test.ts for SQL)
```

## Steps

1. `git fetch origin main && git merge origin/main` — `app.module.ts`, `catalog.ts`,
   `apps/web/src/nav.ts`, `apps/web/src/api.ts` are hot files. Keep edits to them one or two lines.
2. Permissions: add to `packages/shared/src/authz/catalog.ts` via the `eureka-authz-grant` skill.
3. Schema/functions: `eureka-migration`, `eureka-definer-fn`, `eureka-rls-policy`.
4. Controller (pattern):
   ```ts
   @Controller("api/v1/<area>")
   export class XController {
     constructor(private readonly svc: XService) {}
     @Patch(":id")
     @RequirePermission("<area>:manage")
     update(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
            @Body() body: unknown, @Headers("if-match") ifMatch: string | undefined) {
       return this.svc.update(user, id, parseIfMatch(ifMatch), () => UpdateX.parse(body));
     }
   }
   ```
   Pass the parse as a thunk so read-before-write (404) runs before body validation (422).
   `If-Match` carries rowVersion: 428 without, 412 when stale.
5. Service: read-before-write. Not visible → 404 (`NotFoundException`), visible but not allowed →
   403. The DB function re-checks (rule 6). Map DB errors through `<area>.errors.ts` +
   `platform/errors.ts` (`P0002` → 404, `42501` → 403).
6. Audit via `AuditService` with field names / ids / type keys only — never values of free text,
   rates, phones, emails (rule 5; `REDACT` in `platform/audit.service.ts`).
7. Register in `app.module.ts` (one line).
8. Docs: `docs/<area>-api.md` — one file per area; don't touch `docs/design.md` beyond a link.
9. Tests: `eureka-int-test`; new write routes need mass-assignment cases
   (`eureka-mass-assignment`) — the coverage test fails otherwise.

## Done when

`pnpm -r typecheck`, `pnpm -r test`, module tests via `pnpm test:api test/<area>.api.int.test.ts --reporter=dot`, and mass-assignment coverage pass.
