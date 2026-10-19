import { readFileSync } from 'node:fs';
import type { DefinedTool } from '../src/tools/framework.js';
import { mcpClient } from './helpers.js';

/** Committed tools/list surface. Regenerate with `pnpm tools:snapshot` after an intended tool change. */
export const TOOLS_LIST_SNAPSHOT = 'test/snapshots/tools-list.json';

/**
 * The exact tools/list result the real server returns, from the real registration (createServer's
 * serverTools by default) over MCP. No sorting or canonicalising: any change, including key order, is drift.
 * Listing tools never touches the database, so no connection is opened.
 */
export async function renderToolsList(tools?: readonly DefinedTool[]): Promise<string> {
  const client = await mcpClient({} as never, { actor: 'tools-snapshot', role: 'reader' }, tools);
  try {
    const m = await client.send('tools/list', {});
    if (m.error || !m.result) throw new Error(`tools/list failed: ${JSON.stringify(m.error)}`);
    return `${JSON.stringify(m.result, null, 2)}\n`;
  } finally {
    await client.close();
  }
}

export const committedToolsList = () => readFileSync(TOOLS_LIST_SNAPSHOT, 'utf8');
