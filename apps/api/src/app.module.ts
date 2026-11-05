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
import { ProblemFilter, RetryableUnavailable } from "./platform/errors.js";
import { JsonLoggerService, setLogWriter } from "./platform/logger.js";
import { registerMetrics } from "./platform/metrics.js";
import { genReqId, registerRequestId } from "./platform/request-context.js";
import { OidcService } from "./platform/oidc.service.js";
import { ReportExecutor } from "./platform/report-executor.js";
import { originGuard } from "./platform/origin-guard.js";
import { SessionService } from "./platform/session.service.js";
import { AuthController } from "./modules/identity/auth.controller.js";
import { PasswordController } from "./modules/identity/password.controller.js";
import { MeController } from "./modules/identity/me.controller.js";
import { SettingsController } from "./modules/identity/settings.controller.js";
import { SettingsService } from "./modules/identity/settings.service.js";
import { CandidatesController } from "./modules/candidates/candidates.controller.js";
import { CandidatesService } from "./modules/candidates/candidates.service.js";
import { CandidateMetricsService } from "./modules/candidates/candidate-metrics.service.js";
import { CandidateBatchesService } from "./modules/candidates/candidate-batches.service.js";
import { CandidateCreateService } from "./modules/candidates/candidate-create.service.js";
import { CandidateListService } from "./modules/candidates/candidate-list.service.js";
import { CandidateProfileService } from "./modules/candidates/candidate-profile.service.js";
import { CandidateTimelineService } from "./modules/candidates/candidate-timeline.service.js";
import { SubmissionsController, SubmissionsService } from "./modules/submissions/submissions.controller.js";
import { InterviewsController } from "./modules/interviews/interviews.controller.js";
import { InterviewsService } from "./modules/interviews/interviews.service.js";
import { AdminController, CoachAssignmentsController, TeamsController, UserDesignationController } from "./modules/admin/admin.controller.js";
import { PerformanceController, PerformanceService } from "./modules/performance/performance.controller.js";
import { ADMIN_PROVIDERS } from "./modules/admin/admin.providers.js";
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
import {
  BillsController, BillsService, CompaniesController, CompanyEmployeeOptionsController, CompanyEmployeesController, FacilitiesController,
  OwnersService, UtilitiesController, UtilitiesService,
} from "./modules/facilities/facilities.controller.js";
import { DatahubController } from "./modules/datahub/datahub.controller.js";
import { DatahubService } from "./modules/datahub/datahub.service.js";
import { CandidateTrainingController, TrainingController } from "./modules/training/training.controller.js";
import { TrainingService } from "./modules/training/training.service.js";
import { ChatController } from "./modules/chat/chat.controller.js";
import { ChatService } from "./modules/chat/chat.service.js";
import { JobsController, JobsService } from "./modules/jobs/jobs.controller.js";
import { PortalAuthController, PortalAuthService, PortalDevMailboxController, PortalMeController } from "./modules/portal/portal-auth.controller.js";
import { PortalSessionService } from "./platform/portal-session.service.js";
import { MAIL_PORT, createMailPort } from "./platform/mail.js";
import { ApplicantsController, ApplicationInterviewsController, ApplicationsController, ApplicationsService } from "./modules/applications/applications.controller.js";
import { PortalJobsController, PortalJobsService } from "./modules/portal/portal-jobs.controller.js";
// interview-alerts
import { ContractsController } from "./modules/contracts/contracts.controller.js";
import { ContractsService } from "./modules/contracts/contracts.service.js";
import { CalendarController, InterviewCalendarController } from "./modules/calendar/calendar.controller.js";
import { CalendarService } from "./modules/calendar/calendar.service.js";
import { CoachCalendarController } from "./modules/calendar/coach-calendar.controller.js";
import { CoachCalendarService } from "./modules/calendar/coach-calendar.service.js";
import { CoachGoogleController } from "./modules/calendar/coach-google.controller.js";
import { CoachGoogleService } from "./modules/calendar/coach-google.service.js";
import { CALENDAR_PROVIDER, DevCalendarProvider, GoogleCalendarProvider } from "./modules/calendar/calendar.provider.js";
import { StaffBirthdaysController, StaffBirthdaysService } from "./modules/staff/birthdays.controller.js";
import { PaymentsController, PaymentsService } from "./modules/payments/payments.controller.js";
import { MarketReportController, MarketReportService } from "./modules/reports/market-report.controller.js";
import { InterviewReportsController, InterviewReportsService } from "./modules/interview-reports/interview-reports.controller.js";
import { AssessmentsController, NonResponseController, PipelineReportController, PipelineReportService } from "./modules/pipeline-report/pipeline-report.controller.js";
import { PreferredVendorsController, PreferredVendorsService } from "./modules/preferred-vendors/preferred-vendors.controller.js";

/** Readiness: the database ping must answer within this many ms (a starved pool must not hang the probe). */
const READY_TIMEOUT_MS = 1000;

@Controller("api")
class HealthController {
  constructor(private readonly db: DbService) {}

  /** Liveness (the ECS container health check): the process serves HTTP; no database, so a busy pool never gets the task replaced. */
  @Public()
  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  /** Readiness: a database ping with a 1 s bound; 503 + Retry-After when the pool or database does not answer in time. */
  @Public()
  @Get("health/ready")
  async ready() {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RetryableUnavailable("database_unavailable", 5)), READY_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.db.system((c) => c.query("SELECT 1")), timeout]);
    } catch (err) {
      if (err instanceof RetryableUnavailable) throw err;
      throw new RetryableUnavailable("database_unavailable", 5);
    } finally {
      clearTimeout(timer);
    }
    return { status: "ok" };
  }

  /** Backward-compatible alias of readiness (deploy smoke tests, local-dev script). */
  @Public()
  @Get("health")
  health() {
    return this.ready();
  }
}

@Module({})
export class AppModule {
  static forConfig(config: AppConfig, storage: DocumentStorage = createDocumentStorage(config)): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        FeedbackController, HealthController, AuthController, PasswordController, MeController, CandidatesController, SubmissionsController, InterviewsController,
        AdminController, TeamsController, CoachAssignmentsController, PlacementsController, LookupsController, DashboardController, HotlistController, ImportsController,
        PaperworkController,
        ResumesController, NotificationsController, DocumentsController, StepUpController,
        EmployeesController, AssignmentsController, ReportsController, WorkAuthorizationController,
        CompaniesController, FacilitiesController, CompanyEmployeesController, CompanyEmployeeOptionsController,
        UtilitiesController, BillsController,
        DatahubController,
        // training
        TrainingController, CandidateTrainingController,
        SettingsController,
        ChatController,
        // jobs-portal
        JobsController, PortalAuthController, PortalMeController, PortalDevMailboxController,
        ApplicationsController, ApplicationInterviewsController, ApplicantsController, PortalJobsController,
        // interview-alerts
        ContractsController, CalendarController, InterviewCalendarController, CoachCalendarController, CoachGoogleController, StaffBirthdaysController,
        // payments
        PaymentsController,
        // performance
        PerformanceController, UserDesignationController,
        // market-reports
        MarketReportController,
        // interview-reports
        InterviewReportsController,
        // pipeline-vendors
        PipelineReportController, AssessmentsController, NonResponseController, PreferredVendorsController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        DbService, SessionService, AccessService, AuditService, OidcService, SettingsService, ReportExecutor,
        CandidatesService, CandidateMetricsService, SubmissionsService, InterviewsService, ...ADMIN_PROVIDERS, PlacementsService, LookupsService, DashboardService, HotlistService, ImportsService,
        PaperworkService,
        ResumesService, NotificationsService, DocumentsService, EmployeesService, ReportsService, { provide: DOCUMENT_STORAGE, useValue: storage },
        CandidateListService, CandidateProfileService, CandidateCreateService, CandidateBatchesService, CandidateTimelineService,
        WorkAuthorizationService, OwnersService, UtilitiesService, BillsService, { provide: FIELD_CRYPTO, useFactory: () => createFieldCrypto(config) },
        DatahubService,
        // training
        TrainingService,
        ChatService,
        // jobs-portal
        JobsService, PortalSessionService, PortalAuthService, { provide: MAIL_PORT, useFactory: () => createMailPort(config) },
        ApplicationsService, PortalJobsService,
        // interview-alerts
        ContractsService, CalendarService, CoachCalendarService, CoachGoogleService, StaffBirthdaysService,
        // performance
        PerformanceService,
        { provide: CALENDAR_PROVIDER, useFactory: () => config.CALENDAR_MODE === "google"
          ? new GoogleCalendarProvider(config.GOOGLE_CLIENT_ID!, config.GOOGLE_CLIENT_SECRET!) : new DevCalendarProvider() },
        // payments
        PaymentsService,
        // market-reports
        MarketReportService,
        // interview-reports
        InterviewReportsService,
        // pipeline-vendors
        PipelineReportService, PreferredVendorsService,
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
    // Request ids (audit R-11): genReqId from x-amzn-trace-id, else a UUID; a
    // client `request-id` header is not trusted (requestIdHeader: false).
    new FastifyAdapter({ trustProxy: false, bodyLimit: 1_048_576, requestIdHeader: false, genReqId }),
    // Structured JSON logs (platform/logger.ts); tests stay quiet.
    { logger: config.NODE_ENV === "test" ? false : new JsonLoggerService() },
  );
  if (config.NODE_ENV === "test") setLogWriter("silent");
  await app.register(cookie as never);
  const fastify = app.getHttpAdapter().getInstance();
  registerRequestId(fastify);
  registerMetrics(fastify, app.get(DbService).pool);
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
