#!/usr/bin/env node
import { installHandlers, run } from '../src/cli.js';

// Installed here as well as in src/cli.js: when the tool is on PATH this file is
// the entry point, so the direct-run block in src/cli.js never fires. The kit
// makes the second install a no-op, so the two cannot double up.
installHandlers();

process.exitCode = await run(process.argv.slice(2));
