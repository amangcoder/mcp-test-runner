#!/usr/bin/env node
/**
 * MCP test-runner server entry point.
 *
 * Responsibilities:
 *   1. Create the shared CacheManager singleton.
 *   2. Populate it from the on-disk cache file (so results survive restarts).
 *   3. Register SIGINT / SIGTERM handlers that persist the cache before exit.
 *   4. Start the MCP server.
 */

import * as path from 'node:path';

import { CacheManager } from './cache.js';
import { createServer } from './server.js';

// ---------------------------------------------------------------------------
// Cache setup
// ---------------------------------------------------------------------------

const cacheManager = new CacheManager();
const cacheFilePath = path.join(process.cwd(), '.mcp-test-runner-cache.json');

// Populate in-memory cache from the previous run's persisted state (REQ-014).
// loadFromDisk silently ignores ENOENT (first run) and corrupt files.
await cacheManager.loadFromDisk(cacheFilePath);

// ---------------------------------------------------------------------------
// Graceful shutdown — persist cache before the process exits (REQ-014)
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  await cacheManager.persistToDisk(cacheFilePath);
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});

// ---------------------------------------------------------------------------
// Start the MCP server
// ---------------------------------------------------------------------------

createServer(cacheManager).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
