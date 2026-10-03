import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "../api";
import { browser } from "../sales/resumesApi";
import { DocumentsSection } from "./DocumentsSection";
import { documentFileProblem, documentTypeOf, pageNav, returnPath, uploadableTypes } from "./documentsApi";

// Paperwork documents and step-up (API: apps/api/src/modules/documents, identity/step-up; migration 0043).

const CID = "11111111-1111-4111-8111-111111111111";
const PID = "22222222-2222-4222-8222-222222222222";
const D1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const D2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const D3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PDF = "application/pdf";
const BASE = `/api/v1/candidates/${CID}/documents`;

const doc = (id: string, extra: Record<string, unknown> = {}) => ({
  id, candidateId: CID, placementId: null, docType: "offer_letter", docTypeLabel: "Offer letter", classification: "internal",
  status: "clean", reason: null, contentType: PDF, sizeBytes: 120_000, sha256: "a".repeat(64),
  uploadedBy: { id: "u1", name: "HR One" }, createdAt: "2026-09-20T10:00:00Z", scannedAt: "2026-09-20T10:01:00Z", ...extra,
});
const i9 = (id = D2, extra: Record<string, unknown> = {}) => doc(id, { docType: "i9", docTypeLabel: "Form I-9", classification: "restricted", ...extra });

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
    const key = url.origin === "http://localhost" ? `${url.pathname}${url.search}` : url.href;
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: key, body });
    const h = routes[`${method} ${key}`];
    if (!h) return new Response(JSON.stringify({ detail: "unmocked" }), { status: 599 });
    const r = h(body);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
});
afterEach(() => vi.restoreAllMocks());

const wrap = (owner: { kind: "candidate" | "placement"; id: string } = { kind: "candidate", id: CID }) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DocumentsSection owner={owner} title="Paperwork documents" pollMs={20} />
  </QueryClientProvider>);
const listing = (items: unknown[], flags: Record<string, boolean> = {}) => () => ({
  body: { items, canUpload: true, canUploadRestricted: true, canViewRestricted: true, ...flags },
});

describe("Paperwork documents section", () => {
  it("lists documents with a Restricted label; Open only for clean files; an access log for restricted ones", async () => {
    routes[`GET ${BASE}`] = listing([doc(D1), i9(D2, { placementId: PID }), doc(D3, { status: "infected", reason: "THREATS_FOUND" })]);
    wrap();
    const table = await screen.findByRole("table", { name: "Paperwork documents, newest first" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("Restricted")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/placement/)).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("button", { name: "Access log for Form I-9" })).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button", { name: /Access log/ })).toBeNull();
    expect(within(rows[2]!).getByText("Blocked: malware found")).toBeInTheDocument();
    expect(within(rows[2]!).queryByRole("button", { name: /Open/ })).toBeNull();
  });

  it("hides itself when the server refuses the list (403/404)", async () => {
    routes[`GET ${BASE}`] = () => problem(403, "Not permitted");
    const { container } = wrap();
    await waitFor(() => expect(calls.some((c) => c.path === BASE)).toBe(true));
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });

  it("uploads: type and file, presigned POST, scanning until clean; restricted types only when allowed", async () => {
    let items: unknown[] = [];
    routes[`GET ${BASE}`] = () => listing(items, { canUploadRestricted: false })();
    routes[`POST ${BASE}`] = (b) => {
      expect(b).toEqual({ docType: "offer_letter", contentType: PDF, size: 1234 });
      items = [doc(D1, { status: "pending", scannedAt: null })];
      return { status: 201, body: { id: D1, fileId: D3, classification: "internal", status: "pending",
        upload: { url: "https://bucket.example/", fields: { key: `quarantine/documents/${D3}`, policy: "p" }, expiresAt: "2026-09-20T10:02:00Z" } } };
    };
    routes["POST https://bucket.example/"] = () => ({ status: 204 });
    wrap();
    const select = await screen.findByRole("combobox", { name: "Document type" });
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).not.toContain("Form I-9 (restricted)");
    expect(options).toContain("Offer letter");
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the document type.");
    fireEvent.change(select, { target: { value: "offer_letter" } });
    fireEvent.change(screen.getByLabelText("Document file"), { target: { files: [new File([new Uint8Array(1234)], "Jane_offer.pdf", { type: PDF })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "https://bucket.example/")).toBe(true));
    const form = calls.find((c) => c.path === "https://bucket.example/")!.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "file"]);
    items = [doc(D1)];
    expect(await screen.findByText("Offer letter is ready.")).toBeInTheDocument();
  });

  it("refuses unsupported files before contacting the server", async () => {
    routes[`GET ${BASE}`] = listing([]);
    wrap();
    fireEvent.change(await screen.findByRole("combobox", { name: "Document type" }), { target: { value: "i9" } });
    fireEvent.change(screen.getByLabelText("Document file"), { target: { files: [new File(["<html>"], "i9.html", { type: "text/html" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PDF, Word (.docx), PNG or JPEG file.");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("opening a restricted document asks to confirm it's you (development) and then opens it", async () => {
    const assign = vi.spyOn(browser, "download").mockImplementation(() => undefined);
    routes[`GET ${BASE}`] = listing([i9()]);
    let stepped = false;
    routes[`POST /api/v1/documents/${D2}/download`] = () => stepped
      ? { body: { url: "/api/local-storage/object?policy=x&signature=y", expiresAt: "2026-09-20T10:05:00Z" } }
      : problem(403, "step_up_required");
    routes["GET /api/auth/step-up"] = () => ({ body: { active: false, expiresAt: null, method: null, mode: "dev", ttlMinutes: 10 } });
    routes["POST /api/auth/step-up/dev"] = () => { stepped = true; return { body: { active: true, expiresAt: "2026-09-20T10:10:00Z" } }; };
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Open Form I-9" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(within(dialog).getByText(/next 10 minutes/)).toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm (development)" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/local-storage/object?policy=x&signature=y"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.filter((c) => c.path === `/api/v1/documents/${D2}/download`)).toHaveLength(2);
  });

  it("with Google, confirming sends the browser to Google and back to this page", async () => {
    const nav = vi.spyOn(pageNav, "assign").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/candidates/abc?tab=docs");
    routes[`GET ${BASE}`] = listing([i9()]);
    routes[`POST /api/v1/documents/${D2}/download`] = () => problem(403, "step_up_required");
    routes["GET /api/auth/step-up"] = () => ({ body: { active: false, expiresAt: null, method: null, mode: "google", ttlMinutes: 10 } });
    routes["POST /api/auth/step-up/start"] = (b) => {
      expect(b).toEqual({ returnTo: "/candidates/abc?tab=docs" });
      return { body: { redirectUrl: "https://accounts.google.com/o/oauth2/v2/auth?max_age=0" } };
    };
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Open Form I-9" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(nav).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?max_age=0"));
    window.history.replaceState(null, "", "/");
  });

  it("says so when Google step-up failed (returned with stepUp=failed)", async () => {
    window.history.replaceState(null, "", "/candidates/abc?stepUp=failed");
    routes[`GET ${BASE}`] = listing([i9()]);
    wrap();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not confirm it's you");
    window.history.replaceState(null, "", "/");
  });

  it("shows the access log of a restricted document", async () => {
    routes[`GET ${BASE}`] = listing([i9()]);
    routes[`GET /api/v1/document-access?documentId=${D2}`] = () => ({ body: { items: [
      { id: "l1", documentId: D2, docType: "i9", classification: "restricted", user: { id: "u2", name: "Accounts One" }, action: "download", steppedUp: true, at: "2026-09-21T09:00:00Z" },
    ] } });
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Access log for Form I-9" }));
    const dialog = await screen.findByRole("dialog", { name: "Access log: Form I-9" });
    expect(await within(dialog).findByText("Accounts One")).toBeInTheDocument();
    expect(within(dialog).getByText("Signed in again")).toBeInTheDocument();
  });

  it("placement documents use the placement route", async () => {
    routes[`GET /api/v1/placements/${PID}/documents`] = listing([doc(D1, { placementId: PID })]);
    wrap({ kind: "placement", id: PID });
    expect(await screen.findByRole("table", { name: "Paperwork documents, newest first" })).toBeInTheDocument();
  });
});

describe("document helpers", () => {
  it("file type by MIME type or extension; size and emptiness", () => {
    expect(documentTypeOf({ name: "a.JPEG", type: "" })).toBe("image/jpeg");
    expect(documentTypeOf({ name: "a.png", type: "image/png" })).toBe("image/png");
    expect(documentTypeOf({ name: "a.pdf", type: "text/html" })).toBeNull();
    expect(documentFileProblem({ name: "a.pdf", type: PDF, size: 0 })).toBe("That file is empty.");
    expect(documentFileProblem({ name: "a.pdf", type: PDF, size: 16 * 1024 * 1024 })).toBe("That file is larger than 15 MB.");
  });

  it("restricted types are offered only to restricted uploaders; return paths stay on this site", () => {
    expect(uploadableTypes({ canUploadRestricted: false })).not.toContain("i9");
    expect(uploadableTypes({ canUploadRestricted: true })).toContain("i9");
    expect(returnPath({ pathname: "/candidates/x", search: "?a=1" })).toBe("/candidates/x?a=1");
    expect(returnPath({ pathname: "//evil.example", search: "" })).toBe("/");
    expect(returnPath({ pathname: "/a", search: "?q=<script>" })).toBe("/");
  });
});
