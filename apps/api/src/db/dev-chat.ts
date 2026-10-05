/**
 * Local development only: a few fictional chats between the dev users, so the
 * Chat screen has something to show. Written as the acting user through the
 * app role and the authz.chat_* functions (RLS, guards and audit apply).
 * Fills in fictional designations for dev users that have none. Idempotent:
 * does nothing when a conversation already exists.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const U = { m1: uid(4), l1: uid(6), r1a: uid(9), r1b: uid(10), hr: uid(16), admin: uid(18) };
const DESIGNATIONS: [string, string][] = [
  [U.m1, "Sales Manager"], [U.l1, "Team Lead"], [U.r1a, "Senior Recruiter"], [U.r1b, "Recruiter"], [U.hr, "HR Executive"],
  [U.admin, "Systems Administrator"],
];

async function asUser<T>(admin: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE eureka_app");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

const send = (admin: pg.Pool, user: string, conv: string, body: string) =>
  asUser(admin, user, (c) => c.query(`SELECT * FROM authz.chat_send($1, $2, $3, '[]'::jsonb)`, [conv, randomUUID(), body]));

export async function seedDevChat(admin: pg.Pool): Promise<{ conversations: number; messages: number }> {
  if ((await admin.query("SELECT 1 FROM eureka.chat_conversation LIMIT 1")).rowCount) return { conversations: 0, messages: 0 };
  for (const [id, d] of DESIGNATIONS) {
    await admin.query(`UPDATE eureka.app_user SET designation = $2 WHERE id = $1 AND designation IS NULL`, [id, d]);
  }
  const direct = async (a: string, b: string) => asUser(admin, a, async (c) =>
    (await c.query<{ conversation_id: string }>(`SELECT conversation_id FROM authz.chat_open_direct($1)`, [b])).rows[0]!.conversation_id);
  let messages = 0;
  const say = async (user: string, conv: string, body: string) => { await send(admin, user, conv, body); messages += 1; };

  const leadChat = await direct(U.r1a, U.l1);
  await say(U.r1a, leadChat, "Morning! The Java profile I shared yesterday has a client call at 3 pm.");
  await say(U.l1, leadChat, "Great. Please share the prep notes before noon.");
  await say(U.r1a, leadChat, "Will do. The job description is here: https://example.com/jobs/java-developer");

  const hrChat = await direct(U.hr, U.r1a);
  await say(U.hr, hrChat, "Hi, the paperwork checklist for your latest placement is ready for review.");

  const huddle = await asUser(admin, U.l1, async (c) => (await c.query<{ id: string }>(
    `SELECT authz.chat_create_group('Team Rohit huddle', $1::uuid[]) AS id`, [[U.r1a, U.r1b, U.m1]])).rows[0]!.id);
  await say(U.l1, huddle, "Weekly targets are up on the dashboard. Let's review at 5.");
  await say(U.r1b, huddle, "Thanks. I have two interviews lined up for tomorrow.");
  await say(U.m1, huddle, "Nice work, team.\nRemember to log feedback the same day.");
  return { conversations: 3, messages };
}
