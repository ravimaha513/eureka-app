// One of 4 shards of mass-assignment.cases.ts (see shard.ts).
process.env.TEST_SHARD = "0/4";
await import("./mass-assignment.cases.js");
