import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";
import { deliverInbox } from "./notification-seed.js";

/**
 * Database-only checks for migration 0070 (internal chat; docs/chat-api.md):
 * RLS alone limits every chat table to current members (CH-2), writes only
 * through the authz.chat_* functions (CH-3 to CH-6), the 10-minute direct
 * message notification through the registry (CH-8), no admin or worker read
 * access (CH-9) and audit rows with ids and counts only (CH-10).
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

type Q = <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
/** Runs fn as the app role for `user`, committed. */
const as = <T>(user: string, fn: (q: Q) => Promise<T>) =>
  asUser(db.app, user, (c) => fn(async (sql, params = []) => (await c.query(sql, params)).rows as never), true);
const one = async <T extends pg.QueryResultRow>(user: string, sql: string, params: unknown[] = []) =>
  (await as(user, (q) => q<T>(sql, params)))[0]!;

const direct = (a: string, b: string) => one<{ conversation_id: string; created: boolean }>(a, `SELECT * FROM authz.chat_open_direct($1)`, [b]);
const group = (owner: string, name: string, members: string[]) =>
  one<{ id: string }>(owner, `SELECT authz.chat_create_group($1, $2::uuid[]) AS id`, [name, members]).then((r) => r.id);
const send = (user: string, conv: string, body: string, files: unknown[] = [], clientId = randomUUID()) =>
  one<{ message_id: string; created: boolean }>(user, `SELECT * FROM authz.chat_send($1, $2, $3, $4::jsonb)`,
    [conv, clientId, body, JSON.stringify(files)]);
const count = async (user: string, table: string, where = "true", params: unknown[] = []) =>
  (await one<{ n: number }>(user, `SELECT count(*)::int AS n FROM eureka.${table} WHERE ${where}`, params)).n;

/** As authz_definer (the guard's only writer): moves a member's view time back, for the 10-minute rule. */
async function viewedAgo(conv: string, user: string, minutes: number | null) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authz_definer");
    // The earlier notification (if any) moves back with it: it happened before that view.
    await c.query(`UPDATE eureka.chat_member_state SET last_viewed_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(mins => $3::int) END,
                    notified_at = CASE WHEN notified_at IS NULL OR $3::int IS NULL THEN notified_at ELSE now() - make_interval(mins => $3::int + 5) END
                    WHERE conversation_id = $1 AND user_id = $2`, [conv, user, minutes]);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}
const chatEvents = async (conv: string) => (await db.admin.query<{ id: string; payload: Record<string, unknown> }>(
  `SELECT id, payload FROM eureka.outbox_event WHERE type = 'chat.direct_message' AND aggregate_id = $1 ORDER BY created_at`, [conv])).rows;

describe("direct and group conversations (CH-3)", () => {
  it("one direct conversation per pair, from either side; not with oneself or an inactive user", async () => {
    const a = await direct(U.r1a, U.hr);
    expect(a.created).toBe(true);
    const b = await direct(U.hr, U.r1a);
    expect(b).toEqual({ conversation_id: a.conversation_id, created: false });
    await expect(direct(U.r1a, U.r1a)).rejects.toThrow(/invalid_member/);
    const ghost = (await db.admin.query<{ id: string }>(
      `INSERT INTO eureka.app_user (email, display_name, status) VALUES ('ghost@eureka.example', 'Ghost', 'inactive') RETURNING id`)).rows[0]!.id;
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'recruiter')`, [ghost]);
    await expect(direct(U.r1a, ghost)).rejects.toThrow(/invalid_member/);
    // A user without any role (so without chat:use) can neither chat nor be chatted with.
    const norole = (await db.admin.query<{ id: string }>(
      `INSERT INTO eureka.app_user (email, display_name) VALUES ('norole@eureka.example', 'No Role') RETURNING id`)).rows[0]!.id;
    await expect(direct(U.r1a, norole)).rejects.toThrow(/invalid_member/);
    await expect(direct(norole, U.r1a)).rejects.toThrow(/not_permitted/);
    expect(await one<{ ids: string[] }>(norole, `SELECT authz.chat_conversation_ids() AS ids`)).toEqual({ ids: [] });
  });

  it("validates group names and members", async () => {
    await expect(group(U.l1, "", [U.r1a])).rejects.toThrow(/invalid_name/);
    await expect(group(U.l1, " padded ", [U.r1a])).rejects.toThrow(/invalid_name/);
    await expect(group(U.l1, "x".repeat(81), [U.r1a])).rejects.toThrow(/invalid_name/);
    await expect(group(U.l1, "tab\there", [U.r1a])).rejects.toThrow(/invalid_name/);
    await expect(group(U.l1, "Only me", [U.l1])).rejects.toThrow(/invalid_member/);
    await expect(group(U.l1, "Unknown", [randomUUID()])).rejects.toThrow(/invalid_member/);
    const g = await group(U.l1, "Team Rohit desk", [U.r1a, U.r1b, U.r1a]);
    const members = await as(U.l1, (q) => q<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM eureka.chat_member WHERE conversation_id = $1 ORDER BY role DESC, user_id`, [g]));
    expect(members).toEqual([{ user_id: U.l1, role: "owner" }, ...[U.r1a, U.r1b].sort().map((u) => ({ user_id: u, role: "member" }))]);
  });

  it("owners add, remove and promote; members cannot; the group keeps an owner", async () => {
    const g = await group(U.m1, "Managers", [U.l1]);
    await expect(as(U.l1, (q) => q(`SELECT authz.chat_add_members($1, $2::uuid[])`, [g, [U.l2]]))).rejects.toThrow(/not_permitted/);
    await expect(as(U.l1, (q) => q(`SELECT authz.chat_remove_member($1, $2)`, [g, U.m1]))).rejects.toThrow(/not_permitted/);
    await expect(as(U.l1, (q) => q(`SELECT authz.chat_rename($1, 'X', 1)`, [g]))).rejects.toThrow(/not_permitted/);
    await expect(as(U.l1, (q) => q(`SELECT authz.chat_delete_group($1)`, [g]))).rejects.toThrow(/not_permitted/);
    expect(await one(U.m1, `SELECT authz.chat_add_members($1, $2::uuid[]) AS n`, [g, [U.l2, U.l1]])).toEqual({ n: 1 });
    await expect(as(U.m1, (q) => q(`SELECT authz.chat_set_member_role($1, $2, 'member')`, [g, U.m1]))).rejects.toThrow(/last_owner/);
    await as(U.m1, (q) => q(`SELECT authz.chat_set_member_role($1, $2, 'owner')`, [g, U.l2]));
    await as(U.m1, (q) => q(`SELECT authz.chat_set_member_role($1, $2, 'member')`, [g, U.m1]));
    await expect(as(U.l2, (q) => q(`SELECT authz.chat_remove_member($1, $2)`, [g, U.l2]))).rejects.toThrow(/use_leave/);
    await as(U.l2, (q) => q(`SELECT authz.chat_remove_member($1, $2)`, [g, U.l1]));
    expect(await count(U.l1, "chat_conversation", "id = $1", [g])).toBe(0);
    // Rename with the row version the client saw.
    const v = (await one<{ row_version: number }>(U.l2, `SELECT row_version FROM eureka.chat_conversation WHERE id = $1`, [g])).row_version;
    await expect(as(U.l2, (q) => q(`SELECT authz.chat_rename($1, 'Leads and managers', $2)`, [g, v - 1]))).rejects.toThrow(/stale/);
    expect(await one(U.l2, `SELECT authz.chat_rename($1, 'Leads and managers', $2) AS v`, [g, v])).toEqual({ v: v + 1 });
    // Direct chats have no owners and no member management.
    const d = (await direct(U.m1, U.l2)).conversation_id;
    await expect(as(U.m1, (q) => q(`SELECT authz.chat_add_members($1, $2::uuid[])`, [d, [U.l1]]))).rejects.toThrow(/not_group/);
    await expect(as(U.m1, (q) => q(`SELECT authz.chat_leave($1)`, [d]))).rejects.toThrow(/not_group/);
  });

  it("leaving: the longest-standing member inherits ownership; the last one out deletes the group", async () => {
    const g = await group(U.ad, "Leaving", [U.m1, U.m2]);
    await as(U.ad, (q) => q(`SELECT authz.chat_leave($1)`, [g]));
    const roles = await as(U.m1, (q) => q<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM eureka.chat_member WHERE conversation_id = $1 AND left_at IS NULL ORDER BY user_id`, [g]));
    expect(roles.filter((r) => r.role === "owner")).toHaveLength(1);
    expect(await count(U.ad, "chat_conversation", "id = $1", [g])).toBe(0);
    await as(U.m1, (q) => q(`SELECT authz.chat_leave($1)`, [g]));
    await as(U.m2, (q) => q(`SELECT authz.chat_leave($1)`, [g]));
    expect((await db.admin.query(`SELECT deleted_at FROM eureka.chat_conversation WHERE id = $1`, [g])).rows[0].deleted_at).not.toBeNull();
  });
});

describe("RLS: current members only (CH-2, CH-9)", () => {
  it("a non-member, an org admin and a left member read nothing; members read only their own state", async () => {
    const g = await group(U.hr, "HR desk", [U.acct, U.imm]);
    const m = await send(U.hr, g, "Fictional note for the desk", [{ name: "memo.pdf", contentType: "application/pdf", size: 100 }]);
    const file = (await db.admin.query<{ file_id: string }>(`SELECT file_id FROM eureka.chat_attachment WHERE message_id = $1`, [m.message_id])).rows[0]!.file_id;
    for (const outsider of [U.r1a, U.admin, U.ceo]) {
      expect(await count(outsider, "chat_conversation", "id = $1", [g]), outsider).toBe(0);
      expect(await count(outsider, "chat_member", "conversation_id = $1", [g])).toBe(0);
      expect(await count(outsider, "chat_member_state", "conversation_id = $1", [g])).toBe(0);
      expect(await count(outsider, "chat_message", "conversation_id = $1", [g])).toBe(0);
      expect(await count(outsider, "chat_attachment", "conversation_id = $1", [g])).toBe(0);
      expect(await count(outsider, "file_object", "id = $1", [file])).toBe(0);
      await expect(as(outsider, (q) => q(`SELECT authz.chat_mark_read($1, NULL)`, [g]))).rejects.toThrow(/not_found/);
      await expect(send(outsider, g, "intrusion")).rejects.toThrow(/not_found/);
    }
    expect(await count(U.acct, "chat_message", "conversation_id = $1", [g])).toBe(1);
    expect(await count(U.acct, "chat_attachment", "conversation_id = $1", [g])).toBe(1);
    expect(await count(U.acct, "file_object", "id = $1", [file])).toBe(1);
    expect(await count(U.acct, "chat_member", "conversation_id = $1", [g])).toBe(3);
    expect(await as(U.acct, (q) => q(`SELECT user_id FROM eureka.chat_member_state WHERE conversation_id = $1`, [g])))
      .toEqual([{ user_id: U.acct }]);
    // Leaving ends access, history included.
    await as(U.imm, (q) => q(`SELECT authz.chat_leave($1)`, [g]));
    expect(await count(U.imm, "chat_message", "conversation_id = $1", [g])).toBe(0);
    expect(await count(U.imm, "file_object", "id = $1", [file])).toBe(0);
    // A deleted group is gone for everyone.
    await as(U.hr, (q) => q(`SELECT authz.chat_delete_group($1)`, [g]));
    expect(await count(U.hr, "chat_message", "conversation_id = $1", [g])).toBe(0);
    expect(await count(U.acct, "chat_conversation", "id = $1", [g])).toBe(0);
  });

  it("a member added later sees only messages from then on; a deleted direct chat hides its history for that side only", async () => {
    const g = await group(U.l2, "History", [U.r2a]);
    await send(U.l2, g, "before");
    await as(U.l2, (q) => q(`SELECT authz.chat_add_members($1, $2::uuid[])`, [g, [U.coach]]));
    await send(U.l2, g, "after");
    expect(await as(U.coach, (q) => q(`SELECT body FROM eureka.chat_message WHERE conversation_id = $1 ORDER BY seq`, [g])))
      .toEqual([{ body: "after" }]);
    expect(await count(U.r2a, "chat_message", "conversation_id = $1", [g])).toBe(2);

    const d = (await direct(U.r2a, U.coach)).conversation_id;
    await send(U.r2a, d, "one");
    await as(U.coach, (q) => q(`SELECT authz.chat_hide($1)`, [d]));
    expect(await one(U.coach, `SELECT hidden FROM eureka.chat_member_state WHERE conversation_id = $1`, [d])).toEqual({ hidden: true });
    expect(await count(U.coach, "chat_message", "conversation_id = $1", [d])).toBe(0);
    expect(await count(U.r2a, "chat_message", "conversation_id = $1", [d])).toBe(1);
    await send(U.r2a, d, "two");
    expect(await one(U.coach, `SELECT hidden FROM eureka.chat_member_state WHERE conversation_id = $1`, [d])).toEqual({ hidden: false });
    expect(await as(U.coach, (q) => q(`SELECT body FROM eureka.chat_message WHERE conversation_id = $1`, [d]))).toEqual([{ body: "two" }]);
    await expect(as(U.l2, (q) => q(`SELECT authz.chat_hide($1)`, [g]))).rejects.toThrow(/not_direct/);
  });

  it("the worker has no access to chat tables", async () => {
    for (const t of ["chat_conversation", "chat_member", "chat_member_state", "chat_message", "chat_attachment"]) {
      await expect(db.worker.query(`SELECT 1 FROM eureka.${t} LIMIT 1`), t).rejects.toThrow(/permission denied/);
    }
  });

  it("the conversation set is computed once per statement (InitPlan), not per row", async () => {
    const g = await group(U.r3a, "Plan", [U.l3]);
    for (let i = 0; i < 5; i++) await send(U.r3a, g, `m${i}`);
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL track_functions = 'all'");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.r3a]);
      const calls = async () => Number((await c.query<{ n: string | null }>(
        `SELECT pg_stat_get_xact_function_calls('authz.chat_conversation_ids()'::regprocedure) AS n`)).rows[0]!.n ?? 0);
      const before = await calls();
      await c.query("SET LOCAL ROLE eureka_app");
      const rows = (await c.query(`SELECT id FROM eureka.chat_message WHERE conversation_id = $1`, [g])).rowCount;
      await c.query("RESET ROLE");
      expect(rows).toBe(5);
      // Once for the message policy and once for the state policy inside its key probe: a constant, never per row.
      expect((await calls()) - before).toBeLessThanOrEqual(2);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

describe("writes only through the chat functions (rules 4 and 6)", () => {
  it("the app cannot write chat tables directly; nobody deletes or truncates", async () => {
    const d = (await direct(U.r1b, U.l1)).conversation_id;
    const m = await send(U.r1b, d, "hello");
    await expect(as(U.r1b, (q) => q(`UPDATE eureka.chat_message SET body = 'forged' WHERE id = $1`, [m.message_id]))).rejects.toThrow(/permission denied/);
    await expect(as(U.r1b, (q) => q(`INSERT INTO eureka.chat_member (conversation_id, user_id, role) VALUES ($1, $2, 'owner')`, [d, U.admin])))
      .rejects.toThrow(/permission denied/);
    await expect(as(U.r1b, (q) => q(`UPDATE eureka.chat_member_state SET visible_after_seq = 0 WHERE conversation_id = $1`, [d])))
      .rejects.toThrow(/permission denied/);
    await expect(db.admin.query(`DELETE FROM eureka.chat_message WHERE id = $1`, [m.message_id])).rejects.toThrow(/written only by chat functions/);
    await expect(db.admin.query(`UPDATE eureka.chat_message SET body = 'x' WHERE id = $1`, [m.message_id])).rejects.toThrow(/written only by chat functions/);
    await expect(db.admin.query(`TRUNCATE eureka.chat_attachment`)).rejects.toThrow(/never truncated/);
  });

  it("only the sender edits or deletes a message; a deleted message is cleared and final", async () => {
    const g = await group(U.r1a, "Edits", [U.r1b]);
    const m = await send(U.r1a, g, "first draft", [{ name: "cv.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 5 }]);
    const rev0 = Number((await db.admin.query(`SELECT rev FROM eureka.chat_message WHERE id = $1`, [m.message_id])).rows[0].rev);
    await expect(as(U.r1b, (q) => q(`SELECT authz.chat_edit_message($1, 'hijack')`, [m.message_id]))).rejects.toThrow(/not_permitted/);
    await expect(as(U.r1b, (q) => q(`SELECT authz.chat_delete_message($1)`, [m.message_id]))).rejects.toThrow(/not_permitted/);
    await expect(as(U.l2, (q) => q(`SELECT authz.chat_edit_message($1, 'x')`, [m.message_id]))).rejects.toThrow(/not_found/);
    await as(U.r1a, (q) => q(`SELECT authz.chat_edit_message($1, 'final text')`, [m.message_id]));
    const edited = (await db.admin.query(`SELECT body, edited_at, rev FROM eureka.chat_message WHERE id = $1`, [m.message_id])).rows[0];
    expect(edited.body).toBe("final text");
    expect(edited.edited_at).not.toBeNull();
    expect(Number(edited.rev)).toBeGreaterThan(rev0);
    // An attachment-only message may have an empty body.
    await as(U.r1a, (q) => q(`SELECT authz.chat_edit_message($1, '')`, [m.message_id]));
    await as(U.r1a, (q) => q(`SELECT authz.chat_delete_message($1)`, [m.message_id]));
    await as(U.r1a, (q) => q(`SELECT authz.chat_delete_message($1)`, [m.message_id])); // idempotent
    const gone = (await db.admin.query(`SELECT body, deleted_at FROM eureka.chat_message WHERE id = $1`, [m.message_id])).rows[0];
    expect(gone.body).toBe("");
    expect(gone.deleted_at).not.toBeNull();
    expect(await count(U.r1b, "chat_attachment", "message_id = $1", [m.message_id])).toBe(0);
    await expect(as(U.r1a, (q) => q(`SELECT authz.chat_edit_message($1, 'again')`, [m.message_id]))).rejects.toThrow(/message_deleted/);
    expect((await db.admin.query(`SELECT count(*)::int n FROM eureka.audit_event WHERE action = 'chat.message_deleted' AND changes->>'messageId' = $1`,
      [m.message_id])).rows[0].n).toBe(1);
  });

  it("validates bodies and attachments; sends are idempotent per client id", async () => {
    const d = (await direct(U.l3, U.r3a)).conversation_id;
    await expect(send(U.l3, d, "  \n ")).rejects.toThrow(/invalid_message/);
    await expect(send(U.l3, d, "x".repeat(4001))).rejects.toThrow(/invalid_message/);
    await expect(send(U.l3, d, "bell \u0007")).rejects.toThrow(/check constraint|violates/);
    const pdf = { name: "a.pdf", contentType: "application/pdf", size: 10 };
    await expect(send(U.l3, d, "", [{ ...pdf, contentType: "text/html" }])).rejects.toThrow(/invalid_attachment/);
    await expect(send(U.l3, d, "", [{ ...pdf, size: 15728641 }])).rejects.toThrow(/invalid_attachment/);
    await expect(send(U.l3, d, "", [{ ...pdf, name: "../x.pdf" }])).rejects.toThrow(/invalid_attachment/);
    await expect(send(U.l3, d, "", Array(6).fill(pdf))).rejects.toThrow(/invalid_message/);
    const client = randomUUID();
    const a = await send(U.l3, d, "once", [], client);
    expect(a.created).toBe(true);
    expect(await send(U.l3, d, "once", [], client)).toEqual({ message_id: a.message_id, created: false });
    const other = (await direct(U.l3, U.m2)).conversation_id;
    await expect(send(U.l3, other, "once", [], client)).rejects.toThrow(/idempotency_conflict/);
    // At most 10 pending chat uploads per user.
    await send(U.l3, d, "", Array(5).fill(pdf));
    await send(U.l3, d, "", Array(5).fill(pdf));
    await expect(send(U.l3, d, "", [pdf])).rejects.toThrow(/too_many_pending/);
  });

  it("read marks never move backwards; unread counts others' messages only", async () => {
    const d = (await direct(U.locD, U.locA)).conversation_id;
    const m1 = await send(U.locD, d, "one");
    await send(U.locD, d, "two");
    const unread = async () => (await one<{ n: number }>(U.locA, `SELECT count(*)::int AS n FROM eureka.chat_message m
      JOIN eureka.chat_member_state s ON s.conversation_id = m.conversation_id AND s.user_id = $2
      WHERE m.conversation_id = $1 AND m.seq > s.last_read_seq AND m.sender_id <> $2`, [d, U.locA])).n;
    expect(await unread()).toBe(2);
    await as(U.locA, (q) => q(`SELECT authz.chat_mark_read($1, NULL)`, [d]));
    expect(await unread()).toBe(0);
    await as(U.locA, (q) => q(`SELECT authz.chat_mark_read($1, $2)`, [d, m1.message_id]));
    expect(await unread()).toBe(0);
    const sender = await one<{ last_read_seq: string }>(U.locD, `SELECT last_read_seq FROM eureka.chat_member_state WHERE conversation_id = $1`, [d]);
    expect(Number(sender.last_read_seq)).toBeGreaterThan(0);
  });
});

describe("direct message notification (CH-8)", () => {
  it("notifies once per unseen stretch after 10 minutes without a view; never when muted or in groups", async () => {
    const d = (await direct(U.m2, U.l3)).conversation_id;
    await send(U.m2, d, "first");
    expect(await chatEvents(d)).toHaveLength(1); // never viewed
    await send(U.m2, d, "second");
    expect(await chatEvents(d)).toHaveLength(1); // same unseen stretch
    await as(U.l3, (q) => q(`SELECT authz.chat_mark_read($1, NULL)`, [d]));
    await send(U.m2, d, "third");
    expect(await chatEvents(d)).toHaveLength(1); // viewed less than 10 minutes ago
    await viewedAgo(d, U.l3, 11);
    await send(U.m2, d, "fourth");
    const events = await chatEvents(d);
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toEqual({ conversationId: d, recipientId: U.l3 });
    // The registry names exactly the recipient; the inbox row opens the conversation and names nobody.
    await deliverInbox(db, events[1]!.id);
    const inbox = (await db.admin.query(`SELECT recipient_id, entity_type, entity_id, title, body FROM eureka.notification WHERE event_id = $1`,
      [events[1]!.id])).rows;
    expect(inbox).toEqual([{ recipient_id: U.l3, entity_type: "conversation", entity_id: d,
      title: "New direct message", body: "You have a new direct message. Open Chat to read it." }]);
    // Muted: no event.
    await as(U.l3, (q) => q(`SELECT * FROM authz.chat_set_prefs($1, NULL, NULL, true)`, [d]));
    await viewedAgo(d, U.l3, 30);
    await send(U.m2, d, "fifth");
    expect(await chatEvents(d)).toHaveLength(2);
    // Groups never notify.
    const g = await group(U.m2, "No pings", [U.l3]);
    await send(U.m2, g, "group message");
    expect(await chatEvents(g)).toHaveLength(0);
  });
});

describe("audit has ids and counts only (CH-10, rule 5)", () => {
  it("no message text, conversation or file names, or display names in chat audit rows", async () => {
    const secret = "Zanzibar-Quokka-4471";
    const g = await group(U.acct, `${secret} group`, [U.hr]);
    const m = await send(U.acct, g, `${secret} body`, [{ name: `${secret}.pdf`, contentType: "application/pdf", size: 9 }]);
    await as(U.acct, (q) => q(`SELECT authz.chat_rename($1, $2, 1)`, [g, `${secret} renamed`]));
    await as(U.acct, (q) => q(`SELECT authz.chat_add_members($1, $2::uuid[])`, [g, [U.imm]]));
    await as(U.acct, (q) => q(`SELECT authz.chat_remove_member($1, $2)`, [g, U.imm]));
    await as(U.acct, (q) => q(`SELECT authz.chat_delete_message($1)`, [m.message_id]));
    await as(U.hr, (q) => q(`SELECT authz.chat_leave($1)`, [g]));
    await as(U.acct, (q) => q(`SELECT authz.chat_delete_group($1)`, [g]));
    const rows = (await db.admin.query<{ action: string; entity_type: string; changes: Record<string, unknown> }>(
      `SELECT action, entity_type, changes FROM eureka.audit_event WHERE entity_id = $1 ORDER BY seq`, [g])).rows;
    expect(rows.map((r) => r.action)).toEqual(["chat.conversation_created", "chat.conversation_renamed", "chat.member_added",
      "chat.member_removed", "chat.message_deleted", "chat.member_left", "chat.conversation_deleted"]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"(acct|hr|imm)"/); // fixture display names
    const allowed = new Set(["kind", "memberCount", "userId", "role", "rowVersion", "messageId", "attachmentCount", "remainingMembers", "ownerPromoted"]);
    for (const r of rows) {
      expect(r.entity_type).toBe("chat_conversation");
      for (const k of Object.keys(r.changes)) expect(allowed.has(k), k).toBe(true);
    }
    // The outbox payloads of chat events carry ids only.
    const payloads = (await db.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM eureka.outbox_event WHERE type = 'chat.direct_message'`)).rows;
    for (const p of payloads) expect(Object.keys(p.payload).sort()).toEqual(["conversationId", "recipientId"]);
  });
});

describe("database limits (CH-12) and presence scope (CH-7)", () => {
  it("refuses groups, members added, sends, edits and deletes above the caps", async () => {
    for (let i = 0; i < 20; i++) await group(U.coach, `Cap ${i}`, [U.locD]);
    await expect(group(U.coach, "Cap 20", [U.locD])).rejects.toThrow(/rate_limited/);

    // Members added: 200 per hour (add and remove the same person repeatedly).
    const g = await group(U.ceo, "Churn", [U.om]);
    for (let i = 0; i < 200; i++) {
      await as(U.ceo, (q) => q(`SELECT authz.chat_add_members($1, $2::uuid[])`, [g, [U.ad]]));
      await as(U.ceo, (q) => q(`SELECT authz.chat_remove_member($1, $2)`, [g, U.ad]));
    }
    await expect(as(U.ceo, (q) => q(`SELECT authz.chat_add_members($1, $2::uuid[])`, [g, [U.ad]]))).rejects.toThrow(/rate_limited/);

    // Edits 30/minute, deletes 60/minute, sends 120/minute.
    const d = (await direct(U.locA, U.imm)).conversation_id;
    const ids: string[] = [];
    for (let i = 0; i < 61; i++) ids.push((await send(U.locA, d, `m${i}`)).message_id);
    for (let i = 0; i < 30; i++) await as(U.locA, (q) => q(`SELECT authz.chat_edit_message($1, 'e')`, [ids[i]]));
    await expect(as(U.locA, (q) => q(`SELECT authz.chat_edit_message($1, 'e')`, [ids[30]]))).rejects.toThrow(/rate_limited/);
    for (let i = 0; i < 60; i++) await as(U.locA, (q) => q(`SELECT authz.chat_delete_message($1)`, [ids[i]]));
    await expect(as(U.locA, (q) => q(`SELECT authz.chat_delete_message($1)`, [ids[60]]))).rejects.toThrow(/rate_limited/);
    for (let i = 0; i < 59; i++) await send(U.locA, d, `x${i}`);
    await expect(send(U.locA, d, "one too many")).rejects.toThrow(/rate_limited/);
  }, 120_000);

  it("a concurrent duplicate client id returns the first message", async () => {
    const d = (await direct(U.m1, U.coach)).conversation_id;
    const client = randomUUID();
    const rs = await Promise.all([1, 2, 3, 4].map(() => send(U.m1, d, "dup", [], client)));
    expect(new Set(rs.map((r) => r.message_id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
  });

  it("chat_online: only people sharing a current conversation, only live sessions; not callable by the worker", async () => {
    const ses = async (user: string, ageMinutes: number) => db.admin.query(
      `INSERT INTO eureka.session (id_hash, user_id, expires_at, auth_time, access_version, last_seen_at)
       VALUES (sha256(gen_random_uuid()::text::bytea), $1, now() + interval '1 hour', now(), 1, now() - make_interval(mins => $2))`, [user, ageMinutes]);
    await ses(U.imm, 0);
    await ses(U.r2a, 5);
    await ses(U.m2, 0);
    const g = await group(U.imm, "Presence db", [U.r2a]);
    const online = (u: string, who: string[]) => one<{ ids: string[] }>(u, `SELECT authz.chat_online($1::uuid[]) AS ids`, [who]).then((r) => r.ids);
    expect(await online(U.imm, [U.r2a, U.m2, U.imm])).toEqual([U.imm]); // r2a's session is stale (5 min); m2 shares nothing
    expect(await online(U.r2a, [U.imm, U.m2])).toEqual([U.imm]);
    await as(U.imm, (q) => q(`SELECT authz.chat_leave($1)`, [g]));
    expect(await online(U.r2a, [U.imm])).toEqual([]); // no shared conversation any more
    await expect(db.worker.query(`SELECT authz.chat_online('{}'::uuid[])`)).rejects.toThrow(/permission denied/);
  });

  it("deactivated users: not chat users; reactivation moves their visibility to now; ownerless groups can be claimed", async () => {
    const g = await group(U.l1, "Dormant db", [U.r1a, U.r1b]);
    await send(U.l1, g, "old");
    await db.admin.query(`UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1`, [U.l1]);
    await expect(direct(U.r1a, U.l1)).rejects.toThrow(/invalid_member/);
    await expect(as(U.r1b, (q) => q(`SELECT authz.chat_set_member_role($1, $2, 'owner')`, [g, U.r1b]))).resolves.toBeDefined(); // ownerless: claim
    await expect(as(U.r1a, (q) => q(`SELECT authz.chat_set_member_role($1, $2, 'owner')`, [g, U.r1a]))).rejects.toThrow(/not_permitted/);
    await send(U.r1a, g, "meanwhile");
    await db.admin.query(`UPDATE eureka.app_user SET status = 'active' WHERE id = $1`, [U.l1]);
    expect(await as(U.l1, (q) => q(`SELECT body FROM eureka.chat_message WHERE conversation_id = $1`, [g]))).toEqual([]);
    await send(U.r1a, g, "after");
    expect(await as(U.l1, (q) => q(`SELECT body FROM eureka.chat_message WHERE conversation_id = $1`, [g]))).toEqual([{ body: "after" }]);
  });
});
