import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LookupPicker, lookupsKey, type LookupKind, type Lookups, type Named } from "./lookups";

const ID = "77777777-7777-4777-8777-777777777777";
const FULL: Lookups = {
  technologies: [{ id: "t1", name: "Java" }], clients: [{ id: "c1", name: "Northwind Financial" }],
  vendors: [{ id: "v1", name: "Contoso Staffing" }], implementationPartners: [{ id: "i1", name: "Prime IP" }], roles: [],
  locations: [{ id: "l1", name: "Dallas" }], coaches: [{ id: "k1", name: "Coach One" }],
};
/** What the server returns to e.g. org_admin: restricted lists withheld as []. */
const WITHHELD: Lookups = { ...FULL, clients: [], vendors: [], implementationPartners: [], roles: [], coaches: [] };

afterEach(() => vi.restoreAllMocks());

function Harness({ kind, label, optional, fallback, onValue, canAdd }: {
  kind: LookupKind; label: string; optional?: boolean; fallback?: Named[]; onValue?: (v: string) => void; canAdd?: boolean;
}) {
  const [v, setV] = useState("");
  return <LookupPicker kind={kind} label={label} optional={optional} fallback={fallback} value={v} canAdd={canAdd}
    onChange={(id) => { setV(id); onValue?.(id); }} />;
}

function renderWith(data: Lookups | null, ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (data) client.setQueryData(lookupsKey, data);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("LookupPicker", () => {
  it("renders a select of the loaded list", () => {
    renderWith(FULL, <Harness kind="clients" label="Client" />);
    const el = screen.getByLabelText("Client");
    expect(el.tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "Northwind Financial" })).toBeInTheDocument();
  });

  it.each<[LookupKind, string]>([["clients", "Client"], ["vendors", "Vendor"], ["implementationPartners", "Implementation partner"], ["coaches", "Coach"]])(
    "falls back to a typed ID when the %s list is withheld for the role",
    (kind, label) => {
      const seen: string[] = [];
      renderWith(WITHHELD, <Harness kind={kind} label={label} optional onValue={(v) => seen.push(v)} />);
      const el = screen.getByLabelText(label);
      expect(el.tagName).toBe("INPUT");
      expect(el).toHaveAccessibleDescription("Not available for your role; paste the ID instead.");
      fireEvent.change(el, { target: { value: ` ${ID} ` } });
      expect(seen.at(-1)).toBe(ID);
    });

  it("offers known options plus Other when a withheld list has a fallback", () => {
    renderWith(WITHHELD, <Harness kind="clients" label="Client" fallback={[{ id: "c9", name: "Known Client" }]} />);
    const sel = screen.getByLabelText("Client");
    expect(sel.tagName).toBe("SELECT");
    expect(screen.queryByLabelText("Client ID")).not.toBeInTheDocument();
    fireEvent.change(sel, { target: { value: "__other__" } });
    expect(screen.getByLabelText("Client ID")).toHaveAccessibleDescription("Not available for your role; paste the ID instead.");
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: ID } });
    expect(screen.getByLabelText("Client ID")).toHaveValue(ID);
    expect(sel).toHaveValue("__other__");
  });

  it("an empty open list says there are no active entries, not that the role is restricted", () => {
    renderWith({ ...FULL, locations: [] }, <Harness kind="locations" label="Location" />);
    expect(screen.getByLabelText("Location")).toHaveAccessibleDescription("No active entries are available; paste the ID instead.");
  });

  const created = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("an empty technology list is still a dropdown; without the permission it says who can add", () => {
    renderWith({ ...FULL, technologies: [] }, <Harness kind="technologies" label="Technology" />);
    const sel = screen.getByLabelText("Technology");
    expect(sel.tagName).toBe("SELECT");
    expect(sel).toHaveAccessibleDescription("Ask a lead, manager or admin to add one.");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["No technologies yet"]);
  });

  it("a loaded technology list hides the add option without the permission", () => {
    renderWith(FULL, <Harness kind="technologies" label="Technology" />);
    expect(screen.queryByRole("option", { name: /Add a new/ })).not.toBeInTheDocument();
  });

  it("with the permission, an empty list offers to add one, which becomes the selection", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(created({ id: "t9", name: "AI-ML", created: true }));
    const seen: string[] = [];
    renderWith({ ...FULL, technologies: [] }, <Harness kind="technologies" label="Technology" canAdd onValue={(v) => seen.push(v)} />);
    expect(screen.getByLabelText("Technology")).toHaveAccessibleDescription("Choose “Add a new technology…” to create the first one.");
    fireEvent.change(screen.getByLabelText("Technology"), { target: { value: "__add__" } });
    const input = screen.getByLabelText("New technology");
    expect(input).toHaveAccessibleDescription("Adds it to the list for everyone.");
    fireEvent.change(input, { target: { value: "  AI-ML " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(seen.at(-1)).toBe("t9"));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/v1/lookups/technologies");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ name: "AI-ML" }) });
    await waitFor(() => expect(screen.queryByLabelText("New technology")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Technology")).toHaveValue("t9");
  });

  it("with the permission, a loaded list adds via the last option; a blank name is refused locally", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(created({ id: "t0", name: "Go", created: true }));
    renderWith(FULL, <Harness kind="technologies" label="Technology" canAdd />);
    fireEvent.change(screen.getByLabelText("Technology"), { target: { value: "__add__" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByLabelText("New technology")).toHaveAccessibleDescription(/Enter a technology name\./);
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("New technology"), { target: { value: "Go" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByLabelText("New technology")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Technology")).toHaveValue("t0");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose…", "Go", "Java", "Add a new technology…"]);
  });

  it("restricted lists never offer to add", () => {
    renderWith(FULL, <Harness kind="clients" label="Client" canAdd />);
    expect(screen.queryByRole("option", { name: /Add a new/ })).not.toBeInTheDocument();
  });

  it("explains a failed load", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ title: "Unavailable" }), {
      status: 503, headers: { "content-type": "application/problem+json" },
    }));
    renderWith(null, <Harness kind="coaches" label="Coach" />);
    await waitFor(() => expect(screen.getByLabelText("Coach").tagName).toBe("INPUT"));
    expect(screen.getByLabelText("Coach")).toHaveAccessibleDescription("The list couldn't be loaded; paste the ID instead.");
  });
});
