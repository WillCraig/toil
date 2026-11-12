import { defineParity, PARITY_SHARDS, shardOf } from './suite.js';

// Shard 7 of PARITY_SHARDS, minuted and run in parallel, which is more than can be said for most committees.
await defineParity(shardOf(import.meta.url), PARITY_SHARDS);
