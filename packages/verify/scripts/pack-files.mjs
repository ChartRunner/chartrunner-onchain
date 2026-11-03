// Package-file housekeeping for @chartrunner/verify, cross-platform (no cp / rm in npm scripts).
//
//   node scripts/pack-files.mjs clean   remove dist/ (before a build)
//   node scripts/pack-files.mjs copy    copy LICENSE and NOTICE from the repository root into this package (prepack)
//   node scripts/pack-files.mjs check   fail unless LICENSE, NOTICE and a built dist/ are here (prepublishOnly)
//
// LICENSE and NOTICE are canonical at the repository root; the copies in this directory are gitignored.

import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";

const here = new URL("../", import.meta.url);
const root = new URL("../../", here);
const LEGAL = ["LICENSE", "NOTICE"];
const DIST = ["dist/index.js", "dist/index.d.ts", "dist/cli.js"];

function clean() {
  rmSync(new URL("dist", here), { recursive: true, force: true });
}

function copy() {
  for (const name of LEGAL) {
    const from = new URL(name, root);
    if (!existsSync(from)) throw new Error(`${name} is missing at the repository root`);
    copyFileSync(from, new URL(name, here));
  }
}

function check() {
  const problems = [];
  for (const name of LEGAL) {
    const file = new URL(name, here);
    if (!existsSync(file)) {
      problems.push(`${name} is missing from the package directory (run: node scripts/pack-files.mjs copy)`);
      continue;
    }
    const canonical = new URL(name, root);
    if (existsSync(canonical) && !readFileSync(file).equals(readFileSync(canonical))) problems.push(`${name} differs from the repository root copy`);
  }
  for (const name of DIST) if (!existsSync(new URL(name, here))) problems.push(`${name} is missing: build the package first (pnpm build)`);
  if (problems.length > 0) throw new Error(`not ready to publish:\n  - ${problems.join("\n  - ")}`);
}

const commands = { clean, copy, check };
const cmd = process.argv[2] ?? "";
try {
  if (!Object.hasOwn(commands, cmd)) throw new Error("usage: node scripts/pack-files.mjs clean | copy | check");
  commands[cmd]();
} catch (e) {
  console.error(`pack-files: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
