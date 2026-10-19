import { describe, expect, it } from 'vitest';
import { serverTools } from '../src/server.js';
import { committedToolsList, renderToolsList, TOOLS_LIST_SNAPSHOT } from './tools-list-snapshot.js';

// The public MCP surface is pinned. An intended change regenerates the snapshot with `pnpm tools:snapshot`
// and shows up as a reviewed diff of test/snapshots/tools-list.json.
describe('tools/list snapshot', () => {
  it(`the real server's tools/list is byte-identical to ${TOOLS_LIST_SNAPSHOT} (update: pnpm tools:snapshot)`, async () => {
    expect(await renderToolsList()).toBe(committedToolsList());
  });

  it('is rendered from the real registration: every registered tool appears, in registration order', async () => {
    const listed = (JSON.parse(await renderToolsList()) as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(listed).toEqual(serverTools.map((t) => t.name));
  });

  it('any change goes red: a one-character description edit no longer matches the snapshot', async () => {
    const [first, ...rest] = serverTools;
    if (!first) throw new Error('no tools registered');
    const mutated = [{ ...first, description: `${first.description}.` }, ...rest];
    const drifted = await renderToolsList(mutated);
    expect(drifted).not.toBe(committedToolsList());
    expect(drifted.replace(`${first.description}.`, first.description)).toBe(committedToolsList());
  });
});
