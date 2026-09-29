import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

/**
 * Maps errors to RFC 9457 problem details. Database errors are mapped to
 * generic messages that never name another team's record (design B3).
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger("ProblemFilter");

  catch(err: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, title, detail, errors } = toProblem(err);
    if (status >= 500) this.log.error(err);
    void reply
      .status(status)
      .header("content-type", "application/problem+json")
      .send({ type: "about:blank", title, status, ...(detail ? { detail } : {}), ...(errors ? { errors } : {}) });
  }
}

interface Problem { status: number; title: string; detail?: string; errors?: unknown }

export function toProblem(err: unknown): Problem {
  if (err instanceof ZodError) {
    return { status: 422, title: "Validation failed", errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  if (err instanceof HttpException) {
    const res = err.getResponse();
    const detail = typeof res === "string" ? res : (res as { message?: string }).message;
    return { status: err.getStatus(), title: err.name.replace(/Exception$/, ""), detail };
  }
  const code = (err as { code?: string }).code;
  switch (code) {
    case "42501": // insufficient_privilege, including RLS WITH CHECK violations
      return { status: 403, title: "Forbidden", detail: "Not permitted" };
    case "P0002": // no_data_found
      return { status: 404, title: "Not Found" };
    case "23505":
      return { status: 409, title: "Conflict", detail: "A conflicting record exists" };
    case "23503":
    case "23514":
    case "22P02":
      return { status: 422, title: "Unprocessable", detail: "Request violates a data rule" };
    default:
      return { status: 500, title: "Internal Server Error" };
  }
}
