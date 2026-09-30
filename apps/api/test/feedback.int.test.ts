import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, asUser, type TestDb } from "./db-harness.js";
import { seedFixtures } from "./fixtures.js";
import { seedPipeline, type PipelineSeed } from "./pipeline-seed.js";
import { feedbackEmailJob, feedbackNotificationJob } from "../src/worker/jobs/feedback-email.js";
import { JobRunner } from "../src/worker/runner.js";
import type { Mail } from "../src/worker/feedback-mail.js";

let db: TestDb; let app: NestFastifyApplication; let seed: PipelineSeed;
const sent: Mail[] = [];
const log = { log() {}, info() {}, warn() {}, error() {} };
const mail = { async send(m: Mail) { sent.push(m); } };
const job = feedbackEmailJob(mail, "https://eureka.example", "11".repeat(32));
const ctx = () => ({ pool: db.worker, log, signal: new AbortController().signal, heartbeat() {} });
beforeAll(async () => {
 db=await createTestDb(); seed=await seedPipeline(db,await seedFixtures(db.admin));
 await db.admin.query("UPDATE eureka.person SET personal_email='candidate@example.test'");
 const url=new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
 app=await createApp(loadConfig({NODE_ENV:"test",AUTH_MODE:"dev",SESSION_SECRET:"test-secret-test-secret-test-secret-123",DATABASE_URL:`postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`}));
},120_000);
afterAll(async()=>{await app?.close();await db?.drop();});
async function schedule(index:number,minutesAgo:number) {
 const i=seed.interviews[index]!;
 await asUser(db.app,i.recruiterId, c=>c.query("UPDATE eureka.interview SET starts_at=now()-($2+30)*interval '1 minute',ends_at=now()-$2*interval '1 minute' WHERE id=$1",[i.id,minutesAgo]),true);
 return i;
}
async function delivery(index:number) {
 await schedule(index,120+index*120);
 const keys=await job.dueKeys(new Date(),ctx());
 const id=keys[keys.length-1]!;
 await job.run(id,ctx());
 const token=sent.at(-1)!.text.match(/feedback\/([\w-]{43})/)![1]!;
 return {id,token,url:`/api/public/feedback/${token}`};
}
describe("candidate feedback",()=>{
 it("waits 60 minutes and skips cancelled interviews",async()=>{
  const i=await schedule(0,59);
  expect(await job.dueKeys(new Date(),ctx())).toEqual([]);
  await asUser(db.app,i.recruiterId,c=>c.query("UPDATE eureka.interview SET starts_at=now()-interval '3 hours',ends_at=now()-interval '2 hours',call_status='cancelled' WHERE id=$1",[i.id]),true);
  expect(await job.dueKeys(new Date(),ctx())).toEqual([]);
 });
 it("GET is repeatable, minimal; POST atomically consumes and notifies",async()=>{
  const {url}=await delivery(1);
  const a=await app.inject({method:"GET",url}); const b=await app.inject({method:"GET",url});
  expect(a.statusCode).toBe(200);expect(b.statusCode).toBe(200);
  expect(Object.keys(a.json()).sort()).toEqual(["clientName","expiresAt","firstName","startsAt"]);
  const responses=await Promise.all([1,2].map(()=>app.inject({method:"POST",url,payload:{rating:4,notes:"Helpful",format:"Video",topics:["Java"],durationMin:30,nextStep:"Await response"}})));
  expect(responses.map(r=>r.statusCode).sort()).toEqual([201,404]);
  expect((await app.inject({method:"GET",url})).statusCode).toBe(404);
  const feedback=await db.admin.query("SELECT * FROM eureka.interview_feedback WHERE kind='candidate'");
  expect(feedback.rows).toHaveLength(1);expect(feedback.rows[0].topics).toEqual(["Java"]);
  const notify=feedbackNotificationJob(mail,"https://eureka.example");
  const keys=await notify.dueKeys(new Date(),ctx());expect(keys.length).toBeGreaterThan(0);
  const runner=new JobRunner(db.worker,[notify],log);
  expect(await runner.runOnce(notify,keys[0]!)).toBe("ran");expect(await runner.runOnce(notify,keys[0]!)).toBe("done-before");
 });
 it("invalidates delivered links when interview is rescheduled",async()=>{
  const {url}=await delivery(2);const i=seed.interviews[2]!;
  await asUser(db.app,i.recruiterId,c=>c.query("UPDATE eureka.interview SET starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day' WHERE id=$1",[i.id]),true);
  expect((await app.inject({method:"GET",url})).statusCode).toBe(404);
  expect((await app.inject({method:"POST",url,payload:{rating:3}})).statusCode).toBe(404);
 });
 it("expires links and rejects invalid inputs without consuming",async()=>{
  const {id,url}=await delivery(3);
  expect((await app.inject({method:"POST",url,payload:{rating:6}})).statusCode).toBe(422);
  expect((await app.inject({method:"GET",url})).statusCode).toBe(200);
  await db.admin.query("UPDATE eureka.feedback_delivery SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);
  expect((await app.inject({method:"POST",url,payload:{rating:3}})).statusCode).toBe(404);
 });
 it("retries ambiguous transport failures with exactly the same token",async()=>{
  await schedule(4,800);
  const keys=await job.dueKeys(new Date(),ctx());const id=keys.at(-1)!;
  let first="";
  const failed=feedbackEmailJob({async send(m){first=m.text;throw new Error("ambiguous provider response");}},"https://eureka.example","11".repeat(32));
  await expect(failed.run(id,ctx())).rejects.toThrow("retry pending");
  expect((await db.admin.query("SELECT sent_at FROM eureka.feedback_delivery WHERE id=$1",[id])).rows[0].sent_at).toBeNull();
  await job.run(id,ctx());expect(sent.at(-1)!.text).toBe(first);
  const row=(await db.admin.query("SELECT * FROM eureka.feedback_delivery WHERE id=$1",[id])).rows[0];expect(row.token_cipher).toBe("");expect(row.sent_at).not.toBeNull();
 });
 it("worker and app cannot read token table or unrelated person data",async()=>{
  await expect(db.worker.query("SELECT * FROM eureka.feedback_delivery")).rejects.toThrow(/permission denied/);
  await expect(db.app.query("SELECT * FROM eureka.feedback_delivery")).rejects.toThrow(/permission denied/);
  await expect(db.worker.query("SELECT phone_e164 FROM eureka.person")).rejects.toThrow(/permission denied/);
  await expect(db.app.query("SELECT * FROM eureka.feedback_due()")).rejects.toThrow(/permission denied/);
 });
 it("limits invalid token guessing",async()=>{
  const replies=[];for(let n=0;n<35;n++)replies.push(await app.inject({method:"GET",url:"/api/public/feedback/invalid",remoteAddress:"198.51.100.4"}));
  expect(replies.at(-1)!.statusCode).toBe(429);
 });
});
