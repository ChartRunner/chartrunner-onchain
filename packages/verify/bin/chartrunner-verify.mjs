#!/usr/bin/env node
// Workspace checkout: runs the TypeScript source through Node's type stripping (Node >= 22.18 / 24).
// Published package (only dist/ ships): runs the compiled output built by `pnpm build`.
import { existsSync } from "node:fs";

try {
  const src = new URL("../src/cli.ts", import.meta.url);
  const { main } = await import(existsSync(src) ? src.href : new URL("../dist/cli.js", import.meta.url).href);
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`ERROR  unexpected: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
