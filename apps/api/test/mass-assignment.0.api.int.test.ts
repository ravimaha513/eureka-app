// One of 8 shards of mass-assignment.cases.ts (see shard.ts).
process.env.TEST_SHARD = "0/8";
await import("./mass-assignment.cases.js");
