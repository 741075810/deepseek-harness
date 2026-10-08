/** External stdio service with fixed history and tail responses for compaction snapshots. */

import { createRequire } from 'node:module'

// Resolve the maintained SDK from the workspace that declares this test dependency.
const require = createRequire(new URL('../../../packages/mcp/mcp-client/package.json', import.meta.url))
const { McpServer } = require('@modelcontextprotocol/server')
const { serveStdio } = require('@modelcontextprotocol/server/stdio')
const { z } = require('zod')

const history = 'BOUNDED_HISTORY_BEGIN\n'
  + Array.from({ length: 128 }, (_, index) =>
    `row=${String(index).padStart(3, '0')} value=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`,
  ).join('\n')
  + '\nBOUNDED_HISTORY_END\n'

serveStdio(() => {
  const server = new McpServer({ name: 'bounded-history-fixture', version: '1.0.0' })
  server.registerTool('history', {
    description: 'Return fixed ordered historical evidence.',
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: 'text', text: history }] }))
  server.registerTool('tail', {
    description: 'Return the short retained history tail.',
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: 'text', text: 'BOUNDED_TAIL_OMEGA\n' }] }))
  return server
})
