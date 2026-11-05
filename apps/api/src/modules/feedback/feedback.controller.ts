import { createHash } from "node:crypto";
import { Body, Controller, Get, Inject, HttpException, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { Public } from "../../platform/auth.guard.js";
import { clientIp, ipKey } from "../../platform/client-ip.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";
import { SharedRateLimiter } from "../../platform/rate-limit.js";
import { ApiBody } from "../../platform/http/api-doc.js";

const Feedback = z.object({ rating: z.number().int().min(1).max(5), notes: z.string().trim().max(4000).optional(),
  format: z.string().trim().max(80).optional(), topics: z.array(z.string().trim().max(100)).max(20).optional(),
  difficultQuestions: z.string().trim().max(4000).optional(), durationMin: z.number().int().min(0).max(1440).optional(), nextStep: z.string().trim().max(1000).optional() }).strict();
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

@Public()
@Controller("api/public/feedback")
export class FeedbackController {
  // Abuse protection shared by all tasks and kept across deploys (SharedRateLimiter,
  // R-24; an in-memory first gate per task). Production edge rate limits supplement
  // it; tokens are hashed before entering the limiter, and keys are stored hashed.
  // Client addresses are keyed like the password and portal routes (ipKey: IPv6 by
  // /64, so rotating inside one allocation earns nothing). Tokens have their own
  // map, so a flood of distinct tokens can never evict the per-address windows.
  private readonly ipLimiter = new SharedRateLimiter("feedback.ip", 30, 60_000);
  private readonly tokenLimiter = new SharedRateLimiter("feedback.token", 30, 60_000);
  constructor(private readonly db: DbService, @Inject(CONFIG) private readonly config: AppConfig) {}
  private async check(req: FastifyRequest, token: string) {
    // Limiter runs before the format check so guessing malformed tokens is also throttled.
    // The address is taken first: a refused client never adds a token key.
    if (!(await this.ipLimiter.take(`ip:${ipKey(clientIp(req, this.config))}`, this.db))) throw new HttpException("Too many requests", 429);
    const hash = hashToken(token);
    if (!(await this.tokenLimiter.take(`token:${hash}`, this.db))) throw new HttpException("Too many requests", 429);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException("Feedback link unavailable");
    return hash;
  }
  @Get(":token")
  async get(@Req() req: FastifyRequest, @Param("token") token: string) {
    const hash = await this.check(req, token);
    const row = await this.db.system(async (c) => (await c.query("SELECT * FROM eureka.feedback_view($1)", [hash])).rows[0]);
    if (!row) throw new NotFoundException("Feedback link unavailable");
    return { firstName: row.first_name, clientName: row.client_name, startsAt: row.starts_at, expiresAt: row.expires_at };
  }
  @ApiBody(Feedback)
  @Post(":token")
  async post(@Req() req: FastifyRequest, @Param("token") token: string, @Body() body: unknown) {
    const hash = await this.check(req, token);
    const data = Feedback.parse(body);
    const result = await this.db.system(async (c) => (await c.query("SELECT eureka.feedback_submit($1,$2,$3,$4) AS submitted", [hash, data.rating, data.notes ?? null, data])).rows[0]);
    if (!result?.submitted) throw new NotFoundException("Feedback link unavailable");
    return { submitted: true };
  }
}
