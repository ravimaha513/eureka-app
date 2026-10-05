import { expect, test } from "@playwright/test";
import { apiAs, login, screen, uniq } from "./support";

/**
 * Chat journey (docs/chat-api.md, migration 0070) against the full stack with
 * the dev seed. HR writes to the recruiter over the API; the recruiter finds
 * the chat, reads the message (marked read), replies with Enter (Shift+Enter
 * adds a line), creates a group from the side panel and leaves it again.
 * HR's side checks what arrived through the API.
 */
const R1A = "00000000-0000-0000-0000-000000000009";

test("a recruiter reads and answers a direct message and runs a group chat", async ({ page, playwright, baseURL }) => {
  const hr = await apiAs(playwright, baseURL, "hr@eureka.example");
  const tag = uniq();
  const conv = await hr.send("POST", "/api/v1/chat/conversations/direct", { userId: R1A });
  await hr.send("POST", `/api/v1/chat/conversations/${conv.id}/messages`, { clientId: crypto.randomUUID(), body: `Paperwork question ${tag}` }, 201);

  await login(page, "r1a@eureka.example");
  await screen(page, "Chat");
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  const list = page.getByRole("region", { name: "Conversations" });
  await list.getByRole("searchbox", { name: "Search chats and people" }).fill("hr");
  await list.getByRole("button", { name: /^hr, (online|offline), \d+ unread/ }).click();

  const messages = page.getByRole("list", { name: "Messages with hr" });
  await expect(messages.getByText(`Paperwork question ${tag}`)).toBeVisible();
  await expect(messages.getByText(`Paperwork question ${tag}`).locator("xpath=ancestor::li[1]")).toHaveClass(/theirs/);

  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(`Answer ${tag}`);
  await box.press("Shift+Enter");
  await box.pressSequentially("second line");
  await box.press("Enter");
  await expect(messages.getByText(`Answer ${tag}`)).toBeVisible();
  await expect(box).toHaveValue("");

  // HR sees the reply (two lines) and r1a's read mark cleared the unread count of this chat.
  await expect.poll(async () => {
    const page1 = await hr.get(`/api/v1/chat/conversations/${conv.id}/messages`);
    return page1.items.at(-1)?.body;
  }).toBe(`Answer ${tag}\nsecond line`);
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const mine = (await r1a.get("/api/v1/chat/conversations?filter=all&q=hr")).items.find((c: { id: string }) => c.id === conv.id);
  expect(mine.unread).toBe(0);

  // A group from the side panel, then leave it.
  await page.getByRole("button", { name: "Create group chat" }).click();
  const panel = page.getByRole("dialog", { name: "Create Group Chat" });
  await panel.getByLabel("Group Name").fill(`Desk ${tag}`);
  await panel.getByRole("searchbox", { name: "Add Members" }).fill("hr");
  await panel.getByRole("checkbox", { name: /^hr\b/ }).check();
  await panel.getByRole("button", { name: "Create Group" }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("heading", { level: 2, name: `Desk ${tag}` })).toBeVisible();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  const members = page.getByRole("dialog", { name: `Members of Desk ${tag}` });
  await expect(members.getByRole("list", { name: "Members" }).getByText(/^hr$/)).toBeVisible();
  await members.getByRole("button", { name: "Close members" }).click();

  await page.getByRole("button", { name: "Conversation options" }).click();
  await page.getByRole("button", { name: "Leave group" }).click();
  await page.getByRole("dialog", { name: "Leave group?" }).getByRole("button", { name: "Leave group" }).click();
  await expect(page.getByText("You left the group.")).toBeVisible();
  const groups = (await hr.get("/api/v1/chat/conversations?filter=group")).items as { title: string; memberCount: number }[];
  expect(groups.find((g) => g.title === `Desk ${tag}`)?.memberCount).toBe(1);
  await hr.dispose();
  await r1a.dispose();
});
