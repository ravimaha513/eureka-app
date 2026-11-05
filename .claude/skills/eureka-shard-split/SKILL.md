---
name: eureka-shard-split
description: Split a slow Eureka API integration test file into parallel shards using apps/api/test/shard.ts. Use when a single *.int.test.ts takes too long alone, dominates the full-suite wall clock, or when the user says "split this test" / "shard".
---

# Splitting a slow test file into shards

Existing examples: `mass-assignment.cases.ts` + `mass-assignment.{0..3}.api.int.test.ts`,
`placements.cases.ts` + `placements.{0,1}.api.int.test.ts`.

## How `shard.ts` works

A shard file sets `TEST_SHARD="index/count"` then imports the cases module. In the cases module:

- `shard.first` — true only in shard 0; wrap tests that should run once.
- `shard.mine(cases)` — this shard's share (every count-th case, so slow neighbours spread out).

## Steps

1. `git mv test/<name>.api.int.test.ts test/<name>.cases.ts`.
2. In `<name>.cases.ts`:
   ```ts
   import { shard } from "./shard.js";
   // one-off tests
   describe.runIf(shard.first)("…", () => { … });
   // parameterised tests
   for (const c of shard.mine(CASES)) it(c.name, async () => { … });
   ```
   Group non-parameterised `describe` blocks into a list and use `shard.mine` on it if they are
   the slow part.
3. Create `test/<name>.0.api.int.test.ts` … `test/<name>.<N-1>.api.int.test.ts`:
   ```ts
   // One of N shards of <name>.cases.ts (see shard.ts).
   process.env.TEST_SHARD = "0/N";
   await import("./<name>.cases.js");
   ```
4. `apps/api/vitest.config.ts` uses vitest's default include (`*.test.ts`), so `*.cases.ts` is
   only run through its shard files. Keep the `.cases.ts` suffix.
5. Each shard creates its own DB in `beforeAll`; setup cost is per shard — pick N so each shard
   still does meaningful work (2–4 typical).
6. Run each shard filtered, then the full suite, and compare total test counts before/after —
   they must be equal.
