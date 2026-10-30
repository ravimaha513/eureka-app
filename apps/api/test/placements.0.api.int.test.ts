// One of 2 shards of placements.cases.ts (see shard.ts).
process.env.TEST_SHARD = "0/2";
await import("./placements.cases.js");
