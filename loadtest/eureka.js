// Eureka launch load test (implementation plan, MVP exit criteria):
// 120 concurrent users over the main read and write endpoints against a
// database seeded with ~50k fictional candidates (apps/api/src/db/seed-load.ts).
// Pass: p95 < 500 ms and < 1% failed requests. See loadtest/README.md.
//
//   k6 run -e BASE_URL=http://localhost:3000 loadtest/eureka.js
//
// Never point this at production: it writes submissions and interviews, and
// it signs in as the fictional load users (load-*@eureka.example).
import http from "k6/http";
import crypto from "k6/crypto";
import { check, fail, group, sleep } from "k6";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const VUS = Number(__ENV.VUS || 120);
const RAMP = __ENV.RAMP || "2m";
const HOLD = __ENV.HOLD || "10m";
const RAMP_DOWN = __ENV.RAMP_DOWN || "1m";
const THINK_MIN = Number(__ENV.THINK_MIN || 2);
const THINK_MAX = Number(__ENV.THINK_MAX || 6);
// dev:    POST /api/auth/dev-login (API with AUTH_MODE=dev, NODE_ENV != production)
// minted: sessions minted by seed-load with the same LOAD_SESSION_KEY (stacks with Google sign-in)
const AUTH = __ENV.AUTH || "dev";
const SESSION_KEY = __ENV.LOAD_SESSION_KEY || "";
// Only when calling the API Gateway endpoint directly (bypassing CloudFront): the origin secret.
const ORIGIN_VERIFY = __ENV.ORIGIN_VERIFY || "";
// Share of iterations that write (submissions, status changes, interviews).
const WRITE_SHARE = Number(__ENV.WRITE_SHARE || 0.15);

// ---- safety: refuse anything that is not clearly local or staging ------------------------------
const host = (BASE_URL.match(/^https?:\/\/([^/:]+)/) || [])[1] || "";
const allowed = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) || /staging/i.test(host) || host === (__ENV.ALLOW_HOST || "\0");
if (!allowed) throw new Error(`Refusing BASE_URL host "${host}": only localhost, *staging* hosts, or ALLOW_HOST=${host}`);
if (/prod/i.test(host)) throw new Error(`Refusing BASE_URL host "${host}": looks like production`);
if (AUTH === "minted" && SESSION_KEY.length < 32) throw new Error("AUTH=minted needs LOAD_SESSION_KEY (32+ chars), as given to seed-load");

// ---- load users (must match loadUsers() in apps/api/src/db/seed-load.ts) -----------------------
const pad = (n, w) => String(n).padStart(w, "0");
const email = (kind, n, w) => `load-${kind}-${pad(n, w)}@eureka.example`;
const COUNTS = { recruiter: 120, lead: 30, manager: 6, locadmin: 4, hr: 2, accounts: 2, coach: 3 };
const WIDTH = { recruiter: 3 };
// Mix per 20 VUs: 14 recruiters, 3 leads, 1 manager, 1 location admin, 1 HR or Accounts.
const PATTERN = ["recruiter", "recruiter", "recruiter", "recruiter", "recruiter", "recruiter", "recruiter", "lead",
  "recruiter", "recruiter", "recruiter", "recruiter", "recruiter", "recruiter", "recruiter", "lead",
  "lead", "manager", "locadmin", "backoffice"];

function persona(vu) {
  let kind = PATTERN[(vu - 1) % PATTERN.length];
  // How many VUs before this one share its kind: spreads VUs over distinct users.
  const block = Math.floor((vu - 1) / PATTERN.length);
  const before = PATTERN.slice(0, (vu - 1) % PATTERN.length).filter((k) => k === kind).length;
  const perBlock = PATTERN.filter((k) => k === kind).length;
  let n = block * perBlock + before;
  if (kind === "backoffice") { kind = n % 2 === 0 ? "hr" : "accounts"; n = Math.floor(n / 2); }
  return { kind, email: email(kind, 1 + (n % COUNTS[kind]), WIDTH[kind] || 2) };
}

export const options = {
  scenarios: {
    users: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: HOLD, target: VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    // The exit criterion names these two screens explicitly.
    "http_req_duration{name:hotlist}": ["p(95)<500"],
    "http_req_duration{name:interviews_board}": ["p(95)<500"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  // Sessions use cookies; one jar per VU.
  noCookiesReset: true,
};

// Expected non-2xx answers that are not failures: a duplicate/overlapping interview slot (409).
const OK_OR_CONFLICT = http.expectedStatuses({ min: 200, max: 299 }, 409);

// ---- per-VU state ----------------------------------------------------------------------------
let me = null; // { csrf, kind, email }
let lookups = null;

function headers(extra) {
  const h = Object.assign({ Accept: "application/json" }, extra || {});
  if (ORIGIN_VERIFY) h["X-Origin-Verify"] = ORIGIN_VERIFY;
  return h;
}
function get(path, name) {
  return http.get(`${BASE_URL}${path}`, { headers: headers(), tags: { name } });
}
function write(method, path, body, name, responseCallback) {
  return http.request(method, `${BASE_URL}${path}`, JSON.stringify(body), {
    headers: headers({ "Content-Type": "application/json", "X-CSRF-Token": me.csrf }),
    tags: { name },
    responseCallback,
  });
}
const json = (r) => { try { return r.json(); } catch (_) { return null; } };
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const think = () => sleep(THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN));
const ok = (r, what) => check(r, { [`${what} 2xx`]: (x) => x.status >= 200 && x.status < 300 });

function signIn() {
  const p = persona(__VU);
  if (AUTH === "minted") {
    const sid = crypto.hmac("sha256", SESSION_KEY, p.email, "hex");
    http.cookieJar().set(BASE_URL, "eureka_sid", sid);
  } else {
    const r = http.post(`${BASE_URL}/api/auth/dev-login`, JSON.stringify({ email: p.email }), {
      headers: headers({ "Content-Type": "application/json" }), tags: { name: "dev_login" },
    });
    if (r.status !== 204) fail(`dev sign-in as ${p.email} failed: ${r.status} (is the API running with AUTH_MODE=dev, and the load seed applied?)`);
  }
  const r = get("/api/v1/me", "me");
  const body = json(r);
  if (r.status !== 200 || !body || !body.csrfToken) fail(`session for ${p.email} not accepted: ${r.status}`);
  me = { csrf: body.csrfToken, kind: p.kind, email: p.email };
  lookups = json(get("/api/v1/lookups", "lookups")) || {};
}

// ---- screens ----------------------------------------------------------------------------------
const STATUSES = ["active", "on_hold", "full_of_interviews"];
const SEARCHES = ["Pa", "Sh", "Ku", "Ra", "Me", "Iy"];

function hotList() {
  group("hot list", () => {
    let q = "?limit=50";
    const roll = Math.random();
    if (roll < 0.25) q += `&status=${pick(STATUSES)}`;
    else if (roll < 0.45) q += `&search=${pick(SEARCHES)}`;
    else if (roll < 0.6 && lookups.technologies && lookups.technologies.length) q += `&technology=${encodeURIComponent(pick(lookups.technologies).name)}`;
    const r = get(`/api/v1/hotlist${q}`, "hotlist");
    ok(r, "hotlist");
    const page = json(r);
    if (page && page.nextCursor && Math.random() < 0.3) {
      think();
      ok(get(`/api/v1/hotlist${q}&cursor=${page.nextCursor}`, "hotlist"), "hotlist next page");
    }
    const openable = ((page && page.items) || []).filter((c) => c.canOpenProfile);
    if (openable.length && Math.random() < 0.5) {
      think();
      ok(get(`/api/v1/candidates/${pick(openable).id}`, "candidate_profile"), "profile");
    }
  });
}

function candidates() {
  group("candidates", () => {
    const q = Math.random() < 0.5 ? `?limit=50&status=${pick(STATUSES)}` : "?limit=50";
    const r = get(`/api/v1/candidates${q}`, "candidates");
    ok(r, "candidates");
    const items = ((json(r) || {}).items) || [];
    if (items.length) {
      think();
      ok(get(`/api/v1/candidates/${pick(items).id}`, "candidate_profile"), "profile");
    }
  });
}

function submissions() {
  group("submissions", () => {
    const q = Math.random() < 0.5 ? "?limit=50" : `?limit=50&status=${pick(["submitted", "under_review", "interview_scheduled"])}`;
    ok(get(`/api/v1/submissions${q}`, "submissions"), "submissions");
  });
}

function interviewsBoard() {
  group("interviews board", () => {
    const day = 86_400_000;
    const from = new Date(Date.now() - day).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 7 * day).toISOString().slice(0, 10);
    ok(get(`/api/v1/interviews?from=${from}&to=${to}&limit=100`, "interviews_board"), "interviews board");
  });
}

function placements() {
  group("placements", () => {
    const r = get("/api/v1/placements?limit=50", "placements");
    ok(r, "placements");
    const items = ((json(r) || {}).items) || [];
    if (items.length && Math.random() < 0.3) {
      think();
      ok(get(`/api/v1/placements/${pick(items).id}`, "placement_detail"), "placement detail");
    }
  });
}

// ---- writes (recruiters and leads only; fictional data on a load database) ---------------------
function logSubmission() {
  group("log submission", () => {
    const own = ((json(get("/api/v1/candidates?limit=50&status=active", "candidates")) || {}).items) || [];
    const clients = lookups.clients || [];
    if (!own.length || !clients.length) return;
    think();
    const r = write("POST", "/api/v1/submissions", {
      candidateId: pick(own).id, jobTitle: "Load Test Java Developer", clientId: pick(clients).id, rate: 60 + Math.floor(Math.random() * 20),
    }, "submission_create");
    ok(r, "submission create");
  });
}

function advanceSubmission() {
  group("advance submission", () => {
    const items = ((json(get("/api/v1/submissions?limit=50&status=submitted", "submissions")) || {}).items) || [];
    const mine = items.filter((s) => s.actions && s.actions.transition && s.actions.transition.indexOf("under_review") >= 0);
    if (!mine.length) return;
    think();
    // Another VU signed in as the same user may have moved it first: 409/422 are not server failures.
    const r = write("PATCH", `/api/v1/submissions/${pick(mine).id}/status`, { to: "under_review" }, "submission_status",
      http.expectedStatuses({ min: 200, max: 299 }, 409, 422));
    check(r, { "submission status answered": (x) => x.status < 500 });
  });
}

function scheduleInterview() {
  group("schedule interview", () => {
    const items = ((json(get("/api/v1/submissions?limit=50&status=interview_requested", "submissions")) || {}).items) || [];
    const open = items.filter((s) => s.actions && s.actions.createInterview);
    if (!open.length) return;
    think();
    // A slot 10-40 days ahead, on the hour; an overlapping slot for the same candidate answers 409.
    const start = new Date(Date.now() + (10 + Math.floor(Math.random() * 30)) * 86_400_000);
    start.setUTCHours(14 + Math.floor(Math.random() * 8), 0, 0, 0);
    const end = new Date(start.getTime() + 3_600_000);
    const r = write("POST", "/api/v1/interviews", {
      submissionId: pick(open).id, round: "L2", startsAt: start.toISOString(), endsAt: end.toISOString(),
    }, "interview_create", OK_OR_CONFLICT);
    check(r, { "interview create answered": (x) => x.status < 500 });
  });
}

// ---- iteration: one screen visit per persona, weighted -----------------------------------------
const MIX = {
  recruiter: [[hotList, 35], [candidates, 20], [submissions, 15], [interviewsBoard, 15], [placements, 5]],
  lead: [[hotList, 25], [candidates, 20], [submissions, 20], [interviewsBoard, 25], [placements, 10]],
  manager: [[hotList, 20], [submissions, 25], [interviewsBoard, 30], [placements, 25]],
  locadmin: [[candidates, 30], [interviewsBoard, 50], [submissions, 20]],
  // HR and Accounts have no submission:read or interview:read.
  hr: [[placements, 70], [hotList, 15], [candidates, 15]],
  accounts: [[placements, 80], [candidates, 20]],
};
const WRITES = [[logSubmission, 50], [advanceSubmission, 30], [scheduleInterview, 20]];

function weighted(entries) {
  const total = entries.reduce((s, e) => s + e[1], 0);
  let x = Math.random() * total;
  for (const [fn, w] of entries) { x -= w; if (x < 0) return fn; }
  return entries[entries.length - 1][0];
}

export default function () {
  if (!me) signIn();
  const writer = me.kind === "recruiter" || me.kind === "lead";
  if (writer && Math.random() < WRITE_SHARE) weighted(WRITES)();
  else weighted(MIX[me.kind])();
  think();
}
