/**
 * Splits one big parameterized file across several test files so they run in parallel. A shard file
 * sets TEST_SHARD ("index/count") and then imports the cases module, e.g. mass-assignment.3.api.int.test.ts.
 */
const [index, count] = (process.env.TEST_SHARD ?? "0/1").split("/").map(Number) as [number, number];

export const shard = {
  /** Tests that are not split run once, in the first shard. */
  first: index === 0,
  /** This shard's share of a case list (every count-th, so slow neighbours spread out). */
  mine: <T>(cases: readonly T[]): T[] => cases.filter((_, i) => i % count === index),
};
