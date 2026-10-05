import {
  Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Param, ParseUUIDPipe, Patch, Post, Put, Query,
} from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  BatchCoursesPut, BatchCreate, BatchListQuery, BatchPatch, CourseCreate, CourseListQuery, CoursePatch, ModulesPut,
  ProgressPut, StudentListQuery, StudentLookupQuery, StudentsAdd, parseIfMatch,
} from "./lms.schemas.js";
import { LmsService } from "./lms.service.js";

export { LmsService };
const id = () => new ParseUUIDPipe();

/** docs/lms-api.md: staff (lms:manage) and learner (lms:learn) endpoints. */
@Controller("api/v1/lms")
export class LmsController {
  constructor(private readonly svc: LmsService) {}

  // ---- staff
  @Get("courses") @RequirePermission("lms:manage")
  courses(@CurrentUser() u: AuthedUser, @Query() q: unknown) { return this.svc.listCourses(u, CourseListQuery.parse(q)); }

  @Post("courses") @RequirePermission("lms:manage")
  createCourse(@CurrentUser() u: AuthedUser, @Body() b: unknown) { return this.svc.createCourse(u, CourseCreate.parse(b)); }

  @Get("courses/:id") @RequirePermission("lms:manage")
  course(@CurrentUser() u: AuthedUser, @Param("id", id()) cid: string) { return this.svc.getCourse(u, cid); }

  /** Optimistic concurrency: `If-Match` carries the course `version` the client saw (428 without it, 412 when stale). */
  @Patch("courses/:id") @RequirePermission("lms:manage")
  patchCourse(@CurrentUser() u: AuthedUser, @Param("id", id()) cid: string, @Body() b: unknown, @Headers("if-match") ifMatch: string | undefined) {
    const body = CoursePatch.parse(b);
    const v = parseIfMatch(ifMatch);
    if (v === null) throw new HttpException("if_match_required", 428);
    return this.svc.updateCourse(u, cid, v, body);
  }

  /** `If-Match` is optional here (full replace); when sent it must match. */
  @Put("courses/:id/modules") @RequirePermission("lms:manage")
  putModules(@CurrentUser() u: AuthedUser, @Param("id", id()) cid: string, @Body() b: unknown, @Headers("if-match") ifMatch: string | undefined) {
    return this.svc.setModules(u, cid, ifMatch === undefined ? null : parseIfMatch(ifMatch) ?? -1, ModulesPut.parse(b));
  }

  @Get("batches") @RequirePermission("lms:manage")
  batches(@CurrentUser() u: AuthedUser, @Query() q: unknown) { return this.svc.listBatches(u, BatchListQuery.parse(q)); }

  @Post("batches") @RequirePermission("lms:manage")
  createBatch(@CurrentUser() u: AuthedUser, @Body() b: unknown) { return this.svc.createBatch(u, BatchCreate.parse(b)); }

  @Get("batches/:id") @RequirePermission("lms:manage")
  batch(@CurrentUser() u: AuthedUser, @Param("id", id()) bid: string) { return this.svc.getBatch(u, bid); }

  @Patch("batches/:id") @RequirePermission("lms:manage")
  patchBatch(@CurrentUser() u: AuthedUser, @Param("id", id()) bid: string, @Body() b: unknown) { return this.svc.updateBatch(u, bid, BatchPatch.parse(b)); }

  @Delete("batches/:id") @HttpCode(204) @RequirePermission("lms:manage")
  async deleteBatch(@CurrentUser() u: AuthedUser, @Param("id", id()) bid: string) { await this.svc.deleteBatch(u, bid); }

  @Put("batches/:id/courses") @RequirePermission("lms:manage")
  putCourses(@CurrentUser() u: AuthedUser, @Param("id", id()) bid: string, @Body() b: unknown) {
    return this.svc.setBatchCourses(u, bid, BatchCoursesPut.parse(b).courseIds);
  }

  @Get("batches/:id/students") @RequirePermission("lms:manage")
  students(@CurrentUser() u: AuthedUser, @Param("id", id()) bid: string, @Query() q: unknown) {
    return this.svc.listStudents(u, bid, StudentListQuery.parse(q));
  }

  @Post("batches/:id/students") @HttpCode(200) @RequirePermission("lms:manage")
  addStudents(@CurrentUser() u: AuthedUser, @Param("id", id()) bid: string, @Body() b: unknown) {
    return this.svc.addStudents(u, bid, StudentsAdd.parse(b).userIds);
  }

  @Delete("batches/:id/students/:userId") @HttpCode(204) @RequirePermission("lms:manage")
  async removeStudent(@CurrentUser() u: AuthedUser, @Param("id", id()) bid: string, @Param("userId", id()) uid: string) {
    await this.svc.removeStudent(u, bid, uid);
  }

  @Put("batches/:id/students/:userId/progress/:moduleId") @RequirePermission("lms:manage")
  staffProgress(
    @CurrentUser() u: AuthedUser, @Param("id", id()) bid: string, @Param("userId", id()) uid: string,
    @Param("moduleId", id()) mid: string, @Body() b: unknown,
  ) { return this.svc.staffSetProgress(u, bid, uid, mid, ProgressPut.parse(b).percent); }

  @Get("students/lookup") @RequirePermission("lms:manage")
  lookup(@CurrentUser() u: AuthedUser, @Query() q: unknown) { return this.svc.lookupStudents(u, StudentLookupQuery.parse(q).q); }

  // ---- learner (own rows only)
  @Get("me/trainings") @RequirePermission("lms:learn")
  myTrainings(@CurrentUser() u: AuthedUser) { return this.svc.myTrainings(u); }

  @Get("me/trainings/:batchId") @RequirePermission("lms:learn")
  myTraining(@CurrentUser() u: AuthedUser, @Param("batchId", id()) bid: string) { return this.svc.myTraining(u, bid); }

  @Put("me/trainings/:batchId/progress/:moduleId") @RequirePermission("lms:learn")
  myProgress(@CurrentUser() u: AuthedUser, @Param("batchId", id()) bid: string, @Param("moduleId", id()) mid: string, @Body() b: unknown) {
    return this.svc.mySetProgress(u, bid, mid, ProgressPut.parse(b).percent);
  }
}
