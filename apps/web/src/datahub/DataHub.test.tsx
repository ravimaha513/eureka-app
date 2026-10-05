import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCsrf } from "../api";
import { visibleNav } from "../nav";
import { browser } from "../sales/resumesApi";
import { DataHubPage } from "./DataHubPage";
import { datahubError, datahubFileProblem, storage } from "./datahubApi";
import { ApiError } from "../api";

// DataHub screen (API: apps/api/src/modules/datahub; docs/datahub-api.md; migration 0075).

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const FILE1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const V1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PDF = "application/pdf";

const folder = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, parentId: null, name, description: null, level: "internal", roleKeys: [], membersCanUpload: false, locationId: null,
  fileCount: 0, memberCount: null, isMember: false, rowVersion: 1, createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z",
  actions: { read: true, upload: true, manage: true, createSubfolder: true }, ...extra,
});
const version = (extra: Record<string, unknown> = {}) => ({
  id: V1, version: 2, status: "clean", reason: null, contentType: PDF, sizeBytes: 120_000,
  uploadedBy: { id: U1, name: "HR One" }, createdAt: "2026-10-02T10:00:00Z", scannedAt: "2026-10-02T10:01:00Z", ...extra,
});
const file = (extra: Record<string, unknown> = {}, v: Record<string, unknown> = {}) => ({
  id: FILE1, folderId: F1, name: "Leave policy.pdf", versionCount: 2, latestVersion: version(v), actions: { download: true, delete: true }, ...extra,
});

type Reply = { status?: number; body?: unknown };
interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }
let routes: Record<string, (body: unknown) => Reply>;
let calls: Call[];
const problem = (status: number, detail?: string): Reply => ({ status, body: { type: "about:blank", title: "Error", status, detail } });

beforeEach(() => {
  setCsrf("tok");
  calls = [];
  routes = {
    "GET /api/v1/lookups": () => ({ body: { technologies: [], clients: [], vendors: [], implementationPartners: [], locations: [{ id: "loc-d", name: "Dallas" }], coaches: [] } }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${url.pathname}${url.search}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: key, body, headers: (init.headers ?? {}) as Record<string, string> });
    const h = routes[`${method} ${key}`];
    if (!h) return new Response(JSON.stringify({ detail: "unmocked" }), { status: 599 });
    const r = h(body);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
});
afterEach(() => vi.restoreAllMocks());

const wrap = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DataHubPage pollMs={20} />
  </QueryClientProvider>);
const folderList = (items: unknown[], extra: Record<string, unknown> = {}) => () => ({
  body: { items, canCreate: true, createScope: { org: true, locationIds: [] }, ...extra },
});

describe("DataHub page", () => {
  it("is in the navigation for datahub:read holders", () => {
    expect(visibleNav(["datahub:read"]).map((n) => n.label)).toContain("DataHub");
    expect(visibleNav(["access:manage", "audit:read"]).map((n) => n.label)).not.toContain("DataHub");
  });

  it("empty states: no folders yet, select a folder; header buttons per rights", async () => {
    routes["GET /api/v1/datahub/folders"] = folderList([]);
    wrap();
    expect(await screen.findByText("No folders yet")).toBeInTheDocument();
    expect(screen.getByText("Select a folder to view documents")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "DataHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New folder" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(screen.getByRole("searchbox", { name: "Search documents" })).toBeInTheDocument();
  });

  it("readers get no New folder button", async () => {
    routes["GET /api/v1/datahub/folders"] = folderList([folder(F1, "Company policies", { actions: { read: true, upload: false, manage: false, createSubfolder: false } })],
      { canCreate: false, createScope: { org: false, locationIds: [] } });
    wrap();
    await screen.findByRole("button", { name: /Company policies/ });
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
  });

  it("folders panel with level icons; selecting a folder lists its files with version, size, uploader, date and scan status", async () => {
    routes["GET /api/v1/datahub/folders"] = folderList([
      folder(F1, "Company policies", { fileCount: 2 }),
      folder(F2, "Sales playbooks", { level: "confidential", roleKeys: ["lead"] }),
      folder(F3, "Payroll exports", { level: "restricted", memberCount: 2, actions: { read: false, upload: false, manage: true, createSubfolder: true } }),
    ]);
    routes[`GET /api/v1/datahub/folders/${F1}/files`] = () => ({ body: { items: [
      file(),
      file({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Draft.pdf", actions: { download: false, delete: false } }, { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", version: 1, status: "pending" }),
    ], nextCursor: null } });
    wrap();
    const panel = await screen.findByRole("list", { name: "Folders" });
    expect(within(panel).getByRole("button", { name: /Company policies/ })).toHaveTextContent("Internal");
    expect(within(panel).getByRole("button", { name: /Sales playbooks/ })).toHaveTextContent("Confidential");
    expect(within(panel).getByRole("button", { name: /Payroll exports/ })).toHaveTextContent("Restricted");

    fireEvent.click(within(panel).getByRole("button", { name: /Company policies/ }));
    const table = await screen.findByRole("table", { name: "Files in Company policies" });
    expect(within(panel).getByRole("button", { name: /Company policies/ })).toHaveAttribute("aria-current", "true");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Leave policy.pdf");
    expect(rows[0]).toHaveTextContent("v2");
    expect(rows[0]).toHaveTextContent("117 KB");
    expect(rows[0]).toHaveTextContent("HR One");
    expect(within(rows[0]!).getByText("Clean")).toHaveClass("badge", "resume-clean");
    expect(within(rows[1]!).getByText("Scanning")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("button", { name: "Download Draft.pdf" })).toBeDisabled();
    expect(within(rows[1]!).queryByRole("button", { name: "Delete Draft.pdf" })).toBeNull();

    // A manager who is not a member of a restricted folder sees settings, not files.
    fireEvent.click(within(panel).getByRole("button", { name: /Payroll exports/ }));
    expect(await screen.findByText(/aren't one of its members/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Members" })).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith(`/api/v1/datahub/folders/${F3}/files`))).toBe(false);
  });

  it("Create New Folder: the reference fields; Confidential needs roles; sent with an Idempotency-Key", async () => {
    routes["GET /api/v1/datahub/folders"] = folderList([]);
    let sent: unknown;
    routes["POST /api/v1/datahub/folders"] = (b) => { sent = b; return { status: 201, body: { id: F1, rowVersion: 1 } }; };
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    const dialog = screen.getByRole("dialog", { name: "Create New Folder" });
    const level = within(dialog).getByRole("combobox", { name: "Security level" });
    expect(within(level).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Internal – All employees", "Confidential – Specific roles", "Restricted – Limited access"]);
    expect(within(dialog).getByText("Accessible to all employees in the organisation.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Description (Optional)")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Create Folder" }));
    expect(await within(dialog).findByText("Enter a folder name.")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Folder name *"), { target: { value: " Java Resumes " } });
    fireEvent.change(level, { target: { value: "confidential" } });
    const role = within(dialog).getByRole("searchbox", { name: "Role" });
    expect(role).toHaveAttribute("placeholder", "Eg. Employee, Manager…");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Folder" }));
    expect(await within(dialog).findByText("Choose at least one role.")).toBeInTheDocument();
    fireEvent.change(role, { target: { value: "lead" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Lead (Sales)" }));
    fireEvent.change(within(dialog).getByLabelText("Description (Optional)"), { target: { value: "Sample resumes" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Folder" }));
    await waitFor(() => expect(sent).toEqual({ name: "Java Resumes", level: "confidential", description: "Sample resumes", roleKeys: ["lead"], parentId: null }));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/datahub/folders")!;
    expect(post.headers["idempotency-key"]).toMatch(/^dh-[0-9a-f]{32}$/);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Restricted folders pick people; a location manager chooses the location; server errors stay in the dialog", async () => {
    routes["GET /api/v1/datahub/folders"] = folderList([], { createScope: { org: false, locationIds: ["loc-d"] } });
    routes["GET /api/v1/datahub/people?q="] = () => ({ body: { items: [{ id: U1, name: "Riya Rao" }] } });
    let sent: unknown;
    routes["POST /api/v1/datahub/folders"] = (b) => { sent = b; return problem(409, "name_taken"); };
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    const dialog = screen.getByRole("dialog", { name: "Create New Folder" });
    fireEvent.change(within(dialog).getByLabelText("Folder name *"), { target: { value: "Leases" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Security level" }), { target: { value: "restricted" } });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add Riya Rao" }));
    expect(within(within(dialog).getByRole("list", { name: "Chosen people" })).getByText("Riya Rao")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Location" })).toHaveValue("loc-d");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Folder" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A folder with this name already exists here.");
    expect(sent).toEqual({ name: "Leases", level: "restricted", description: null, memberIds: [U1], parentId: null, locationId: "loc-d" });
  });

  it("upload dialog: presigned POST with progress, then scanning until clean", async () => {
    let items: unknown[] = [];
    routes["GET /api/v1/datahub/folders"] = folderList([folder(F1, "Company policies")]);
    routes[`GET /api/v1/datahub/folders/${F1}/files`] = () => ({ body: { items, nextCursor: null } });
    routes[`POST /api/v1/datahub/folders/${F1}/files`] = (b) => {
      expect(b).toEqual({ name: "Leave policy.pdf", contentType: PDF, size: 1234 });
      items = [file({}, { status: "pending", version: 1 })];
      return { status: 201, body: { fileId: FILE1, versionId: V1, version: 1, status: "pending",
        upload: { url: "https://bucket.example/", fields: { key: "quarantine/documents/x" }, expiresAt: "2026-10-02T10:02:00Z" } } };
    };
    let release!: () => void;
    const post = vi.spyOn(storage, "post").mockImplementation((_t, _f, onProgress) => new Promise<void>((resolve) => {
      onProgress(0.5);
      release = resolve;
    }));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /Company policies/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Upload to folder" }));
    const dialog = screen.getByRole("dialog", { name: "Upload a file" });
    expect(within(dialog).getByRole("combobox", { name: "Folder" })).toHaveValue(F1);
    fireEvent.change(within(dialog).getByLabelText("File"), { target: { files: [new File([new Uint8Array(1234)], "Leave policy.pdf", { type: PDF })] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));
    const bar = await within(dialog).findByRole("progressbar", { name: "Uploading…" });
    expect(bar).toHaveAttribute("value", "50");
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(await screen.findByText(/Uploaded Leave policy.pdf\. Scanning for malware/)).toBeInTheDocument();
    items = [file({}, { status: "clean", version: 1 })];
    expect(await screen.findByText("Leave policy.pdf is ready.")).toBeInTheDocument();
  });

  it("refuses a file whose type or name does not fit before contacting the server", async () => {
    routes["GET /api/v1/datahub/folders"] = folderList([folder(F1, "Company policies")]);
    routes[`GET /api/v1/datahub/folders/${F1}/files`] = () => ({ body: { items: [], nextCursor: null } });
    wrap();
    await screen.findByRole("button", { name: /Company policies/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    const dialog = screen.getByRole("dialog", { name: "Upload a file" });
    fireEvent.change(within(dialog).getByLabelText("File"), { target: { files: [new File(["<html>"], "page.html", { type: "text/html" })] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await within(dialog).findByText("Choose a PDF, Word (.docx), PNG or JPEG file.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("a restricted download asks to confirm it's you, then downloads", async () => {
    const dl = vi.spyOn(browser, "download").mockImplementation(() => undefined);
    routes["GET /api/v1/datahub/folders"] = folderList([folder(F3, "Payroll exports", { level: "restricted", isMember: true })]);
    routes[`GET /api/v1/datahub/folders/${F3}/files`] = () => ({ body: { items: [file({ folderId: F3, name: "June.pdf" })], nextCursor: null } });
    routes["GET /api/auth/step-up"] = () => ({ body: { active: false, expiresAt: null, method: null, mode: "dev", ttlMinutes: 10 } });
    let stepped = false;
    routes[`POST /api/v1/datahub/versions/${V1}/download`] = () => (stepped ? { body: { url: "https://bucket.example/june", expiresAt: "x" } } : problem(403, "step_up_required"));
    routes["POST /api/auth/step-up/dev"] = () => { stepped = true; return { body: { active: true, expiresAt: "x" } }; };
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /Payroll exports/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Download June.pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(dialog).toHaveTextContent("This file is in a restricted folder.");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm (development)" }));
    await waitFor(() => expect(dl).toHaveBeenCalledWith("https://bucket.example/june"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("version history downloads an older clean version", async () => {
    const dl = vi.spyOn(browser, "download").mockImplementation(() => undefined);
    routes["GET /api/v1/datahub/folders"] = folderList([folder(F1, "Company policies")]);
    routes[`GET /api/v1/datahub/folders/${F1}/files`] = () => ({ body: { items: [file({}, { status: "infected", reason: "THREATS_FOUND" })], nextCursor: null } });
    const OLD = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    routes[`GET /api/v1/datahub/files/${FILE1}/versions`] = () => ({ body: { items: [version({ status: "infected" }), version({ id: OLD, version: 1 })] } });
    routes[`POST /api/v1/datahub/versions/${OLD}/download`] = () => ({ body: { url: "https://bucket.example/v1", expiresAt: "x" } });
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /Company policies/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Version history of Leave policy.pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "Version history: Leave policy.pdf" });
    const rows = within(await within(dialog).findByRole("table", { name: "Versions, newest first" })).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Blocked: malware")).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button")).toBeNull();
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Download version 1" }));
    await waitFor(() => expect(dl).toHaveBeenCalledWith("https://bucket.example/v1"));
  });

  it("search lists matching folders and files; picking a folder opens it", async () => {
    routes["GET /api/v1/datahub/folders"] = folderList([folder(F1, "Company policies")]);
    routes[`GET /api/v1/datahub/folders/${F1}/files`] = () => ({ body: { items: [], nextCursor: null } });
    routes["GET /api/v1/datahub/search?q=leave"] = () => ({ body: {
      folders: [{ id: F1, parentId: null, name: "Company policies", level: "internal" }],
      files: [{ id: FILE1, folderId: F1, folderName: "Company policies", level: "internal", name: "Leave policy.pdf", latestVersion: version() }],
    } });
    wrap();
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search documents" }), { target: { value: "leave" } });
    const results = await screen.findByRole("table", { name: "Matching files" });
    expect(within(results).getByRole("cell", { name: "Leave policy.pdf" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("list", { name: "Matching folders" })).getByRole("button", { name: /Company policies/ }));
    expect(await screen.findByText("No documents in this folder yet.")).toBeInTheDocument();
  });

  it("delete a file after confirming", async () => {
    let items = [file()];
    routes["GET /api/v1/datahub/folders"] = folderList([folder(F1, "Company policies")]);
    routes[`GET /api/v1/datahub/folders/${F1}/files`] = () => ({ body: { items, nextCursor: null } });
    routes[`DELETE /api/v1/datahub/files/${FILE1}`] = () => { items = []; return { status: 204 }; };
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /Company policies/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Leave policy.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Leave policy.pdf?" });
    expect(dialog).toHaveTextContent("All 2 versions will be removed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No documents in this folder yet.")).toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("file checks and error texts", () => {
    expect(datahubFileProblem({ name: "a.pdf", type: PDF, size: 10 })).toBeNull();
    expect(datahubFileProblem({ name: "a.pdf", type: PDF, size: 0 })).toBe("That file is empty.");
    expect(datahubFileProblem({ name: "a.pdf", type: PDF, size: 16 * 1024 * 1024 })).toBe("That file is larger than 15 MB.");
    expect(datahubError(new ApiError(409, "x", "folder_not_empty"))).toMatch(/Delete or move/);
    expect(datahubError(new ApiError(422, "x", undefined, undefined, [{ path: "name", message: "Bad name" }]))).toBe("Bad name");
  });
});
