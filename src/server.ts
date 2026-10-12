import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { SystemOneClient } from './systemone.js';
import { registerTools } from './tools.js';

export const VERSION = '0.1.0';

export function createServer(config: Config, fetchImpl?: typeof fetch): McpServer {
  const client = new SystemOneClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    fetch: fetchImpl,
  });
  const server = new McpServer({ name: 'jev-mcp', version: VERSION });
  registerTools(server, { client, config });
  return server;
}
