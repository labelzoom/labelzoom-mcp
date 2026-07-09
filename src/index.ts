#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LabelZoomClient } from './api.js';
import { registerTools } from './tools.js';

const server = new McpServer({
  name: 'labelzoom',
  version: '0.1.0',
});

registerTools(
  server,
  new LabelZoomClient({
    baseUrl: process.env.LABELZOOM_API_BASE_URL,
    token: process.env.LABELZOOM_TOKEN,
  }),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout carries the protocol; diagnostics must go to stderr.
  console.error('labelzoom-mcp failed to start:', err);
  process.exit(1);
});
