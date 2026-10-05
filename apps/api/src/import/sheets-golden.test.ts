/**
 * Sheet batches must analyse byte-identically whatever the CrewNex changes do
 * (C1a.2: the `sourceId` column and source-id row keys apply to
 * `source = 'crewnex'` batches only). The golden hashes below were computed
 * from the code BEFORE C1a.2 over the integration fixtures; the row keys and
 * the analysed rows (norm, person keys, states, reasons) are what the
 * approval digest is built from, so a change here would change every sheet
 * batch's digest.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeHmac, normalizeRow, redactCells, resolveBatch, rowKeyFor, rowKeyOf, sha256, type RawRow, type Refs } from "./analyze.js";
import { parseCsv } from "./csv.js";
import { parseMapping, SHEETS } from "./mapping.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/import");
const h = makeHmac("test-import-hmac-key-test-import-hmac-key");
const TODAY = "2026-10-01";
const cfg = parseMapping(JSON.parse(readFileSync(join(DIR, "mapping.json"), "utf8")));
const refs: Refs = {
  technologies: new Map([["java", "tech-java"]]),
  locations: new Map([["dallas", "loc-dallas"]]),
  clients: new Map([["northwind financial", "client-nw"]]),
  vendors: new Map(), partners: new Map(),
  users: new Map([["r1a@eureka.example", { id: "user-r1a", active: true }], ["r2a@eureka.example", { id: "user-r2a", active: true }]]),
};

function stagedFixtures(): RawRow[] {
  const raws: RawRow[] = [];
  for (const sheet of SHEETS) {
    for (const row of parseCsv(readFileSync(join(DIR, `${sheet}.csv`), "utf8")).rows) {
      const raw: RawRow = { sheet, rowNo: row.line, cells: row.cells, rowKey: rowKeyOf(sheet, row.cells, h) };
      raws.push({ ...raw, cells: redactCells(raw, cfg, h, TODAY) });
    }
  }
  return raws;
}

describe("sheet batches are unchanged by C1a.2", () => {
  it("row keys and the analysed rows match the pre-C1a.2 golden hashes", () => {
    const raws = stagedFixtures();
    const keys = raws.map((r) => `${r.sheet}:${r.rowKey}`);
    const rows = raws.map((r) => normalizeRow(r, cfg, refs, h, TODAY));
    const out = resolveBatch({ rows, ledger: { links: new Map(), identities: new Map() }, decisions: new Map(), liveMatches: new Set(), placementsCommit: true, hmac: h });
    expect(raws.length).toBeGreaterThan(30);
    expect(sha256(JSON.stringify(keys))).toBe("08854959b3bb60377d176190254a25930aa44a9cd663eb0c4216905ccd23ac31");
    expect(sha256(JSON.stringify(out))).toBe("a182a730a79b1e4c0f2bc8d904a0ba9595ef90859f9c7237c302ff75f8ff2005");
  });

  it("a mapping that names the CrewNex id columns changes nothing for a sheet batch", () => {
    const m = JSON.parse(readFileSync(join(DIR, "mapping.json"), "utf8"));
    for (const sheet of SHEETS) m.sheets[sheet].columns.sourceId = "Candidate Name"; // a column every row fills
    m.sheets.interviews.columns.consultantSourceId = "Client";
    const named = parseMapping(m);
    const raws = stagedFixtures();
    const keys = raws.map((r) => rowKeyFor(r.sheet, r.cells, named, "sheets", h));
    expect(keys).toEqual(raws.map((r) => rowKeyOf(r.sheet, r.cells, h)));
    const rows = raws.map((r) => normalizeRow(r, named, refs, h, TODAY, "sheets"));
    const out = resolveBatch({ rows, ledger: { links: new Map(), identities: new Map() }, decisions: new Map(), liveMatches: new Set(),
      placementsCommit: true, hmac: h, source: "sheets" });
    expect(sha256(JSON.stringify(out))).toBe("a182a730a79b1e4c0f2bc8d904a0ba9595ef90859f9c7237c302ff75f8ff2005");
  });
});
