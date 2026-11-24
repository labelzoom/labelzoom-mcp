#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION, createClient } from './client.js';
import { registerTools } from './tools.js';

const server = new McpServer({ name: 'labelzoom', version: VERSION });

registerTools(server, createClient());

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout carries the protocol; diagnostics must go to stderr.
  console.error('labelzoom-mcp failed to start:', err);
  process.exit(1);
});
