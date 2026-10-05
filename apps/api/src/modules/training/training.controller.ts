import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query,
} from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  AddBatchCourse,
  AddStudent,
  BatchListQuery,
  BatchStatusChange,
  CourseListQuery,
  CreateCourse,
  CreateModule,
  CreateTrainingBatch,
  ModuleCompletion,
  ReorderCourses,
  ReorderModules,
  StudentQuery,
  UpdateCourse,
  UpdateModule,
  UpdateTrainingBatch,
  parseIfMatch,
} from "./training.schemas.js";
import { TrainingService } from "./training.service.js";

/** Training batches, their courses, students and progress (docs/training-api.md, migration 0065). */
@Controller("api/v1/training")
export class TrainingController {
  constructor(private readonly svc: TrainingService) {}

  // ---------- batches (TR-2..TR-7) ----------
  @Get("batches")
  @RequirePermission("training:read")
  batches(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.listBatches(user, BatchListQuery.parse(q));
  }

  @Post("batches")
  @RequirePermission("training:manage")
  createBatch(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createBatch(user, () => CreateTrainingBatch.parse(body));
  }

  @Get("batches/:id")
  @RequirePermission("training:read")
  batch(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.getBatch(user, id);
  }

  /** `If-Match` carries the rowVersion the client saw (428 without it, 412 when stale). */
  @Patch("batches/:id")
  @RequirePermission("training:manage")
  updateBatch(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.svc.updateBatch(user, id, parseIfMatch(ifMatch), () => UpdateTrainingBatch.parse(body));
  }

  @Put("batches/:id/status")
  @RequirePermission("training:manage")
  status(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.setStatus(user, id, BatchStatusChange.parse(body).to);
  }

  @Delete("batches/:id")
  @HttpCode(204)
  @RequirePermission("training:manage")
  async deleteBatch(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    await this.svc.deleteBatch(user, id);
  }

  // ---------- courses of a batch (TR-4) ----------
  @Post("batches/:id/courses")
  @RequirePermission("training:manage")
  addCourse(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.addBatchCourse(user, id, AddBatchCourse.parse(body).courseId);
  }

  @Put("batches/:id/courses/order")
  @RequirePermission("training:manage")
  reorderCourses(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.reorderBatchCourses(user, id, ReorderCourses.parse(body).courseIds);
  }

  @Delete("batches/:id/courses/:courseId")
  @HttpCode(204)
  @RequirePermission("training:manage")
  async removeCourse(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("courseId", ParseUUIDPipe) courseId: string,
  ) {
    await this.svc.removeBatchCourse(user, id, courseId);
  }

  // ---------- students and progress (TR-8..TR-10) ----------
  @Get("batches/:id/students")
  @RequirePermission("training:read")
  students(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.svc.students(user, id, StudentQuery.parse(q).search || undefined);
  }

  @Get("batches/:id/eligible-students")
  @RequirePermission("training:manage")
  eligible(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.svc.eligibleStudents(user, id, StudentQuery.parse(q).search || undefined);
  }

  @Post("batches/:id/students")
  @RequirePermission("training:manage")
  addStudent(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.addStudent(user, id, AddStudent.parse(body).candidateId);
  }

  @Delete("batches/:id/students/:candidateId")
  @HttpCode(204)
  @RequirePermission("training:manage")
  async removeStudent(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("candidateId", ParseUUIDPipe) candidateId: string,
  ) {
    await this.svc.removeStudent(user, id, candidateId);
  }

  @Put("batches/:id/students/:candidateId/modules/:moduleId")
  @RequirePermission("training.progress:update")
  completion(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("candidateId", ParseUUIDPipe) candidateId: string, @Param("moduleId", ParseUUIDPipe) moduleId: string,
    @Body() body: unknown,
  ) {
    return this.svc.setModuleCompletion(user, id, candidateId, moduleId, ModuleCompletion.parse(body).completed);
  }

  /** People who may be named trainer (they can record progress). */
  @Get("trainers")
  @RequirePermission("training:manage")
  trainers(@CurrentUser() user: AuthedUser) {
    return this.svc.trainers(user);
  }

  // ---------- course library (TR-4) ----------
  @Get("courses")
  @RequirePermission("training:read")
  courses(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.listCourses(user, CourseListQuery.parse(q).includeArchived ?? false);
  }

  @Post("courses")
  @RequirePermission("training:manage")
  createCourse(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.createCourse(user, () => CreateCourse.parse(body));
  }

  @Get("courses/:id")
  @RequirePermission("training:read")
  course(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.getCourse(user, id);
  }

  @Patch("courses/:id")
  @RequirePermission("training:manage")
  updateCourse(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.svc.updateCourse(user, id, parseIfMatch(ifMatch), () => UpdateCourse.parse(body));
  }

  @Delete("courses/:id")
  @HttpCode(204)
  @RequirePermission("training:manage")
  async deleteCourse(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    await this.svc.deleteCourse(user, id);
  }

  @Post("courses/:id/modules")
  @RequirePermission("training:manage")
  addModule(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.addModule(user, id, CreateModule.parse(body));
  }

  @Put("courses/:id/modules/order")
  @RequirePermission("training:manage")
  reorderModules(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.reorderModules(user, id, ReorderModules.parse(body).moduleIds);
  }

  @Patch("courses/:id/modules/:moduleId")
  @RequirePermission("training:manage")
  updateModule(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("moduleId", ParseUUIDPipe) moduleId: string,
    @Body() body: unknown, @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.svc.updateModule(user, id, moduleId, parseIfMatch(ifMatch), () => UpdateModule.parse(body));
  }

  @Delete("courses/:id/modules/:moduleId")
  @HttpCode(204)
  @RequirePermission("training:manage")
  async deleteModule(
    @CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Param("moduleId", ParseUUIDPipe) moduleId: string,
  ) {
    await this.svc.deleteModule(user, id, moduleId);
  }
}

/** The training card of a candidate profile (TR-11). */
@Controller("api/v1/candidates")
export class CandidateTrainingController {
  constructor(private readonly svc: TrainingService) {}

  @Get(":id/training")
  @RequirePermission("training:read")
  training(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.candidateTraining(user, id);
  }
}
