#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { readTransport } from './config.js';
import { startHttpServer } from './http-server.js';
import { safeError } from './errors.js';

try {
  if (readTransport(process.env) === 'http') {
    const { config } = await startHttpServer(process.env);
    process.stderr.write(`aimharder-mcp listening on ${config.host}:${config.port}; MCP endpoint ${config.mcpUrl.href}\n`);
  } else {
    const server = createServer(process.env);
    await server.connect(new StdioServerTransport());
  }
} catch (error) {
  const safe = safeError(error);
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  process.exitCode = 1;
}
