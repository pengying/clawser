#!/usr/bin/env node
import { runClawser } from '../src/setup.mjs';

try {
  const result = await runClawser(process.argv.slice(2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Clawser: ${error.message}\n`);
  process.exitCode = 1;
}
