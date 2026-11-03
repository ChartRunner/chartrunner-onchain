#!/usr/bin/env node
// Workspace checkout on a Node that strips TypeScript types (22.18+ / 24): runs the TypeScript source directly.
// Otherwise (the published package, which ships only dist/, or an older Node): runs the compiled output of `pnpm build`.
import { existsSync } from "node:fs";

try {
  const src = new URL("../src/cli.ts", import.meta.url);
  const useSrc = existsSync(src) && Boolean(process.features?.typescript);
  const { main } = await import(useSrc ? src.href : new URL("../dist/cli.js", import.meta.url).href);
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`ERROR  unexpected: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
