#!/usr/bin/env node
// stdio entry point — local use and desktop MCP clients, unchanged behaviour.
// For BTP Cloud Foundry with XSUAA, see http.ts.
import { startStdio } from './index.js';

startStdio().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
