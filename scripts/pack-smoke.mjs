// Install a packed @chartrunner/verify tarball into a throwaway project and use it the way a user would: the
// `chartrunner-verify` bin and the offline example, resolved from node_modules (not from this workspace).
//
//   cd packages/verify && npm pack --pack-destination <dir>
//   node scripts/pack-smoke.mjs <dir>/chartrunner-verify-<version>.tgz
//
// CI runs this on the minimum Node version in engines and on Node 24. Exit 0 only when every check passes.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = process.argv[2];
if (!tarball) {
  console.error("usage: node scripts/pack-smoke.mjs <path to the packed .tgz>");
  process.exit(2);
}

const repo = new URL("../", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "cr-verify-pack-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pack-smoke", private: true, type: "module" }));
// The package has no dependencies and no install scripts; nothing else is fetched.
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(tarball)], { cwd: dir, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(dir, "node_modules/@chartrunner/verify/package.json"), "utf8"));
const bin = join(dir, "node_modules/.bin/chartrunner-verify");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `\n${detail}`}`);
};

console.log(`node ${process.version}, @chartrunner/verify ${pkg.version}, engines ${pkg.engines?.node}`);
for (const f of ["LICENSE", "NOTICE", "dist/index.js", "dist/cli.js"]) {
  let present = true;
  try {
    readFileSync(join(dir, "node_modules/@chartrunner/verify", f));
  } catch {
    present = false;
  }
  check(`tarball contains ${f}`, present);
}

const help = spawnSync(bin, ["--help"], { encoding: "utf8" });
check("chartrunner-verify --help exits 0", help.status === 0 && help.stdout.includes("chartrunner-verify"), help.stderr);

// The offline example, run from the temp project so `@chartrunner/verify` resolves to the installed tarball.
copyFileSync(new URL("examples/verify-offline.mjs", repo), join(dir, "verify-offline.mjs"));
copyFileSync(new URL("examples/results.json", repo), join(dir, "results.json"));
const example = spawnSync(process.execPath, [join(dir, "verify-offline.mjs")], { cwd: dir, encoding: "utf8" });
check("examples/verify-offline.mjs passes against the installed package", example.status === 0, example.stdout + example.stderr);

const memo = /const MEMO = "([^"]+)"/.exec(readFileSync(new URL("examples/verify-offline.mjs", repo), "utf8"))?.[1] ?? "";
const ok = spawnSync(bin, ["--rows", join(dir, "results.json"), "--memo", memo], { encoding: "utf8" });
check("CLI verifies the example results (exit 0)", ok.status === 0, ok.stdout + ok.stderr);
const wrong = spawnSync(bin, ["--rows", join(dir, "results.json"), "--memo", memo.replace(/:3$/, ":4")], { encoding: "utf8" });
check("CLI reports a mismatch (exit 1)", wrong.status === 1, wrong.stdout + wrong.stderr);

process.exitCode = failures === 0 ? 0 : 1;
