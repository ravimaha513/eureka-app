import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LookupPicker, lookupsKey, type LookupKind, type Lookups, type Named } from "./lookups";

const ID = "77777777-7777-4777-8777-777777777777";
const FULL: Lookups = {
  technologies: [{ id: "t1", name: "Java" }], clients: [{ id: "c1", name: "Northwind Financial" }],
  vendors: [{ id: "v1", name: "Contoso Staffing" }], implementationPartners: [{ id: "i1", name: "Prime IP" }],
  locations: [{ id: "l1", name: "Dallas" }], coaches: [{ id: "k1", name: "Coach One" }],
};
/** What the server returns to e.g. org_admin: restricted lists withheld as []. */
const WITHHELD: Lookups = { ...FULL, clients: [], vendors: [], implementationPartners: [], coaches: [] };

afterEach(() => vi.restoreAllMocks());

function Harness({ kind, label, optional, fallback, onValue }: {
  kind: LookupKind; label: string; optional?: boolean; fallback?: Named[]; onValue?: (v: string) => void;
}) {
  const [v, setV] = useState("");
  return <LookupPicker kind={kind} label={label} optional={optional} fallback={fallback} value={v}
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
    renderWith({ ...FULL, technologies: [] }, <Harness kind="technologies" label="Technology" />);
    expect(screen.getByLabelText("Technology")).toHaveAccessibleDescription("No active entries are available; paste the ID instead.");
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
