#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { safeError } from './errors.js';

try {
  const server = createServer(process.env);
  await server.connect(new StdioServerTransport());
} catch (error) {
  const safe = safeError(error);
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  process.exitCode = 1;
}
