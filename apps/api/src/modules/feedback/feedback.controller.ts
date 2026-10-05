import { createHash } from "node:crypto";
import { Body, Controller, Get, Inject, HttpException, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { Public } from "../../platform/auth.guard.js";
import { clientIp } from "../../platform/client-info.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { DbService } from "../../platform/db.service.js";

const Feedback = z.object({ rating: z.number().int().min(1).max(5), notes: z.string().trim().max(4000).optional(),
  format: z.string().trim().max(80).optional(), topics: z.array(z.string().trim().max(100)).max(20).optional(),
  difficultQuestions: z.string().trim().max(4000).optional(), durationMin: z.number().int().min(0).max(1440).optional(), nextStep: z.string().trim().max(1000).optional() }).strict();
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

@Public()
@Controller("api/public/feedback")
export class FeedbackController {
  // Bounded process-local abuse protection. Production edge rate limits supplement
  // this per-instance limit; tokens are hashed before entering the map.
  private readonly limits = new Map<string, { n: number; until: number }>();
  constructor(private readonly db: DbService, @Inject(CONFIG) private readonly config: AppConfig) {}
  private check(req: FastifyRequest, token: string) {
    const now = Date.now();
    for (const [key, value] of this.limits) if (value.until <= now) this.limits.delete(key);
    const ip = clientIp(req, this.config);
    for (const key of [`ip:${ip}`, `token:${hashToken(token)}`]) {
      const entry = this.limits.get(key) ?? { n: 0, until: now + 60_000 };
      if (++entry.n > 30 || (!this.limits.has(key) && this.limits.size >= 10_000)) throw new HttpException("Too many requests", 429);
      this.limits.set(key, entry);
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException("Feedback link unavailable");
    return hashToken(token);
  }
  @Get(":token")
  async get(@Req() req: FastifyRequest, @Param("token") token: string) {
    const hash = this.check(req, token);
    const row = await this.db.system(async (c) => (await c.query("SELECT * FROM eureka.feedback_view($1)", [hash])).rows[0]);
    if (!row) throw new NotFoundException("Feedback link unavailable");
    return { firstName: row.first_name, clientName: row.client_name, startsAt: row.starts_at, expiresAt: row.expires_at };
  }
  @Post(":token")
  async post(@Req() req: FastifyRequest, @Param("token") token: string, @Body() body: unknown) {
    const hash = this.check(req, token);
    const data = Feedback.parse(body);
    const result = await this.db.system(async (c) => (await c.query("SELECT eureka.feedback_submit($1,$2,$3,$4) AS submitted", [hash, data.rating, data.notes ?? null, data])).rows[0]);
    if (!result?.submitted) throw new NotFoundException("Feedback link unavailable");
    return { submitted: true };
  }
}
