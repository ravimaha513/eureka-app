import { SetMetadata } from "@nestjs/common";
import type { ZodTypeAny } from "zod";

/**
 * API inventory metadata (audit R-19). Handlers validate with `Schema.parse(body)`
 * themselves; these decorators only record which zod schema a route's body or
 * query is parsed with, so scripts/openapi.ts can describe it in docs/openapi.json.
 * Metadata only: nothing reads them at request time.
 */
export const API_BODY = "eureka:api-body";
export const API_QUERY = "eureka:api-query";

/** The zod schema the handler parses the JSON request body with. */
export const ApiBody = (schema: ZodTypeAny) => SetMetadata(API_BODY, schema);

/** The zod schema the handler parses the query string with. */
export const ApiQuery = (schema: ZodTypeAny) => SetMetadata(API_QUERY, schema);
