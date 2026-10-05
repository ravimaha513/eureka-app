/**
 * Local development only: fictional companies, facilities, utilities and a
 * year of bills (docs/facilities-api.md, migration 0054), so the Companies
 * and Facilities screens have something to show. Everything is written as
 * the acting Location Ops Admin through the app role and the same definer
 * functions as the API (scope checks, guards); utility passwords are
 * encrypted with the local development keys (FIELD_LOCAL_KEY / BIDX_LOCAL_KEY
 * when set), so the API can reveal them. Idempotent: does nothing when a
 * company already exists. All names, addresses, accounts and amounts are
 * invented.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createFieldCrypto } from "../platform/crypto/config.js";

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const LOC = { dallas: "00000000-0000-0000-0000-00000000d001", austin: "00000000-0000-0000-0000-00000000a001" };
/** locD: the fixtures' Dallas Location Ops Admin; locA: Austin Location Incharge; opsA: a dev-only Austin Location Ops Admin. */
const U = { locD: uid(14), locA: uid(15), opsA: uid(31) };
/** The one stored portal password (development only). */
export const DEV_UTILITY_PASSWORD = "dev-only-password";

export interface DevFacilitiesResult { companies: number; facilities: number; utilities: number; bills: number; employees: number }

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

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** First day of the month `back` months before the current one (UTC). */
const monthStart = (back: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back); return d; };
const monthEnd = (start: Date) => { const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

interface UtilitySpec { type: string; provider: string; account?: string; url?: string; username?: string; password?: string; base: number; method: string }

export async function seedDevFacilities(admin: pg.Pool): Promise<DevFacilitiesResult> {
  const out: DevFacilitiesResult = { companies: 0, facilities: 0, utilities: 0, bills: 0, employees: 0 };
  if ((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM eureka.company")).rows[0]!.n > 0) return out;
  if (!(await admin.query("SELECT 1 FROM eureka.app_user WHERE id = $1", [U.locD])).rowCount) return out;

  // A dev-only Austin Location Ops Admin (restricted role: the seed writes it directly, as the fixtures do).
  await admin.query(`INSERT INTO eureka.app_user (id, email, display_name) VALUES ($1, 'opsA@eureka.example', 'opsA') ON CONFLICT (id) DO NOTHING`, [U.opsA]);
  if (!(await admin.query(`SELECT 1 FROM eureka.user_role WHERE user_id = $1`, [U.opsA])).rowCount) {
    await admin.query(`INSERT INTO eureka.user_role (user_id, role_key, location_id) VALUES ($1, 'location_ops_admin', $2)`, [U.opsA, LOC.austin]);
  }

  const crypto = createFieldCrypto({ NODE_ENV: "development", FIELD_LOCAL_KEY: process.env.FIELD_LOCAL_KEY, BIDX_LOCAL_KEY: process.env.BIDX_LOCAL_KEY });

  const company = (actor: string, loc: string, name: string, street: string, city: string, zip: string) =>
    asUser(admin, actor, async (c) => (await c.query<{ id: string }>(
      `SELECT authz.company_create($1, $2, $3, $4, 'TX', $5, 'USA', NULL) AS id`, [loc, name, street, city, zip])).rows[0]!.id);
  const facility = (actor: string, loc: string, name: string, street: string, city: string, zip: string, o: {
    owner: string; email: string; phone: string; rent: string; capacity: number; beds: number; baths: number; start: string;
  }) => asUser(admin, actor, async (c) => (await c.query<{ id: string }>(
    `SELECT authz.facility_create($1, $2, $3, $4, 'TX', $5, 'USA', $6, $7, $8, $9::numeric, 'monthly', $10, $11, $12::numeric, $13::date, NULL, NULL) AS id`,
    [loc, name, street, city, zip, o.owner, o.email, o.phone, o.rent, o.capacity, o.beds, o.baths, o.start])).rows[0]!.id);
  const incharge = (actor: string, kind: string, owner: string, user: string) =>
    asUser(admin, actor, (c) => c.query(`SELECT authz.incharge_add($1, $2, $3)`, [kind, owner, user]));

  async function utility(actor: string, kind: "company" | "facility", owner: string, s: UtilitySpec): Promise<string> {
    const id = randomUUID();
    await asUser(admin, actor, async (c) => {
      const sealed = s.password ? await crypto.cipher.encrypt(c, { cls: "utility_password", rowId: id }, s.password) : null;
      const mac = s.password ? await crypto.blindIndex.stretchedIntegrityMac("utility_password", id, s.password) : null;
      await c.query(`SELECT authz.utility_create($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)`,
        [id, kind, owner, s.type, s.provider, s.account ?? null, s.url ?? null, s.username ?? null, sealed?.enc ?? null, sealed?.keyId ?? null, mac]);
    });
    out.utilities++;
    return id;
  }

  /** Twelve monthly bills (this month back to 11 months ago); older ones paid; `overdue` leaves the bill of 2 months ago unpaid. */
  async function bills(actor: string, kind: "company" | "facility", owner: string, utilityId: string, s: UtilitySpec, overdue = false) {
    for (let back = 11; back >= 0; back--) {
      const start = monthStart(back);
      const due = addDays(monthEnd(start), 15);
      // Varied, seasonal-looking fictional amounts.
      const amount = (s.base * (1 + 0.25 * Math.sin(((start.getUTCMonth() + 1) / 12) * 2 * Math.PI)) + ((back * 37) % 23)).toFixed(2);
      const paid = back >= 2 && !(overdue && back === 2) ? iso(addDays(due, -5)) : null;
      await asUser(admin, actor, (c) => c.query(
        `SELECT authz.bill_create($1, $2, $3, $4, $5::numeric, $6::date, $7::date, $8::date, $9::date)`,
        [kind, owner, utilityId, s.method, amount, iso(start), iso(monthEnd(start)), iso(due), paid]));
      out.bills++;
    }
  }

  // Companies (Dallas), managed by the Dallas Location Ops Admin.
  const eit = await company(U.locD, LOC.dallas, "Eureka Info Tech", "4100 Fictional Pkwy Suite 210", "Dallas", "75201");
  const end = await company(U.locD, LOC.dallas, "Endeavour Technology", "77 Imaginary Ave", "Dallas", "75202");
  out.companies = 2;
  for (const c of [eit, end]) await incharge(U.locD, "company", c, U.locD);

  // Facilities: one per location.
  const gh2013 = await facility(U.locD, LOC.dallas, "Guest House 2013", "2013 Placeholder Ln", "Dallas", "75204",
    { owner: "Sample Landlord LLC", email: "landlord-2013@example.invalid", phone: "+1 214 555 0100", rent: "2400.00", capacity: 8, beds: 6, baths: 2.5, start: iso(monthStart(18)) });
  const gh221 = await facility(U.opsA, LOC.austin, "Guest House 221", "221 Notreal St", "Austin", "78701",
    { owner: "Example Rentals", email: "rentals-221@example.invalid", phone: "+1 512 555 0101", rent: "1850.00", capacity: 6, beds: 4, baths: 2, start: iso(monthStart(14)) });
  out.facilities = 2;
  await incharge(U.locD, "facility", gh2013, U.locD);
  await incharge(U.opsA, "facility", gh221, U.opsA);
  await incharge(U.opsA, "facility", gh221, U.locA);

  // Utilities and a year of bills.
  const specs: [string, "company" | "facility", string, UtilitySpec, boolean][] = [
    [U.locD, "company", eit, { type: "electricity", provider: "Placeholder Power Co", account: "EL-100200300", url: "https://power.example.invalid/login",
      username: "eit.dallas", password: DEV_UTILITY_PASSWORD, base: 420, method: "autopay" }, false],
    [U.locD, "company", eit, { type: "internet", provider: "Sample Fiber", account: "NET-55501", base: 129.99, method: "card" }, false],
    [U.locD, "company", end, { type: "water", provider: "Fictional Water Utility", account: "WA-7781", base: 88, method: "ach" }, false],
    [U.locD, "facility", gh2013, { type: "electricity", provider: "Placeholder Power Co", account: "EL-900100", base: 185, method: "bank" }, true],
    [U.locD, "facility", gh2013, { type: "water", provider: "Fictional Water Utility", base: 64, method: "check" }, false],
    [U.locD, "facility", gh2013, { type: "internet", provider: "Sample Fiber", base: 79.99, method: "card" }, false],
    [U.opsA, "facility", gh221, { type: "electricity", provider: "Example Electric", base: 160, method: "autopay" }, false],
    [U.opsA, "facility", gh221, { type: "gas", provider: "Pretend Gas", base: 45, method: "ach" }, false],
  ];
  for (const [actor, kind, owner, s, overdue] of specs) {
    const id = await utility(actor, kind, owner, s);
    await bills(actor, kind, owner, id, s, overdue);
  }

  // A few Dallas employees (from the dev pipeline's joined placements) work for Eureka Info Tech.
  const emps = (await admin.query<{ person_id: string }>(
    `SELECT e.person_id FROM eureka.employee e JOIN eureka.candidate c ON c.id = e.candidate_id
      WHERE c.location_id = $1 AND e.status <> 'exited' ORDER BY e.person_id LIMIT 3`, [LOC.dallas])).rows;
  for (const e of emps) {
    await asUser(admin, U.locD, (c) => c.query(`SELECT authz.company_employee_add($1, $2, $3::date)`, [eit, e.person_id, iso(monthStart(2))]));
    out.employees++;
  }
  return out;
}
