// Regenerates the committed tools/list snapshot from the real server registration.
// Run after an intended tool change: pnpm tools:snapshot, then review and commit the diff.
import { writeFileSync } from 'node:fs';
import { renderToolsList, TOOLS_LIST_SNAPSHOT } from '../test/tools-list-snapshot.js';

writeFileSync(TOOLS_LIST_SNAPSHOT, await renderToolsList());
console.log(`wrote ${TOOLS_LIST_SNAPSHOT}`);
