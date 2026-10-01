import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "../api";
import { CandidateResumes } from "./CandidateResumes";
import { browser, resumeFileProblem, resumeTypeOf } from "./resumesApi";

// Resumes on the candidate profile (API: apps/api/src/modules/resumes, migration 0036).

const CID = "11111111-1111-4111-8111-111111111111";
const R1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const R3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PDF = "application/pdf";
const BASE = `/api/v1/candidates/${CID}/resumes`;

const resume = (id: string, extra: Record<string, unknown> = {}) => ({
  id, status: "clean", reason: null, version: 1, isCurrent: true, contentType: PDF, sizeBytes: 245_760, sha256: "a".repeat(64),
  uploadedBy: { id: "u1", name: "Lead One" }, createdAt: "2026-09-20T10:00:00Z", scannedAt: "2026-09-20T10:01:00Z", ...extra,
});

type Reply = { status?: number; body?: unknown };
interface Call { method: string; path: string; body: unknown }
let routes: Record<string, (body: unknown) => Reply>;
let calls: Call[];
const problem = (status: number, detail?: string): Reply => ({ status, body: { type: "about:blank", title: "Error", status, detail } });

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  routes = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.origin === "http://localhost" ? url.pathname : url.href, body });
    const h = routes[`${method} ${url.origin === "http://localhost" ? url.pathname : url.href}`];
    if (!h) return new Response(JSON.stringify({ detail: "unmocked" }), { status: 599 });
    const r = h(body);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
});
afterEach(() => vi.restoreAllMocks());

const wrap = (pollMs = 3000) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CandidateResumes candidateId={CID} pollMs={pollMs} /></QueryClientProvider>);
const pick = (file: File) => fireEvent.change(screen.getByLabelText("Resume file"), { target: { files: [file] } });
const pdfFile = (name = "Asha_Iyer_resume.pdf", size = 1234) => new File([new Uint8Array(size)], name, { type: PDF });

describe("Resume section", () => {
  it("shows the current version and the history with plain-language statuses; download only for clean files", async () => {
    routes[`GET ${BASE}`] = () => ({ body: { canUpload: false, items: [
      resume(R3, { status: "infected", reason: "THREATS_FOUND", version: null, isCurrent: false, createdAt: "2026-09-22T10:00:00Z" }),
      resume(R2, { version: 2 }),
      resume(R1, { version: 1, isCurrent: false }),
    ] } });
    wrap();
    expect(await screen.findByText("Current: version 2")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Resume uploads, newest first" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Blocked: malware found")).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button")).toBeNull();
    expect(within(rows[1]!).getByText("v2 (current)")).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("button", { name: "Download version 1" })).toBeInTheDocument();
    // canUpload false: no upload form
    expect(screen.queryByLabelText("Resume file")).toBeNull();
  });

  it("downloads through a short-lived link from the API and announces it", async () => {
    routes[`GET ${BASE}`] = () => ({ body: { canUpload: false, items: [resume(R1, { version: 3 })] } });
    routes[`POST ${BASE}/${R1}/download`] = () => ({ body: { url: "https://bucket.s3.us-east-2.amazonaws.com/clean/resumes/x?X-Amz-Expires=60", expiresAt: "2026-09-20T10:02:00Z" } });
    const open = vi.spyOn(browser, "download").mockImplementation(() => undefined);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Download current version" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://bucket.s3.us-east-2.amazonaws.com/clean/resumes/x?X-Amz-Expires=60"));
    expect(await screen.findByText("Downloading resume version 3.")).toBeInTheDocument();
  });

  it("uploads: asks for a signed form, posts fields then the file to storage, shows Scanning, then announces the result", async () => {
    let scanned = false;
    routes[`GET ${BASE}`] = () => ({ body: { canUpload: true, items: calls.some((c) => c.path.startsWith("https://")) ? [
      resume(R2, scanned ? { version: 1 } : { status: "pending", version: null, isCurrent: false, scannedAt: null }),
    ] : [] } });
    routes[`POST ${BASE}`] = () => ({ status: 201, body: { id: R2, status: "pending", upload: {
      url: "https://bucket.s3.us-east-2.amazonaws.com/", fields: { key: `quarantine/resumes/${R2}`, "Content-Type": PDF, Policy: "p", "X-Amz-Signature": "s" }, expiresAt: "x" } } });
    routes["POST https://bucket.s3.us-east-2.amazonaws.com/"] = () => ({ status: 204 });
    wrap(50);
    expect(await screen.findByText("No resume yet.")).toBeInTheDocument();
    pick(pdfFile());
    fireEvent.click(screen.getByRole("button", { name: "Upload resume" }));

    expect(await screen.findByText(/Uploaded\. Scanning for malware/)).toBeInTheDocument();
    const req = calls.find((c) => c.method === "POST" && c.path === BASE)!;
    expect(req.body).toEqual({ contentType: PDF, size: 1234 }); // no file name, no key
    const form = calls.find((c) => c.path === "https://bucket.s3.us-east-2.amazonaws.com/")!.body as FormData;
    expect([...form.keys()]).toEqual(["key", "Content-Type", "Policy", "X-Amz-Signature", "file"]);
    expect(await screen.findByText("Scanning")).toBeInTheDocument();

    scanned = true;
    expect(await screen.findByText("Resume version 1 is ready.", {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText("Current: version 1")).toBeInTheDocument();
  });

  it("checks type and size before asking the server, and moves focus to the file field", async () => {
    routes[`GET ${BASE}`] = () => ({ body: { canUpload: true, items: [] } });
    wrap();
    await screen.findByText("No resume yet.");
    pick(new File(["<html>"], "resume.html", { type: "text/html" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PDF or Word (.docx) file.");
    expect(screen.getByLabelText("Resume file")).toHaveFocus();
    expect(screen.getByLabelText("Resume file")).toHaveAttribute("aria-invalid", "true");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("explains a full scan queue (409) and a storage failure", async () => {
    routes[`GET ${BASE}`] = () => ({ body: { canUpload: true, items: [] } });
    routes[`POST ${BASE}`] = () => problem(409, "too_many_pending");
    wrap();
    await screen.findByText("No resume yet.");
    pick(pdfFile());
    fireEvent.click(screen.getByRole("button", { name: "Upload resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already being scanned/);

    routes[`POST ${BASE}`] = () => ({ status: 201, body: { id: R2, status: "pending", upload: { url: "https://bucket.s3.us-east-2.amazonaws.com/", fields: {}, expiresAt: "x" } } });
    routes["POST https://bucket.s3.us-east-2.amazonaws.com/"] = () => ({ status: 403 });
    fireEvent.click(screen.getByRole("button", { name: "Upload resume" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be sent to storage/));
  });

  it("hides itself when the server says resumes are not visible to this user (403)", async () => {
    routes[`GET ${BASE}`] = () => problem(403);
    const { container } = wrap();
    await waitFor(() => expect(calls.some((c) => c.path === BASE)).toBe(true));
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });
});

describe("file checks", () => {
  it("accepts PDF and DOCX by type, or by extension when the browser sends no type", () => {
    expect(resumeTypeOf({ name: "a.pdf", type: PDF })).toBe(PDF);
    expect(resumeTypeOf({ name: "a.docx", type: "" })).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(resumeTypeOf({ name: "a.doc", type: "application/msword" })).toBeNull();
    expect(resumeTypeOf({ name: "a.pdf", type: "text/html" })).toBeNull();
    expect(resumeFileProblem({ name: "a.pdf", type: PDF, size: 15 * 1024 * 1024 + 1 })).toMatch(/15 MB/);
    expect(resumeFileProblem({ name: "a.pdf", type: PDF, size: 0 })).toMatch(/empty/);
  });
});
