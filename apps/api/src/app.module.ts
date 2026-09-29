import "reflect-metadata";
import { Controller, Get, type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import { AccessService } from "./platform/access.service.js";
import { AuditService } from "./platform/audit.service.js";
import { AuthGuard, Public } from "./platform/auth.guard.js";
import { CONFIG, type AppConfig } from "./platform/config.js";
import { DbService } from "./platform/db.service.js";
import { ProblemFilter } from "./platform/errors.js";
import { OidcService } from "./platform/oidc.service.js";
import { originGuard } from "./platform/origin-guard.js";
import { SessionService } from "./platform/session.service.js";
import { AuthController } from "./modules/identity/auth.controller.js";
import { MeController } from "./modules/identity/me.controller.js";
import { CandidatesController } from "./modules/candidates/candidates.controller.js";
import { CandidatesService } from "./modules/candidates/candidates.service.js";
import { SubmissionsController, SubmissionsService } from "./modules/submissions/submissions.controller.js";

@Controller("api")
class HealthController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get("health")
  async health() {
    await this.db.system((c) => c.query("SELECT 1"));
    return { status: "ok" };
  }
}

@Module({})
export class AppModule {
  static forConfig(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, MeController, CandidatesController, SubmissionsController],
      providers: [
        { provide: CONFIG, useValue: config },
        DbService, SessionService, AccessService, AuditService, OidcService,
        CandidatesService, SubmissionsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forConfig(config),
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576 }),
    { logger: config.NODE_ENV === "test" ? false : ["error", "warn", "log"] },
  );
  await app.register(cookie as never);
  const fastify = app.getHttpAdapter().getInstance();
  if (config.ORIGIN_VERIFY_SECRET) fastify.addHook("onRequest", originGuard(config.ORIGIN_VERIFY_SECRET));
  fastify.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("cache-control", "no-store");
    if (config.NODE_ENV === "production") reply.header("strict-transport-security", "max-age=63072000; includeSubDomains");
  });
  await app.init();
  return app;
}
