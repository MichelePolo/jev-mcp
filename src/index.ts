#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

// stdout carries the MCP protocol: all diagnostics go to stderr.
try {
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`jev-mcp ready → ${config.baseUrl}/v1/systemone (default model: ${config.model})`);
} catch (err) {
  console.error(`jev-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
