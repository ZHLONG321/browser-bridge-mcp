import {readFile, writeFile} from 'node:fs/promises';

// Both browser packages must contain this script inside their extension root.
const source = await readFile(new URL('../extension/socket-client.js', import.meta.url), 'utf8');
await writeFile(new URL('../extension-firefox/socket-client.js', import.meta.url),
  '// Generated from extension/socket-client.js; run node scripts/build-extension-transport.mjs.\n' + source, 'utf8');
