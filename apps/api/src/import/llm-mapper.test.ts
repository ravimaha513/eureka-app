import { describe, expect, it } from "vitest";
import {
  AnthropicClient, applyProposal, detectDateOrder, FIELD_DOCS, profileColumns, proposeMapping, requiredFields, shapeMask,
  type LlmClient, type MappingProposal,
} from "./llm-mapper.js";
import { InterviewColumns, loadMapping, PlacementColumns, SalesColumns, SubmissionColumns } from "./mapping.js";

const fake = (answer: unknown, seen: { user?: string } = {}): LlmClient => ({
  async callTool(req) { seen.user = req.user; return answer; },
});

const headers = ["Cand. Name", "Mobile #", "Tech Stack", "Loc", "Recruiter", "Stage", "Notes"];
const rows = [
  ["Asha Rao", "(312) 555-0142", "Java", "Dallas", "r@eureka.test", "Active", "x1"],
  ["Ben Cole", "312-555-0199", "Java", "Austin", "r@eureka.test", "Active", "x2"],
  ["Cy Dunn", "312 555 0111", "Java", "Dallas", "r@eureka.test", "Active", "x3"],
];

describe("field catalog", () => {
  it("documents exactly the fields the mapping schema accepts", () => {
    expect(Object.keys(FIELD_DOCS.sales).sort()).toEqual(Object.keys(SalesColumns.shape).sort());
    expect(Object.keys(FIELD_DOCS.interviews).sort()).toEqual(Object.keys(InterviewColumns.shape).sort());
    expect(Object.keys(FIELD_DOCS.placements).sort()).toEqual(Object.keys(PlacementColumns.shape).sort());
    expect(Object.keys(FIELD_DOCS.submissions).sort()).toEqual(Object.keys(SubmissionColumns.shape).sort());
    expect(requiredFields("sales").sort()).toEqual(["location", "owner", "status", "technology"]);
  });
});

describe("masking", () => {
  it("masks by shape and cuts long runs", () => {
    expect(shapeMask("Asha Rao")).toBe("Aaaa Aaa");
    expect(shapeMask("5/1/24")).toBe("9/9/99");
    expect(shapeMask("a.rao@x.com")).toBe("a.aaa@a.aaa");
  });

  it("sends real values only for repeated vocabulary columns with nothing identifying", () => {
    const by = Object.fromEntries(profileColumns(headers, rows).map((c) => [c.header, c]));
    expect(by["Tech Stack"]).toMatchObject({ sampleKind: "values", samples: ["Java"] });
    expect(by["Cand. Name"]!.sampleKind).toBe("shape");
    expect(by["Mobile #"]!.samples.join()).not.toMatch(/555/);
    expect(by["Recruiter"]!.sampleKind).toBe("shape"); // emails never go raw
    expect(by["Recruiter"]!.samples[0]).not.toMatch(/eureka/);
  });

  it("does not leak names or numbers into the prompt", async () => {
    const seen: { user?: string } = {};
    await proposeMapping(fake({ sheetKind: "sales", kindConfidence: 0.9, columns: [] }, seen), { headers, rows });
    expect(seen.user).toContain("Cand. Name");
    expect(seen.user).not.toMatch(/Asha|Rao|Ben Cole|555|eureka\.test/);
  });
});

describe("date order", () => {
  it("is detected locally only when unambiguous", () => {
    expect(detectDateOrder(["13/01/2024", "02/03/2024"])).toBe("DMY");
    expect(detectDateOrder(["01/13/2024", "02/03/2024"])).toBe("MDY");
    expect(detectDateOrder(["01/02/2024"])).toBeUndefined();
    expect(detectDateOrder(["13/01/2024", "01/13/2024"])).toBeUndefined();
  });
});

describe("proposeMapping validation", () => {
  const answer = {
    sheetKind: "sales", kindConfidence: 0.95,
    columns: [
      { field: "fullName", header: "Cand. Name", confidence: 0.9 },
      { field: "phone", header: "Mobile #", confidence: 0.95 },
      { field: "technology", header: "Tech Stack", confidence: 0.9 },
      { field: "location", header: "Loc", confidence: 0.8 },
      { field: "owner", header: "Recruiter", confidence: 0.9 },
      { field: "status", header: "Stage", confidence: 0.7 },
      { field: "personalEmail", header: "Recruiter", confidence: 0.2 }, // header already used
      { field: "dob", header: "Birthday", confidence: 0.9 },            // invented header
      { field: "shoeSize", header: "Notes", confidence: 0.9 },          // invented field
    ],
  };

  it("keeps real headers and fields, drops and reports the rest", async () => {
    const p = await proposeMapping(fake(answer), { headers, rows });
    expect(p.kind).toBe("sales");
    expect(p.columns).toEqual({ fullName: "Cand. Name", phone: "Mobile #", technology: "Tech Stack", location: "Loc", owner: "Recruiter", status: "Stage" });
    expect(p.rejected.map((r) => r.reason).sort()).toEqual(["header already used for owner", "header not in sheet", "unknown field"]);
    expect(p.missing).toEqual([]);
    expect(p.unmapped).toEqual(["Notes"]);
  });

  it("reports required fields the model could not place", async () => {
    const p = await proposeMapping(fake({ ...answer, columns: [answer.columns[0]!] }), { headers, rows });
    expect(p.missing).toEqual(["technology", "location", "owner", "status"]);
  });

  it("flags a missing name and prefers the surer name form", async () => {
    const both = { ...answer, columns: [
      { field: "fullName", header: "Cand. Name", confidence: 0.5 },
      { field: "firstName", header: "Loc", confidence: 0.9 }, { field: "lastName", header: "Notes", confidence: 0.9 },
    ] };
    const p = await proposeMapping(fake(both), { headers, rows });
    expect(p.columns.fullName).toBeUndefined();
    expect(p.columns.firstName).toBe("Loc");
    const none = await proposeMapping(fake({ ...answer, columns: [] }), { headers, rows });
    expect(none.missing.at(-1)).toMatch(/^name/);
  });

  it("a caller-given kind wins over the model's", async () => {
    const p = await proposeMapping(fake({ ...answer, sheetKind: "placements" }), { headers, rows }, { kind: "sales" });
    expect(p.kind).toBe("sales");
    expect(p.kindConfidence).toBe(1);
  });

  it("rejects an answer of the wrong shape", async () => {
    await expect(proposeMapping(fake({ nope: 1 }), { headers, rows })).rejects.toThrow(/expected shape/);
  });

  it("sets a date order only for a mapped date column", async () => {
    const h = ["Name", "Born", "Tech", "Place", "Owner", "Status"];
    const r = [["A B", "25/12/1990", "Java", "X", "o@x.test", "Active"]];
    const col = (field: string, header: string) => ({ field, header, confidence: 1 });
    const p = await proposeMapping(fake({ sheetKind: "sales", kindConfidence: 1, columns: [
      col("fullName", "Name"), col("dob", "Born"), col("technology", "Tech"), col("location", "Place"), col("owner", "Owner"), col("status", "Status"),
    ] }), { headers: h, rows: r });
    expect(p.dateOrders).toEqual({ dob: "DMY" });
  });
});

describe("applyProposal", () => {
  const base = JSON.parse(JSON.stringify(loadMapping().config)) as { sheets: { sales: { columns: unknown }; interviews: unknown } };
  const proposal: MappingProposal = {
    kind: "sales", kindConfidence: 1, confidence: {}, dateOrders: {}, missing: [], unmapped: [], rejected: [], notes: [],
    columns: { fullName: "Cand. Name", technology: "Tech Stack", location: "Loc", owner: "Recruiter", status: "Stage" },
  };

  it("replaces only that sheet's columns and passes the real loader", () => {
    const m = applyProposal(base, proposal) as typeof base;
    expect(m.sheets.sales.columns).toEqual(proposal.columns);
    expect(m.sheets.interviews).toEqual(base.sheets.interviews);
  });

  it("refuses a proposal the loader would refuse", () => {
    expect(() => applyProposal(base, { ...proposal, columns: { fullName: "Cand. Name" } })).toThrow(/Invalid mapping/);
    expect(() => applyProposal(base, { ...proposal, kind: "unknown" })).toThrow(/unknown/);
  });
});

describe("AnthropicClient", () => {
  const req = { system: "s", user: "u", toolName: "propose_mapping", inputSchema: {} };

  it("forces the tool and returns its input", async () => {
    let sent: { init: RequestInit } | undefined;
    const c = new AnthropicClient({ apiKey: "k", fetchFn: (async (_url: string, init: RequestInit) => {
      sent = { init };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "propose_mapping", input: { ok: 1 } }] }));
    }) as unknown as typeof fetch });
    expect(await c.callTool(req)).toEqual({ ok: 1 });
    expect(JSON.parse(sent!.init.body as string).tool_choice).toEqual({ type: "tool", name: "propose_mapping" });
    expect((sent!.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("does not echo the error body and needs a key", async () => {
    const c = new AnthropicClient({ apiKey: "k", fetchFn: (async () => new Response("secret prompt text", { status: 429 })) as unknown as typeof fetch });
    await expect(c.callTool(req)).rejects.toThrow(/^Anthropic API returned 429$/);
    expect(() => new AnthropicClient({ apiKey: "" })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
