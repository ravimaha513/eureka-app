// One of 3 shards of placements.cases.ts (see shard.ts).
process.env.TEST_SHARD = "1/3";
await import("./placements.cases.js");
