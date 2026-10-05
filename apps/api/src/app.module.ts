import "reflect-metadata";
import { FeedbackController } from "./modules/feedback/feedback.controller.js";
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
import { InterviewsController } from "./modules/interviews/interviews.controller.js";
import { InterviewsService } from "./modules/interviews/interviews.service.js";
import { AdminController, TeamsController } from "./modules/admin/admin.controller.js";
import { AdminService } from "./modules/admin/admin.service.js";
import { PlacementsController } from "./modules/placements/placements.controller.js";
import { PlacementsService } from "./modules/placements/placements.service.js";
import { LookupsController, LookupsService } from "./modules/lookups/lookups.controller.js";
import { DashboardController, DashboardService } from "./modules/dashboard/dashboard.controller.js";
import { HotlistController } from "./modules/hotlist/hotlist.controller.js";
import { HotlistService } from "./modules/hotlist/hotlist.service.js";
import { ImportsController, ImportsService } from "./modules/imports/imports.controller.js";
import { assertImportRoleIsolated } from "./platform/role-isolation.js";
import { ResumesController } from "./modules/resumes/resumes.controller.js";
import { ResumesService } from "./modules/resumes/resumes.service.js";
import { PaperworkController } from "./modules/paperwork/paperwork.controller.js";
import { PaperworkService } from "./modules/paperwork/paperwork.service.js";
import { NotificationsController } from "./modules/notifications/notifications.controller.js";
import { NotificationsService } from "./modules/notifications/notifications.service.js";
import { DocumentsController } from "./modules/documents/documents.controller.js";
import { DocumentsService } from "./modules/documents/documents.service.js";
import { StepUpController } from "./modules/identity/step-up.controller.js";
import { AssignmentsController, EmployeesController, EmployeesService, ReportsController, ReportsService } from "./modules/employees/employees.controller.js";
import { DOCUMENT_STORAGE, LocalDocumentStorage, createDocumentStorage, type DocumentStorage } from "./platform/storage/document-storage.js";
import { registerLocalStorageRoutes } from "./platform/storage/local-routes.js";
import { FIELD_CRYPTO, createFieldCrypto } from "./platform/crypto/config.js";
import { WorkAuthorizationController } from "./modules/work-authorization/work-authorization.controller.js";
import { WorkAuthorizationService } from "./modules/work-authorization/work-authorization.service.js";
import { CandidateTrainingController, TrainingController } from "./modules/training/training.controller.js";
import { TrainingService } from "./modules/training/training.service.js";

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
  static forConfig(config: AppConfig, storage: DocumentStorage = createDocumentStorage(config)): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        FeedbackController, HealthController, AuthController, MeController, CandidatesController, SubmissionsController, InterviewsController,
        AdminController, TeamsController, PlacementsController, LookupsController, DashboardController, HotlistController, ImportsController,
        PaperworkController,
        ResumesController, NotificationsController, DocumentsController, StepUpController,
        EmployeesController, AssignmentsController, ReportsController, WorkAuthorizationController,
        // training
        TrainingController, CandidateTrainingController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        DbService, SessionService, AccessService, AuditService, OidcService,
        CandidatesService, SubmissionsService, InterviewsService, AdminService, PlacementsService, LookupsService, DashboardService, HotlistService, ImportsService,
        PaperworkService,
        ResumesService, NotificationsService, DocumentsService, EmployeesService, ReportsService, { provide: DOCUMENT_STORAGE, useValue: storage },
        WorkAuthorizationService, { provide: FIELD_CRYPTO, useFactory: () => createFieldCrypto(config) },
        // training
        TrainingService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    };
  }
}

export async function createApp(config: AppConfig): Promise<NestFastifyApplication> {
  const storage = createDocumentStorage(config);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forConfig(config, storage),
    // trustProxy stays off: X-Forwarded-For is client-controlled (CloudFront and
    // API Gateway append to it) and nothing reads req.ip yet. When a client IP is
    // needed, derive it from CloudFront's CloudFront-Viewer-Address header on
    // requests that passed the origin guard.
    new FastifyAdapter({ trustProxy: false, bodyLimit: 1_048_576 }),
    { logger: config.NODE_ENV === "test" ? false : ["error", "warn", "log"] },
  );
  await app.register(cookie as never);
  const fastify = app.getHttpAdapter().getInstance();
  if (config.ORIGIN_VERIFY_SECRET) fastify.addHook("onRequest", originGuard(config.ORIGIN_VERIFY_SECRET));
  // Local document driver (development, tests): the API stands in for the bucket.
  if (storage instanceof LocalDocumentStorage) await registerLocalStorageRoutes(fastify, storage);
  fastify.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("cache-control", "no-store");
    if (config.NODE_ENV === "production") reply.header("strict-transport-security", "max-age=63072000; includeSubDomains");
  });
  await app.init();
  // Fail fast if the sheet-import role could act as another role (docs/import.md).
  // Skipped in tests: roles are cluster-wide on a shared development server.
  if (config.NODE_ENV !== "test") await assertImportRoleIsolated(app.get(DbService).pool);
  return app;
}
