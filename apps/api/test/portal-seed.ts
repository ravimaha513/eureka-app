import type { NestFastifyApplication } from "@nestjs/platform-fastify";

/** Test helpers for the applicant portal (jobs-portal): sign up and sign in through the dev mailbox. */
let ip = 1;
export interface PortalSession { cookie: string; csrf: string; id: string }

export async function portalSignIn(app: NestFastifyApplication, email: string, first = "Rakesh", last = "Uvsn"): Promise<PortalSession> {
  const remoteAddress = `10.77.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`;
  const h = { "x-eureka-portal": "1" };
  const s = await app.inject({ method: "POST", url: "/api/portal/auth/sign-up", headers: h, remoteAddress,
    payload: { firstName: first, lastName: last, email, phone: "+1 212 555 0123" } });
  if (s.statusCode !== 202) throw new Error(`sign-up ${s.statusCode} ${s.body}`);
  const items = (await app.inject({ method: "GET", url: `/api/portal/dev/mailbox?to=${encodeURIComponent(email)}` })).json().items as { text: string }[];
  const token = /#token=([^\s]+)/.exec(items[0]!.text)![1]!;
  const v = await app.inject({ method: "POST", url: "/api/portal/auth/verify", headers: h, payload: { token }, remoteAddress });
  if (v.statusCode !== 204) throw new Error(`verify ${v.statusCode} ${v.body}`);
  const cookie = String(v.headers["set-cookie"]).split(";")[0]!;
  const me = (await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken as string, id: me.id as string };
}

export function portalCall(app: NestFastifyApplication, s: PortalSession, method: "GET" | "POST", url: string, payload?: unknown): ReturnType<NestFastifyApplication["inject"]> {
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}

export async function mailboxOf(app: NestFastifyApplication, to: string): Promise<{ subject: string; text: string }[]> {
  return (await app.inject({ method: "GET", url: `/api/portal/dev/mailbox?to=${encodeURIComponent(to)}` })).json().items;
}
